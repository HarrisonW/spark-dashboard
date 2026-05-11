import { useEffect, useState } from 'react'
import type {
  ComfyHistoryEntry,
  ComfyProgress,
  ComfyPromptInfo,
  ComfyUIState,
} from '@/types/comfyui'

interface ComfyUICardProps {
  state: ComfyUIState
}

/** Truncate ComfyUI's UUID prompt ids for display while keeping them
 *  recognisable in the UI. */
function shortPromptId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** Format a wall-clock millisecond timestamp as a coarse "X ago" string.
 *  Exported so the test suite can pin behaviour. */
export function formatAgo(timestampMs: number, nowMs: number): string {
  const delta = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (delta < 5) return 'just now'
  if (delta < 60) return `${delta}s ago`
  const mins = Math.floor(delta / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/** Format an absolute time for the row tooltip. Locale-aware HH:MM:SS. */
function formatAbsolute(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString()
}

/** Workflow-level progress percentage combining whole-node completion with
 *  the current node's step counter (e.g. a KSampler at step 14/20 still
 *  counts as 14/20 of a node toward the overall total).
 *  Exported for tests. */
export function workflowPct(progress: ComfyProgress): number {
  if (progress.totalNodes <= 0) return 0
  const nodeFraction =
    progress.max > 0 ? Math.min(1, Math.max(0, progress.value / progress.max)) : 0
  const overall = (progress.executedNodes + nodeFraction) / progress.totalNodes
  return Math.min(100, Math.max(0, overall * 100))
}

function PanelHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5 min-w-0">
      <span className="text-[11px] 2xl:text-xs font-semibold text-zinc-300 tracking-tight truncate">
        {title}
      </span>
      {badge && (
        <span className="text-[10px] text-zinc-500 font-mono shrink-0">{badge}</span>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: 'connected' | 'connecting' | 'disconnected' }) {
  const color =
    status === 'connected'
      ? 'bg-[#76B900]'
      : status === 'connecting'
        ? 'bg-amber-400'
        : 'bg-zinc-600'
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 rounded-full ${color}`}
    />
  )
}

function ProgressBar({
  pct,
  label,
  indeterminate,
}: {
  pct: number
  label?: string
  /** Render an animated sliding stripe instead of a fixed-width fill —
   *  used while a prompt is running but no live `progress` event has
   *  arrived yet (or `totalNodes` is unknown). */
  indeterminate?: boolean
}) {
  return (
    <div
      className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden"
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      aria-busy={indeterminate ? true : undefined}
    >
      {indeterminate ? (
        <div className="h-full rounded-full bg-[#76B900]/70 comfy-indeterminate-bar" />
      ) : (
        <div
          className="h-full bg-[#76B900] transition-[width] duration-150 ease-linear"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  )
}

function PromptRow({
  prompt,
  running,
  nowMs,
}: {
  prompt: ComfyPromptInfo
  running?: boolean
  nowMs: number
}) {
  const subtitle =
    prompt.modelName ?? prompt.primaryNodeTypes.slice(0, 3).join(' · ') ?? `${prompt.nodeCount} nodes`
  const ageTs = running ? (prompt.startedAtMs ?? prompt.queuedAtMs) : prompt.queuedAtMs
  const ageLabel = running ? 'started' : 'queued'
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`text-[11px] font-mono tabular-nums shrink-0 ${
            running ? 'text-[#76B900]' : 'text-zinc-400'
          }`}
        >
          #{prompt.number}
        </span>
        <span className="text-[11px] text-zinc-100 font-medium truncate flex-1" title={subtitle}>
          {subtitle}
        </span>
        <span className="text-[10px] text-zinc-500 font-mono shrink-0 hidden sm:inline">
          {prompt.nodeCount}n
        </span>
        <span
          className="text-[10px] text-zinc-600 font-mono shrink-0"
          title={prompt.promptId}
        >
          {shortPromptId(prompt.promptId)}
        </span>
      </div>
      <div
        className="text-[10px] text-zinc-500 font-mono pl-5"
        title={`${ageLabel} at ${formatAbsolute(ageTs)}`}
      >
        {ageLabel} {formatAgo(ageTs, nowMs)}
      </div>
    </div>
  )
}

function HistoryRow({
  entry,
  nowMs,
}: {
  entry: ComfyHistoryEntry
  nowMs: number
}) {
  const icon = entry.status === 'success' ? '✓' : entry.status === 'error' ? '✗' : '·'
  const iconColor =
    entry.status === 'success'
      ? 'text-[#76B900]'
      : entry.status === 'error'
        ? 'text-red-400'
        : 'text-zinc-500'
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-[11px] font-bold shrink-0 ${iconColor}`}>{icon}</span>
        <span className="text-[11px] font-mono tabular-nums text-zinc-400 shrink-0">
          #{entry.number}
        </span>
        <span className="text-[11px] text-zinc-300 truncate flex-1">
          {entry.outputImageCount > 0
            ? `${entry.outputImageCount} output${entry.outputImageCount === 1 ? '' : 's'}`
            : entry.status === 'error'
              ? 'failed'
              : 'completed'}
        </span>
        <span
          className="text-[10px] text-zinc-600 font-mono shrink-0"
          title={entry.promptId}
        >
          {shortPromptId(entry.promptId)}
        </span>
      </div>
      <div
        className="text-[10px] text-zinc-500 font-mono pl-5"
        title={`finished at ${formatAbsolute(entry.completedAtMs)}`}
      >
        finished {formatAgo(entry.completedAtMs, nowMs)}
      </div>
    </div>
  )
}

/** Re-render every second so relative timestamps tick without depending on
 *  fresh metrics snapshots (the tab also receives a new snapshot ~every 1s,
 *  but a tiny ticker keeps "X ago" smooth if the stream stalls). */
function useNow(): number {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function ComfyUICard({ state }: ComfyUICardProps) {
  const {
    connectionStatus,
    error,
    queueRemaining,
    running,
    pending,
    history,
    totalCompleted,
    totalErrors,
    progress,
    upstreamHost,
  } = state
  const nowMs = useNow()

  // Disconnected fallback — the dashboard server tried to reach ComfyUI
  // and got nothing back. CORS isn't an issue (the server proxies the
  // call), so this typically means ComfyUI isn't running.
  if (connectionStatus === 'disconnected') {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-2">
        <div className="text-sm font-semibold text-zinc-200">ComfyUI not reachable</div>
        <div className="text-xs text-zinc-400 max-w-md">
          The dashboard server couldn&apos;t reach ComfyUI at{' '}
          <code className="text-[#76B900]">{upstreamHost || 'localhost:8188'}</code>. Make sure
          ComfyUI is running, or override the upstream URL with{' '}
          <code className="text-zinc-200 bg-white/[0.04] rounded px-1 py-0.5">
            SPARK_DASHBOARD_COMFYUI_URL
          </code>
          .
        </div>
        {error && (
          <div
            className="text-[10px] font-mono text-zinc-600 mt-1 max-w-md truncate"
            title={error}
          >
            {error}
          </div>
        )}
      </div>
    )
  }

  const workflowsSeen =
    new Set([
      ...running.map((r) => r.promptId),
      ...pending.map((p) => p.promptId),
      ...history.map((h) => h.promptId),
    ]).size

  return (
    <div className="flex flex-col gap-2 py-1">
      {/* ── Top: Status summary + currently running ──────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* Status */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 min-w-0">
          <PanelHeader title="Status" />
          <div className="flex items-center gap-2 mb-2">
            <StatusDot status={connectionStatus} />
            <span className="text-xs text-zinc-300 capitalize">{connectionStatus}</span>
            <span className="text-[10px] text-zinc-600 font-mono ml-auto truncate" title={upstreamHost}>
              {upstreamHost || 'localhost:8188'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col">
              <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                Workflows
              </span>
              <span className="text-lg font-bold text-zinc-100 font-mono tabular-nums leading-tight">
                {workflowsSeen}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                Queue
              </span>
              <span className="text-lg font-bold text-zinc-100 font-mono tabular-nums leading-tight">
                {queueRemaining}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                Done
              </span>
              <span className="text-lg font-bold text-zinc-100 font-mono tabular-nums leading-tight">
                {totalCompleted}
                {totalErrors > 0 && (
                  <span className="text-xs text-red-400 font-semibold ml-1.5">
                    +{totalErrors} err
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* Now Running */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 min-w-0">
          <PanelHeader title="Now Running" badge={running.length > 0 ? `${running.length}` : 'idle'} />
          {running.length === 0 ? (
            <div className="text-xs text-zinc-500 italic py-1">No jobs executing.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {running.slice(0, 2).map((r) => {
                const live = progress && progress.promptId === r.promptId ? progress : null
                // Determinate progress requires both a workflow size and a
                // live event; otherwise fall back to an animated stripe so
                // there's always a visible bar in Now Running.
                const determinate = live !== null && live.totalNodes > 0
                const pct = determinate ? workflowPct(live!) : 0
                return (
                  <div key={r.promptId} className="flex flex-col gap-1 min-w-0">
                    <PromptRow prompt={r} running nowMs={nowMs} />
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                        <span className="truncate">
                          {live && live.totalNodes > 0
                            ? `Node ${live.executedNodes}/${live.totalNodes}${
                                live.nodeId ? ` · #${live.nodeId}` : ''
                              }`
                            : 'awaiting progress update'}
                        </span>
                        <span className="tabular-nums">
                          {live && live.max > 0 ? `${live.value}/${live.max}` : ''}
                        </span>
                      </div>
                      <ProgressBar
                        pct={pct}
                        label="workflow progress"
                        indeterminate={!determinate}
                      />
                      {determinate && (
                        <div className="text-[10px] text-zinc-600 font-mono tabular-nums text-right">
                          {Math.round(pct)}%
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {running.length > 2 && (
                <div className="text-[10px] text-zinc-500 italic font-mono">
                  +{running.length - 2} more running
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom: Pending + Recent ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* Pending */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 min-w-0">
          <PanelHeader title="Pending" badge={`${pending.length}`} />
          {pending.length === 0 ? (
            <div className="text-xs text-zinc-500 italic py-1">Nothing queued.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
              {pending.slice(0, 10).map((p) => (
                <PromptRow key={p.promptId} prompt={p} nowMs={nowMs} />
              ))}
              {pending.length > 10 && (
                <div className="text-[10px] text-zinc-500 italic font-mono">
                  +{pending.length - 10} more pending
                </div>
              )}
            </div>
          )}
        </div>

        {/* Recent */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 min-w-0">
          <PanelHeader title="Recent" badge={`${history.length}`} />
          {history.length === 0 ? (
            <div className="text-xs text-zinc-500 italic py-1">
              No completed jobs yet.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
              {history.slice(0, 10).map((h) => (
                <HistoryRow key={h.promptId} entry={h} nowMs={nowMs} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
