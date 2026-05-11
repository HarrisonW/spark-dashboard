/** ComfyUI integration types — mirror of `src/comfyui.rs` on the server.
 *
 *  All ComfyUI traffic lives in the dashboard process; the browser only
 *  receives the consolidated `ComfyUIState` riding inside the existing
 *  metrics snapshot, so there are no wire-format types here. */

export type ComfyUIConnectionStatus = 'connecting' | 'connected' | 'disconnected'

/** Summary of a single prompt sitting in the queue (running or pending). */
export interface ComfyPromptInfo {
  /** ComfyUI's monotonic queue index — also displayed as the job number. */
  number: number
  /** UUID assigned by ComfyUI to the prompt. */
  promptId: string
  /** Number of nodes in the prompt graph (a rough "workflow size" signal). */
  nodeCount: number
  /** Output nodes ComfyUI was asked to execute for this prompt. */
  outputNodeCount: number
  /** Headline node classes (e.g. KSampler, CheckpointLoaderSimple) used to
   *  identify the workflow at a glance. Capped to 3 entries. */
  primaryNodeTypes: string[]
  /** Checkpoint name from a `CheckpointLoaderSimple` / `UNETLoader`. */
  modelName: string | null
  /** Wall-clock ms when the dashboard first saw the prompt. */
  queuedAtMs: number
  /** Wall-clock ms when the dashboard first saw the prompt as running.
   *  `null` while it's still in pending. */
  startedAtMs: number | null
}

export interface ComfyHistoryEntry {
  promptId: string
  number: number
  status: 'success' | 'error' | 'unknown'
  completed: boolean
  /** Total image outputs across all output nodes — useful as a job-size signal. */
  outputImageCount: number
  nodeCount: number
  /** Wall-clock ms when the dashboard first observed this entry in /history. */
  completedAtMs: number
}

/** Live progress for the currently-running prompt.
 *
 *  Two scales are exposed: `value`/`max` is the inner node's progress
 *  (e.g. KSampler steps), while `executedNodes`/`totalNodes` is the
 *  workflow-level progress. The UI combines them as
 *  `(executedNodes + value/max) / totalNodes` for the headline bar. */
export interface ComfyProgress {
  promptId: string
  /** Node id currently executing (matches a key in the prompt graph). */
  nodeId: string | null
  /** Step index within the current node (e.g. KSampler step). */
  value: number
  /** Max steps for the current node. */
  max: number
  /** Distinct nodes that have started executing so far. */
  executedNodes: number
  /** Total nodes in the workflow. */
  totalNodes: number
}

export interface ComfyUIState {
  connectionStatus: ComfyUIConnectionStatus
  /** Last network / parse error, surfaced in the disconnected state. */
  error: string | null
  /** queue_running.length + queue_pending.length — what ComfyUI calls the queue depth. */
  queueRemaining: number
  running: ComfyPromptInfo[]
  pending: ComfyPromptInfo[]
  history: ComfyHistoryEntry[]
  totalCompleted: number
  totalErrors: number
  progress: ComfyProgress | null
  /** Host:port the server is talking to — surfaced in the disconnected banner. */
  upstreamHost: string
}

export const EMPTY_COMFY_STATE: ComfyUIState = {
  connectionStatus: 'connecting',
  error: null,
  queueRemaining: 0,
  running: [],
  pending: [],
  history: [],
  totalCompleted: 0,
  totalErrors: 0,
  progress: null,
  upstreamHost: 'localhost:8188',
}
