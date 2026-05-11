//! ComfyUI integration.
//!
//! The dashboard server keeps a long-running connection to a local ComfyUI
//! instance (default `http://localhost:8188`, overridable via
//! `SPARK_DASHBOARD_COMFYUI_URL`) so the browser sees a single consolidated
//! state through the existing `/ws` metrics channel. Keeping the upstream
//! call server-side has two benefits: it sidesteps the same-origin policy
//! (no need to launch ComfyUI with `--enable-cors-header`), and it removes
//! the second WebSocket from each browser tab.
//!
//! Two cooperating tasks run per process:
//!
//! * an HTTP poller that hits `/queue` and `/history?max_items=...` on a
//!   fixed cadence and refreshes `running`, `pending`, and `history`.
//! * a WebSocket client that subscribes to ComfyUI's `/ws` event stream
//!   and updates live per-node `progress`. It also tracks which nodes
//!   have already executed so the frontend can render a workflow-level
//!   percentage instead of just the current node's step counter.
//!
//! Both write into the same `Arc<RwLock<ComfyUIState>>`, which the metrics
//! collector reads when assembling each snapshot.

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message as TMsg;

const DEFAULT_COMFY_URL: &str = "http://localhost:8188";
const POLL_INTERVAL_SECS: u64 = 2;
const HISTORY_MAX: usize = 50;
const WS_RECONNECT_SECS: u64 = 3;
const REQ_TIMEOUT_SECS: u64 = 4;
/// Drop tracked timestamps for prompts we haven't seen anywhere for a while.
/// ComfyUI's history shrinks (FIFO ~ a few hundred entries) so anything that
/// has been gone from running/pending/history beyond this window won't come
/// back and we can free its bookkeeping.
const TIMESTAMP_GC_MS: u64 = 30 * 60 * 1000; // 30 min

pub type SharedComfyState = Arc<RwLock<ComfyUIState>>;

#[derive(Clone, Copy, Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    #[default]
    Connecting,
    Connected,
    Disconnected,
}

/// Mirrors `frontend/src/types/comfyui.ts`. Fields are serialized as
/// camelCase to match the rest of ComfyUI's vocabulary on the frontend.
#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUIState {
    pub connection_status: ConnectionStatus,
    pub error: Option<String>,
    pub queue_remaining: u32,
    pub running: Vec<ComfyPromptInfo>,
    pub pending: Vec<ComfyPromptInfo>,
    pub history: Vec<ComfyHistoryEntry>,
    pub total_completed: u32,
    pub total_errors: u32,
    pub progress: Option<ComfyProgress>,
    /// Host:port portion of the upstream — surfaced so the disconnected
    /// banner can show the operator which endpoint it tried.
    pub upstream_host: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComfyPromptInfo {
    pub number: u64,
    pub prompt_id: String,
    pub node_count: u32,
    pub output_node_count: u32,
    pub primary_node_types: Vec<String>,
    pub model_name: Option<String>,
    /// First time the dashboard observed this prompt in pending/running, in
    /// wall-clock milliseconds since epoch. ComfyUI doesn't expose a queued
    /// timestamp so we record one ourselves.
    pub queued_at_ms: u64,
    /// First time the dashboard observed this prompt as running. `None`
    /// while it's still in pending.
    pub started_at_ms: Option<u64>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComfyHistoryEntry {
    pub prompt_id: String,
    pub number: u64,
    pub status: String,
    pub completed: bool,
    pub output_image_count: u32,
    pub node_count: u32,
    /// First time the dashboard observed this prompt in /history. Acts as a
    /// "completed at" proxy since ComfyUI doesn't report a finish time.
    pub completed_at_ms: u64,
}

/// Live progress for whatever prompt is currently running.
///
/// Two scales are exposed: `value`/`max` is the inner node's progress
/// (e.g. KSampler steps), while `executed_nodes`/`total_nodes` is the
/// workflow-level progress (how many nodes have finished out of the
/// total). The frontend combines them as
/// `(executed_nodes + value/max) / total_nodes`.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComfyProgress {
    pub prompt_id: String,
    pub node_id: Option<String>,
    pub value: u32,
    pub max: u32,
    pub executed_nodes: u32,
    pub total_nodes: u32,
}

/// Internal scratch state held by the collector tasks. Not serialized.
#[derive(Default)]
struct Inner {
    first_seen_pending: HashMap<String, u64>,
    first_seen_running: HashMap<String, u64>,
    first_seen_history: HashMap<String, u64>,
    /// Distinct node ids that have entered "executing" for a given prompt —
    /// the count is the workflow's progress in nodes.
    executed_nodes: HashMap<String, HashSet<String>>,
    /// The currently-executing node for a prompt — used to recognise the
    /// transition to a new node and bump `executed_nodes`.
    current_node: HashMap<String, String>,
    /// Most recent raw progress event from the WS, if any.
    progress: Option<RawProgress>,
}

#[derive(Clone, Debug)]
struct RawProgress {
    prompt_id: String,
    node_id: Option<String>,
    value: u32,
    max: u32,
}

/// Resolve the upstream ComfyUI base URL. Reading the env var lazily keeps
/// tests hermetic and lets operators flip the upstream without a restart.
fn comfy_http_base() -> String {
    std::env::var("SPARK_DASHBOARD_COMFYUI_URL")
        .unwrap_or_else(|_| DEFAULT_COMFY_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn comfy_ws_url(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{}/ws?clientId=spark-dashboard", rest)
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{}/ws?clientId=spark-dashboard", rest)
    } else {
        format!("{}/ws?clientId=spark-dashboard", base)
    }
}

/// Show "host:port" (or "host") for the disconnected banner — the scheme
/// adds noise on a value the user already knows is HTTP.
fn upstream_host(base: &str) -> String {
    let stripped = base
        .strip_prefix("https://")
        .or_else(|| base.strip_prefix("http://"))
        .unwrap_or(base);
    stripped.trim_end_matches('/').to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Spawn the HTTP poller and WS listener; both write into the shared
/// state. Returns immediately. The caller keeps a clone of the state to
/// read from.
pub fn spawn_collector(state: SharedComfyState) {
    let inner = Arc::new(RwLock::new(Inner::default()));

    tokio::spawn(http_loop(state.clone(), inner.clone()));
    tokio::spawn(ws_loop(state.clone(), inner));
}

async fn http_loop(state: SharedComfyState, inner: Arc<RwLock<Inner>>) {
    let mut interval = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(REQ_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("comfyui: failed to build HTTP client: {}", e);
            return;
        }
    };

    loop {
        interval.tick().await;

        let base = comfy_http_base();
        let host = upstream_host(&base);

        let queue_res = client.get(format!("{}/queue", base)).send().await;
        let history_res = client
            .get(format!("{}/history?max_items={}", base, HISTORY_MAX))
            .send()
            .await;

        let (queue_json, history_json) = match (queue_res, history_res) {
            (Ok(q), Ok(h)) if q.status().is_success() && h.status().is_success() => {
                let q_body = q.json::<serde_json::Value>().await;
                let h_body = h.json::<serde_json::Value>().await;
                match (q_body, h_body) {
                    (Ok(q), Ok(h)) => (q, h),
                    (q, h) => {
                        let err = format!("ComfyUI parse error: queue={:?} history={:?}", q, h);
                        mark_disconnected(&state, &host, err).await;
                        continue;
                    }
                }
            }
            (q, h) => {
                let err = match (&q, &h) {
                    (Err(e), _) => format!("queue: {}", e),
                    (_, Err(e)) => format!("history: {}", e),
                    (Ok(q), Ok(h)) => {
                        format!(
                            "HTTP {} on queue / HTTP {} on history",
                            q.status(),
                            h.status()
                        )
                    }
                };
                mark_disconnected(&state, &host, err).await;
                continue;
            }
        };

        let now = now_ms();
        let mut scratch = inner.write().await;

        let running = extract_prompts(&queue_json, "queue_running");
        let pending = extract_prompts(&queue_json, "queue_pending");

        // Refresh first-seen timestamps for everything we currently see, so
        // the queued/started clocks survive across polls.
        for item in &running {
            scratch
                .first_seen_pending
                .entry(item.prompt_id.clone())
                .or_insert(now);
            scratch
                .first_seen_running
                .entry(item.prompt_id.clone())
                .or_insert(now);
        }
        for item in &pending {
            scratch
                .first_seen_pending
                .entry(item.prompt_id.clone())
                .or_insert(now);
        }

        // History: only the most recent HISTORY_MAX entries.
        let history_entries = parse_history(&history_json, now, &mut scratch.first_seen_history);

        // Garbage-collect stale prompt timestamps so the maps don't grow
        // unbounded. Anything not present in running/pending/history and
        // older than TIMESTAMP_GC_MS is dropped.
        let live_ids: HashSet<String> = running
            .iter()
            .map(|p| p.prompt_id.clone())
            .chain(pending.iter().map(|p| p.prompt_id.clone()))
            .chain(history_entries.iter().map(|h| h.prompt_id.clone()))
            .collect();
        let cutoff = now.saturating_sub(TIMESTAMP_GC_MS);
        gc_timestamps(&mut scratch.first_seen_pending, &live_ids, cutoff);
        gc_timestamps(&mut scratch.first_seen_running, &live_ids, cutoff);
        gc_timestamps(&mut scratch.first_seen_history, &live_ids, cutoff);
        scratch.executed_nodes.retain(|k, _| live_ids.contains(k));
        scratch.current_node.retain(|k, _| live_ids.contains(k));

        let running_with_ts: Vec<ComfyPromptInfo> = running
            .into_iter()
            .map(|mut p| {
                p.queued_at_ms = *scratch.first_seen_pending.get(&p.prompt_id).unwrap_or(&now);
                p.started_at_ms = scratch.first_seen_running.get(&p.prompt_id).copied();
                p
            })
            .collect();
        let pending_with_ts: Vec<ComfyPromptInfo> = pending
            .into_iter()
            .map(|mut p| {
                p.queued_at_ms = *scratch.first_seen_pending.get(&p.prompt_id).unwrap_or(&now);
                p.started_at_ms = None;
                p
            })
            .collect();

        let total_completed = history_entries
            .iter()
            .filter(|e| e.status == "success")
            .count() as u32;
        let total_errors = history_entries
            .iter()
            .filter(|e| e.status == "error")
            .count() as u32;
        let queue_remaining = (running_with_ts.len() + pending_with_ts.len()) as u32;

        // Resolve workflow-level progress from the latest WS event using the
        // running prompt's node count. If the prompt isn't running anymore,
        // drop it.
        let progress = scratch.progress.clone().and_then(|p| {
            let running_match = running_with_ts
                .iter()
                .find(|r| r.prompt_id == p.prompt_id)?;
            let executed = scratch
                .executed_nodes
                .get(&p.prompt_id)
                .map(|s| s.len() as u32)
                .unwrap_or(0);
            Some(ComfyProgress {
                prompt_id: p.prompt_id,
                node_id: p.node_id,
                value: p.value,
                max: p.max,
                executed_nodes: executed,
                total_nodes: running_match.node_count,
            })
        });
        if progress.is_none() {
            scratch.progress = None;
        }

        drop(scratch);

        let mut s = state.write().await;
        s.connection_status = ConnectionStatus::Connected;
        s.error = None;
        s.queue_remaining = queue_remaining;
        s.running = running_with_ts;
        s.pending = pending_with_ts;
        s.history = history_entries;
        s.total_completed = total_completed;
        s.total_errors = total_errors;
        s.progress = progress;
        s.upstream_host = host;
    }
}

async fn mark_disconnected(state: &SharedComfyState, host: &str, err: String) {
    let mut s = state.write().await;
    s.connection_status = ConnectionStatus::Disconnected;
    s.error = Some(err);
    s.progress = None;
    s.upstream_host = host.to_string();
}

fn gc_timestamps(map: &mut HashMap<String, u64>, live: &HashSet<String>, cutoff: u64) {
    map.retain(|k, ts| live.contains(k) || *ts >= cutoff);
}

async fn ws_loop(_state: SharedComfyState, inner: Arc<RwLock<Inner>>) {
    loop {
        let url = comfy_ws_url(&comfy_http_base());
        match tokio_tungstenite::connect_async(&url).await {
            Ok((stream, _)) => {
                let (_w, mut r) = stream.split();
                // tungstenite handles automatic pongs internally so we just
                // read text events until the upstream closes.
                while let Some(msg) = r.next().await {
                    match msg {
                        Ok(TMsg::Text(text)) => {
                            handle_ws_text(&inner, text.as_str()).await;
                        }
                        Ok(TMsg::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            }
            Err(e) => {
                tracing::debug!("comfyui ws connect failed ({}): {}", url, e);
                // HTTP loop is the source of truth for connection_status;
                // don't flip it here just because the WS is down.
            }
        }
        tokio::time::sleep(Duration::from_secs(WS_RECONNECT_SECS)).await;
    }
}

async fn handle_ws_text(inner: &Arc<RwLock<Inner>>, text: &str) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let data = val.get("data").cloned().unwrap_or(serde_json::Value::Null);

    match ty {
        "progress" => {
            // ComfyUI sends both snake_case (`prompt_id`, `node`) and, on
            // newer builds, camelCase (`promptId`, `nodeId`). Accept either.
            let prompt_id = data
                .get("prompt_id")
                .or_else(|| data.get("promptId"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let node_id = data
                .get("node")
                .or_else(|| data.get("nodeId"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let value = data.get("value").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let max = data.get("max").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if let Some(prompt_id) = prompt_id {
                let mut g = inner.write().await;
                g.progress = Some(RawProgress {
                    prompt_id,
                    node_id,
                    value,
                    max,
                });
            }
        }
        "executing" => {
            let prompt_id = data
                .get("prompt_id")
                .or_else(|| data.get("promptId"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let node_id = data
                .get("node")
                .or_else(|| data.get("nodeId"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let Some(prompt_id) = prompt_id else { return };
            let mut g = inner.write().await;
            match node_id {
                None => {
                    // Prompt finished — drop progress and node tracking for it.
                    if g.progress.as_ref().map(|p| &p.prompt_id) == Some(&prompt_id) {
                        g.progress = None;
                    }
                    g.executed_nodes.remove(&prompt_id);
                    g.current_node.remove(&prompt_id);
                }
                Some(node) => {
                    // Treat each distinct executing node as an "executed"
                    // step (ComfyUI emits `executing` once per node as it
                    // starts).
                    g.current_node.insert(prompt_id.clone(), node.clone());
                    g.executed_nodes.entry(prompt_id).or_default().insert(node);
                }
            }
        }
        "execution_cached" => {
            // ComfyUI bypasses cached nodes; treat them as executed so the
            // workflow progress matches reality. Payload: { nodes: [..], prompt_id }
            let prompt_id = data
                .get("prompt_id")
                .or_else(|| data.get("promptId"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let nodes = data
                .get("nodes")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if let Some(prompt_id) = prompt_id {
                let mut g = inner.write().await;
                let bucket = g.executed_nodes.entry(prompt_id).or_default();
                for n in nodes {
                    if let Some(s) = n.as_str() {
                        bucket.insert(s.to_string());
                    }
                }
            }
        }
        _ => {}
    }
}

// --- Parsing helpers (pure — exported for tests) -----------------------------

/// Extract a `[number, prompt_id, graph, extra, outputs]` array from a
/// ComfyUI queue response field.
pub fn extract_prompts(queue_json: &serde_json::Value, key: &str) -> Vec<ComfyPromptInfo> {
    let Some(arr) = queue_json.get(key).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter().filter_map(parse_prompt_tuple).collect()
}

fn parse_prompt_tuple(item: &serde_json::Value) -> Option<ComfyPromptInfo> {
    let arr = item.as_array()?;
    let number = arr.first()?.as_u64()?;
    let prompt_id = arr.get(1)?.as_str()?.to_string();
    let graph = arr.get(2).and_then(|v| v.as_object());
    let outputs_to_execute = arr.get(4).and_then(|v| v.as_array());

    let (node_count, primary_node_types, model_name) = match graph {
        Some(g) => analyse_graph(g),
        None => (0, Vec::new(), None),
    };

    Some(ComfyPromptInfo {
        number,
        prompt_id,
        node_count,
        output_node_count: outputs_to_execute.map(|a| a.len() as u32).unwrap_or(0),
        primary_node_types,
        model_name,
        queued_at_ms: 0,
        started_at_ms: None,
    })
}

/// Walk a prompt graph and pull a few headline signals: node count,
/// top-3 class types by frequency, and (for the common case) the
/// checkpoint name from a `CheckpointLoaderSimple`/`UNETLoader`.
fn analyse_graph(
    graph: &serde_json::Map<String, serde_json::Value>,
) -> (u32, Vec<String>, Option<String>) {
    let mut class_counts: HashMap<String, u32> = HashMap::new();
    let mut model_name: Option<String> = None;

    for node in graph.values() {
        let Some(obj) = node.as_object() else {
            continue;
        };
        let Some(cls) = obj.get("class_type").and_then(|v| v.as_str()) else {
            continue;
        };
        *class_counts.entry(cls.to_string()).or_default() += 1;

        if model_name.is_none()
            && matches!(
                cls,
                "CheckpointLoaderSimple" | "CheckpointLoader" | "UNETLoader"
            )
        {
            if let Some(inputs) = obj.get("inputs").and_then(|v| v.as_object()) {
                let ckpt = inputs.get("ckpt_name").and_then(|v| v.as_str());
                let unet = inputs.get("unet_name").and_then(|v| v.as_str());
                model_name = ckpt.or(unet).map(String::from);
            }
        }
    }

    let mut entries: Vec<(String, u32)> = class_counts.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let primary_node_types = entries
        .into_iter()
        .take(3)
        .map(|(cls, _)| cls)
        .collect::<Vec<_>>();

    (graph.len() as u32, primary_node_types, model_name)
}

/// Parse the `/history` map into our flat entry shape, sorted newest-first.
pub fn parse_history(
    history_json: &serde_json::Value,
    now: u64,
    first_seen: &mut HashMap<String, u64>,
) -> Vec<ComfyHistoryEntry> {
    let Some(map) = history_json.as_object() else {
        return Vec::new();
    };
    let mut entries: Vec<ComfyHistoryEntry> = map
        .iter()
        .filter_map(|(prompt_id, entry)| parse_history_entry(prompt_id, entry, now, first_seen))
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.number));
    entries.truncate(HISTORY_MAX);
    entries
}

fn parse_history_entry(
    prompt_id: &str,
    entry: &serde_json::Value,
    now: u64,
    first_seen: &mut HashMap<String, u64>,
) -> Option<ComfyHistoryEntry> {
    let obj = entry.as_object()?;
    let prompt = obj.get("prompt").and_then(|v| v.as_array());
    let number = prompt
        .and_then(|a| a.first().and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let node_count = prompt
        .and_then(|a| a.get(2).and_then(|v| v.as_object().map(|o| o.len() as u32)))
        .unwrap_or(0);

    let mut output_image_count: u32 = 0;
    if let Some(outputs) = obj.get("outputs").and_then(|v| v.as_object()) {
        for out in outputs.values() {
            if let Some(images) = out.get("images").and_then(|v| v.as_array()) {
                output_image_count += images.len() as u32;
            }
        }
    }

    let status_obj = obj.get("status").and_then(|v| v.as_object());
    let status_str = status_obj
        .and_then(|s| s.get("status_str").and_then(|v| v.as_str()))
        .unwrap_or("");
    let completed = status_obj
        .and_then(|s| s.get("completed").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let status = match status_str {
        "success" => "success",
        "error" => "error",
        _ => "unknown",
    }
    .to_string();

    let completed_at_ms = *first_seen.entry(prompt_id.to_string()).or_insert(now);

    Some(ComfyHistoryEntry {
        prompt_id: prompt_id.to_string(),
        number,
        status,
        completed,
        output_image_count,
        node_count,
        completed_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_prompt_tuple_with_checkpoint_loader() {
        let item = json!([
            7,
            "abc-123",
            {
                "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sdxl.safetensors" } },
                "2": { "class_type": "KSampler", "inputs": { "steps": 20 } },
                "3": { "class_type": "KSampler", "inputs": { "steps": 10 } },
                "4": { "class_type": "CLIPTextEncode", "inputs": { "text": "a cat" } }
            },
            {},
            ["9", "10"]
        ]);
        let info = parse_prompt_tuple(&item).expect("parsed");
        assert_eq!(info.number, 7);
        assert_eq!(info.prompt_id, "abc-123");
        assert_eq!(info.node_count, 4);
        assert_eq!(info.output_node_count, 2);
        assert_eq!(info.model_name.as_deref(), Some("sdxl.safetensors"));
        assert_eq!(
            info.primary_node_types.first().map(String::as_str),
            Some("KSampler")
        );
    }

    #[test]
    fn parses_prompt_tuple_with_unet_loader_fallback() {
        let item = json!([
            2,
            "p2",
            { "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "flux1.gguf" } } },
            {},
            []
        ]);
        let info = parse_prompt_tuple(&item).expect("parsed");
        assert_eq!(info.model_name.as_deref(), Some("flux1.gguf"));
    }

    #[test]
    fn caps_primary_node_types_at_three() {
        let item = json!([
            0,
            "p",
            {
                "1": { "class_type": "A", "inputs": {} },
                "2": { "class_type": "B", "inputs": {} },
                "3": { "class_type": "C", "inputs": {} },
                "4": { "class_type": "D", "inputs": {} },
                "5": { "class_type": "E", "inputs": {} }
            },
            {},
            []
        ]);
        let info = parse_prompt_tuple(&item).expect("parsed");
        assert_eq!(info.primary_node_types.len(), 3);
    }

    #[test]
    fn extract_prompts_handles_missing_field() {
        let queue = json!({ "queue_running": [], "queue_pending": [] });
        assert_eq!(extract_prompts(&queue, "queue_running").len(), 0);
        assert_eq!(extract_prompts(&queue, "queue_other").len(), 0);
    }

    #[test]
    fn parses_history_entry_with_outputs_and_status() {
        let map = json!({
            "hist-1": {
                "prompt": [3, "hist-1", { "1": { "class_type": "KSampler", "inputs": {} } }, {}, ["9"]],
                "outputs": {
                    "9": { "images": [
                        { "filename": "a.png", "type": "output" },
                        { "filename": "b.png", "type": "output" }
                    ] }
                },
                "status": { "status_str": "success", "completed": true }
            }
        });
        let mut first_seen = HashMap::new();
        let entries = parse_history(&map, 1_000, &mut first_seen);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.prompt_id, "hist-1");
        assert_eq!(e.number, 3);
        assert_eq!(e.status, "success");
        assert!(e.completed);
        assert_eq!(e.output_image_count, 2);
        assert_eq!(e.node_count, 1);
        assert_eq!(e.completed_at_ms, 1_000);
    }

    #[test]
    fn parse_history_remembers_first_seen_timestamp() {
        let map = json!({
            "hist-1": {
                "prompt": [1, "hist-1", {}, {}, []],
                "outputs": {},
                "status": { "status_str": "success", "completed": true }
            }
        });
        let mut first_seen = HashMap::new();
        let first = parse_history(&map, 1_000, &mut first_seen);
        let second = parse_history(&map, 9_999, &mut first_seen);
        assert_eq!(first[0].completed_at_ms, 1_000);
        // Second poll for the same prompt keeps the original timestamp.
        assert_eq!(second[0].completed_at_ms, 1_000);
    }

    #[test]
    fn parse_history_classifies_missing_status_as_unknown() {
        let map = json!({
            "hist-3": { "prompt": [5, "hist-3", {}, {}, []], "outputs": {} }
        });
        let mut first_seen = HashMap::new();
        let entries = parse_history(&map, 1, &mut first_seen);
        assert_eq!(entries[0].status, "unknown");
    }

    #[test]
    fn ws_url_converts_http_to_ws() {
        assert_eq!(
            comfy_ws_url("http://localhost:9999"),
            "ws://localhost:9999/ws?clientId=spark-dashboard"
        );
    }

    #[test]
    fn ws_url_converts_https_to_wss() {
        assert_eq!(
            comfy_ws_url("https://comfy.example.com"),
            "wss://comfy.example.com/ws?clientId=spark-dashboard"
        );
    }

    #[test]
    fn upstream_host_strips_scheme_and_trailing_slash() {
        assert_eq!(upstream_host("http://localhost:8188/"), "localhost:8188");
        assert_eq!(
            upstream_host("https://comfy.example.com"),
            "comfy.example.com"
        );
    }

    #[tokio::test]
    async fn ws_executing_with_null_node_clears_progress() {
        let inner = Arc::new(RwLock::new(Inner::default()));
        // First, a progress event so we have something to clear.
        handle_ws_text(
            &inner,
            r#"{"type":"progress","data":{"prompt_id":"p","node":"1","value":1,"max":10}}"#,
        )
        .await;
        assert!(inner.read().await.progress.is_some());
        // executing with node=null tears progress down.
        handle_ws_text(
            &inner,
            r#"{"type":"executing","data":{"prompt_id":"p","node":null}}"#,
        )
        .await;
        assert!(inner.read().await.progress.is_none());
    }

    #[tokio::test]
    async fn ws_executing_distinct_nodes_counts_as_executed() {
        let inner = Arc::new(RwLock::new(Inner::default()));
        handle_ws_text(
            &inner,
            r#"{"type":"executing","data":{"prompt_id":"p","node":"1"}}"#,
        )
        .await;
        handle_ws_text(
            &inner,
            r#"{"type":"executing","data":{"prompt_id":"p","node":"2"}}"#,
        )
        .await;
        handle_ws_text(
            &inner,
            r#"{"type":"executing","data":{"prompt_id":"p","node":"2"}}"#,
        )
        .await;
        let g = inner.read().await;
        assert_eq!(g.executed_nodes.get("p").map(|s| s.len()), Some(2));
    }

    #[tokio::test]
    async fn ws_execution_cached_pre_populates_executed_nodes() {
        let inner = Arc::new(RwLock::new(Inner::default()));
        handle_ws_text(
            &inner,
            r#"{"type":"execution_cached","data":{"prompt_id":"p","nodes":["1","2","3"]}}"#,
        )
        .await;
        let g = inner.read().await;
        assert_eq!(g.executed_nodes.get("p").map(|s| s.len()), Some(3));
    }
}
