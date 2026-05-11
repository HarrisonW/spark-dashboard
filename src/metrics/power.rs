//! Wall-power monitoring via the UniFi Network controller.
//!
//! The dashboard polls the controller (not the PDU directly — Ubiquiti's
//! USP-PDU-Pro has no usable REST surface) and reads the per-outlet draw
//! reported under `outlet_table` for the outlet whose user-supplied name
//! (configured in the UniFi UI under the PDU's "Outlets" tab) matches
//! `SPARK_DASHBOARD_UNIFI_OUTLET_LABEL` (default `Spark`).
//!
//! Authentication uses a local UniFi Network API key sent via the
//! `X-API-KEY` header. Enable the integration by setting
//! `SPARK_DASHBOARD_UNIFI_HOST` and `SPARK_DASHBOARD_UNIFI_API_KEY`; the
//! collector is otherwise inert and `MetricsSnapshot.power.status` stays
//! `disabled` so the frontend renders the existing GPU-only Power tile.

use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

pub type SharedPowerState = Arc<RwLock<PowerState>>;

const REQ_TIMEOUT_SECS: u64 = 5;
// The PDU's outlet metrics refresh on the controller's device check-in
// cadence (~45-55 s in practice on a USP-PDU-Pro). Polling at 2 s is still
// fast enough to catch the new value within a frame of when the controller
// publishes it, without hammering the controller for unchanged data.
const DEFAULT_POLL_INTERVAL_MS: u64 = 2000;
const DEFAULT_SITE: &str = "default";
const DEFAULT_OUTLET_LABEL: &str = "Spark";

#[derive(Clone, Copy, Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PowerStatus {
    /// No UniFi integration configured — frontend keeps the legacy GPU-only Power tile.
    #[default]
    Disabled,
    Connecting,
    Connected,
    Error,
}

#[derive(Clone, Serialize, Debug, Default)]
pub struct PowerState {
    pub status: PowerStatus,
    /// Instantaneous outlet draw in watts.
    pub wall_watts: Option<f64>,
    pub voltage: Option<f64>,
    pub current_amps: Option<f64>,
    pub power_factor: Option<f64>,
    pub pdu_name: Option<String>,
    pub outlet_label: Option<String>,
    /// Controller-reported epoch (ms) at which the PDU last checked in.
    /// The chart anchors each wall-power step at this timestamp so the
    /// line moves only when the controller actually refreshed the reading.
    pub last_seen_ms: Option<i64>,
    /// Last error message when `status == Error`; surfaced for diagnostics.
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PduConfig {
    pub base_url: String,
    pub api_key: String,
    pub site: String,
    pub outlet_label: String,
    pub insecure: bool,
    pub poll_interval_ms: u64,
}

impl PduConfig {
    /// Returns `None` when the integration is not configured.
    pub fn from_env() -> Option<Self> {
        let host = std::env::var("SPARK_DASHBOARD_UNIFI_HOST").ok()?;
        let api_key = std::env::var("SPARK_DASHBOARD_UNIFI_API_KEY").ok()?;
        let host = host.trim().trim_end_matches('/').to_string();
        let base_url = if host.starts_with("http://") || host.starts_with("https://") {
            host
        } else {
            format!("https://{}", host)
        };
        let site = std::env::var("SPARK_DASHBOARD_UNIFI_SITE")
            .unwrap_or_else(|_| DEFAULT_SITE.to_string());
        let outlet_label = std::env::var("SPARK_DASHBOARD_UNIFI_OUTLET_LABEL")
            .unwrap_or_else(|_| DEFAULT_OUTLET_LABEL.to_string());
        // UDM/UDR ship a self-signed cert by default. Trust it unless the
        // operator opts in to strict validation.
        let insecure = std::env::var("SPARK_DASHBOARD_UNIFI_INSECURE")
            .map(|v| !matches!(v.trim().to_lowercase().as_str(), "false" | "0" | "no" | ""))
            .unwrap_or(true);
        let poll_interval_ms = std::env::var("SPARK_DASHBOARD_UNIFI_POLL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|ms: &u64| *ms >= 250)
            .unwrap_or(DEFAULT_POLL_INTERVAL_MS);
        Some(Self {
            base_url,
            api_key,
            site,
            outlet_label,
            insecure,
            poll_interval_ms,
        })
    }
}

pub fn spawn_collector(state: SharedPowerState, cfg: PduConfig) {
    tokio::spawn(poll_loop(state, cfg));
}

async fn poll_loop(state: SharedPowerState, cfg: PduConfig) {
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(cfg.insecure)
        .timeout(Duration::from_secs(REQ_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("unifi-pdu: failed to build HTTP client: {}", e);
            return;
        }
    };

    let url = format!(
        "{}/proxy/network/api/s/{}/stat/device",
        cfg.base_url, cfg.site
    );

    tracing::info!(
        url = %url,
        outlet_label = %cfg.outlet_label,
        poll_ms = cfg.poll_interval_ms,
        "unifi-pdu collector enabled"
    );

    {
        let mut s = state.write().await;
        s.status = PowerStatus::Connecting;
        s.outlet_label = Some(cfg.outlet_label.clone());
    }

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.poll_interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        match poll_once(&client, &url, &cfg).await {
            Ok(new_state) => {
                let mut s = state.write().await;
                *s = new_state;
            }
            Err(err) => {
                tracing::debug!("unifi-pdu poll error: {}", err);
                let mut s = state.write().await;
                s.status = PowerStatus::Error;
                s.error = Some(err);
                s.wall_watts = None;
                s.voltage = None;
                s.current_amps = None;
                s.power_factor = None;
                s.last_seen_ms = None;
            }
        }
    }
}

async fn poll_once(
    client: &reqwest::Client,
    url: &str,
    cfg: &PduConfig,
) -> Result<PowerState, String> {
    let resp = client
        .get(url)
        .header("X-API-KEY", &cfg.api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("controller returned HTTP {}", status));
    }

    let body = resp.text().await.map_err(|e| format!("read body: {}", e))?;
    parse_device_list(&body, &cfg.outlet_label)
}

fn parse_device_list(body: &str, outlet_label: &str) -> Result<PowerState, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("parse JSON: {}", e))?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "missing data[] in response".to_string())?;

    for dev in arr {
        if let Some(state) = extract_outlet_for_device(dev, outlet_label) {
            return Ok(state);
        }
    }

    Err(format!(
        "no outlet labeled \"{}\" found across {} device(s)",
        outlet_label,
        arr.len()
    ))
}

fn extract_outlet_for_device(dev: &serde_json::Value, label: &str) -> Option<PowerState> {
    let outlets = dev.get("outlet_table")?.as_array()?;
    let overrides = dev
        .get("outlet_overrides")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let matching_idx = overrides.iter().find_map(|ov| {
        let name = ov.get("name").and_then(|n| n.as_str())?;
        if name.trim().eq_ignore_ascii_case(label.trim()) {
            ov.get("index").and_then(|i| i.as_u64())
        } else {
            None
        }
    })?;

    let outlet = outlets
        .iter()
        .find(|o| o.get("index").and_then(|i| i.as_u64()) == Some(matching_idx))?;

    let pdu_name = dev
        .get("name")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string());

    // Controller reports `last_seen` as Unix-epoch seconds. Promote to ms
    // so the frontend can use it as a chart x-coordinate directly.
    let last_seen_ms = dev
        .get("last_seen")
        .and_then(|v| v.as_i64())
        .map(|secs| secs * 1000);

    Some(PowerState {
        status: PowerStatus::Connected,
        wall_watts: as_optional_f64(outlet.get("outlet_power")),
        voltage: as_optional_f64(outlet.get("outlet_voltage")),
        current_amps: as_optional_f64(outlet.get("outlet_current")),
        power_factor: as_optional_f64(outlet.get("outlet_power_factor")),
        pdu_name,
        outlet_label: Some(label.to_string()),
        last_seen_ms,
        error: None,
    })
}

/// UniFi firmware reports outlet metrics as either a number, a string
/// (`"12.34"`), or occasionally a unit-suffixed string (`"12.34 W"`).
fn as_optional_f64(v: Option<&serde_json::Value>) -> Option<f64> {
    let v = v?;
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    if let Some(s) = v.as_str() {
        let trimmed = s
            .trim()
            .trim_end_matches(|c: char| c.is_alphabetic() || c == '%')
            .trim();
        return trimmed.parse::<f64>().ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_outlet_power_for_matching_label() {
        let body = r#"{
          "data": [
            {
              "name": "Rack PDU",
              "last_seen": 1778480706,
              "outlet_overrides": [
                { "index": 1, "name": "router" },
                { "index": 3, "name": "Spark" }
              ],
              "outlet_table": [
                { "index": 1, "outlet_power": "5.10", "outlet_voltage": "118.5" },
                { "index": 3, "outlet_power": 342.7, "outlet_voltage": 118.5, "outlet_current": 2.90, "outlet_power_factor": 0.99 }
              ]
            }
          ]
        }"#;
        let s = parse_device_list(body, "Spark").unwrap();
        assert_eq!(s.status, PowerStatus::Connected);
        assert_eq!(s.pdu_name.as_deref(), Some("Rack PDU"));
        assert_eq!(s.outlet_label.as_deref(), Some("Spark"));
        assert!((s.wall_watts.unwrap() - 342.7).abs() < 1e-6);
        assert_eq!(s.voltage, Some(118.5));
        assert_eq!(s.current_amps, Some(2.9));
        assert_eq!(s.power_factor, Some(0.99));
        assert_eq!(s.last_seen_ms, Some(1_778_480_706_000));
    }

    #[test]
    fn last_seen_ms_is_none_when_field_missing() {
        let body = r#"{ "data": [{
            "outlet_overrides": [{ "index": 1, "name": "Spark" }],
            "outlet_table": [{ "index": 1, "outlet_power": 1.0 }] }]}"#;
        let s = parse_device_list(body, "Spark").unwrap();
        assert_eq!(s.last_seen_ms, None);
    }

    #[test]
    fn matches_case_and_whitespace_insensitively() {
        let body = r#"{ "data": [{
            "outlet_overrides": [{ "index": 2, "name": " SPARK " }],
            "outlet_table": [{ "index": 2, "outlet_power": 100.0 }] }]}"#;
        let s = parse_device_list(body, "spark").unwrap();
        assert_eq!(s.wall_watts, Some(100.0));
    }

    #[test]
    fn errors_when_label_not_found() {
        let body = r#"{ "data": [{
            "outlet_overrides": [{ "index": 1, "name": "other" }],
            "outlet_table": [{ "index": 1, "outlet_power": 1.0 }] }]}"#;
        let err = parse_device_list(body, "Spark").unwrap_err();
        assert!(err.contains("no outlet labeled"));
    }

    #[test]
    fn parses_string_form_with_unit_suffix() {
        let body = r#"{ "data": [{
            "outlet_overrides": [{ "index": 1, "name": "Spark" }],
            "outlet_table": [{ "index": 1, "outlet_power": "342.7 W" }] }]}"#;
        let s = parse_device_list(body, "Spark").unwrap();
        assert!((s.wall_watts.unwrap() - 342.7).abs() < 1e-6);
    }

    #[test]
    fn skips_devices_without_outlet_table() {
        let body = r#"{ "data": [
          { "name": "AP" },
          { "name": "PDU",
            "outlet_overrides": [{ "index": 5, "name": "Spark" }],
            "outlet_table": [{ "index": 5, "outlet_power": 42.0 }] }
        ]}"#;
        let s = parse_device_list(body, "Spark").unwrap();
        assert_eq!(s.wall_watts, Some(42.0));
        assert_eq!(s.pdu_name.as_deref(), Some("PDU"));
    }

    #[test]
    fn missing_outlet_metrics_yield_none() {
        let body = r#"{ "data": [{
            "outlet_overrides": [{ "index": 1, "name": "Spark" }],
            "outlet_table": [{ "index": 1 }] }]}"#;
        let s = parse_device_list(body, "Spark").unwrap();
        assert_eq!(s.wall_watts, None);
        assert_eq!(s.voltage, None);
    }

    #[test]
    fn errors_on_missing_data_array() {
        let err = parse_device_list("{}", "Spark").unwrap_err();
        assert!(err.contains("missing data"));
    }
}
