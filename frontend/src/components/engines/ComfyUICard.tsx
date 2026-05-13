import { useEffect, useRef, useState } from 'react'
import type {
  ComfyHistoryEntry,
  ComfyPromptInfo,
  ComfyProgress,
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

/** Convert a `ComfyProgress` snapshot to a 0..1 fraction representing how
 *  far along the currently-running prompt is, blending the node-level and
 *  step-level scales. Exported for testing. */
export function runningPromptFraction(progress: ComfyProgress | null): number {
  if (!progress || progress.totalNodes <= 0) return 0
  const innerFraction = progress.max > 0 ? progress.value / progress.max : 0
  const raw = (progress.executedNodes + innerFraction) / progress.totalNodes
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.min(1, raw))
}

/** Format an ETA expressed in milliseconds as a compact "Xm Ys"-style string.
 *  Returns "—" for null/non-finite inputs. Exported for testing. */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSecs = Math.round(ms / 1000)
  if (totalSecs < 1) return '<1s'
  if (totalSecs < 60) return `${totalSecs}s`
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins === 0 ? `${hrs}h` : `${hrs}h ${remMins}m`
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

interface QueueBatch {
  /** Wall-clock ms when we first noticed this batch (queue went non-empty). */
  startedAtMs: number
  /** `totalCompleted` at the moment the batch started — used to count
   *  completions that have landed since. */
  completedAtStart: number
}

/** Track the lifetime of the current "queue batch" — the contiguous run
 *  from when the queue went non-empty until it next drains. While a batch
 *  is in flight, returns a snapshot of when it started and how many jobs
 *  had been completed at that point. */
function useQueueBatch(queueDepth: number, totalCompleted: number): QueueBatch | null {
  const [batch, setBatch] = useState<QueueBatch | null>(null)
  // Read latest counters inside the effect without re-running it on every tick.
  const completedRef = useRef(totalCompleted)
  completedRef.current = totalCompleted

  useEffect(() => {
    if (queueDepth > 0) {
      setBatch((prev) =>
        prev ?? { startedAtMs: Date.now(), completedAtStart: completedRef.current },
      )
    } else {
      setBatch(null)
    }
  }, [queueDepth])

  return batch
}

interface QueueProgressStats {
  /** True when there's an active batch (queue is non-empty). */
  active: boolean
  /** Headline 0..1 fraction including fractional progress on the running prompt. */
  fraction: number
  /** Whole-completion count since the batch started. */
  done: number
  /** queue_running + queue_pending. */
  remaining: number
  /** done + remaining (the denominator). */
  total: number
  /** Estimated ms until the queue drains, or null if we don't have enough
   *  signal yet (i.e. no completion has landed during this batch). */
  etaMs: number | null
  /** Average ms per item, or null if we have no completions during this batch. */
  avgMsPerItem: number | null
}

/** Derive headline stats for the QueueProgress panel from the latest state
 *  plus the cached batch start. Exported for testing. */
export function computeQueueStats(
  state: ComfyUIState,
  batch: QueueBatch | null,
  nowMs: number,
): QueueProgressStats {
  const remaining = state.queueRemaining
  if (remaining <= 0 || batch === null) {
    return {
      active: false,
      fraction: 0,
      done: 0,
      remaining,
      total: 0,
      etaMs: null,
      avgMsPerItem: null,
    }
  }
  const done = Math.max(0, state.totalCompleted - batch.completedAtStart)
  const inProgress = runningPromptFraction(state.progress)
  const total = done + remaining
  const effectiveDone = Math.min(total, done + inProgress)
  const fraction = total > 0 ? effectiveDone / total : 0

  let avgMsPerItem: number | null = null
  let etaMs: number | null = null
  const elapsedMs = Math.max(0, nowMs - batch.startedAtMs)
  if (done > 0) {
    avgMsPerItem = elapsedMs / done
    const remainingWork = Math.max(0, remaining - inProgress)
    etaMs = remainingWork * avgMsPerItem
  }

  return {
    active: true,
    fraction: Math.max(0, Math.min(1, fraction)),
    done,
    remaining,
    total,
    etaMs,
    avgMsPerItem,
  }
}

function QueueProgressPanel({ stats }: { stats: QueueProgressStats }) {
  const percentLabel = `${Math.round(stats.fraction * 100)}%`
  const widthPct = `${(stats.fraction * 100).toFixed(1)}%`
  return (
    <div className="bg-white/[0.02] rounded-md px-3 py-2.5 min-w-0">
      <PanelHeader
        title="Queue Progress"
        badge={stats.active ? `${stats.done}/${stats.total}` : 'idle'}
      />
      {!stats.active ? (
        <div className="text-xs text-zinc-500 italic py-1">Queue is empty.</div>
      ) : (
        <>
          <div
            className="h-2 w-full bg-white/[0.04] rounded-sm overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(stats.fraction * 100)}
            aria-label="ComfyUI queue progress"
          >
            <div
              className="h-full bg-[#76B900] transition-[width] duration-500 ease-out"
              style={{ width: widthPct }}
            />
          </div>
          <div className="flex items-baseline justify-between mt-2 gap-2">
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                Complete
              </span>
              <span className="text-lg font-bold text-zinc-100 font-mono tabular-nums leading-tight">
                {percentLabel}
              </span>
            </div>
            <div className="flex flex-col items-end min-w-0">
              <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                ETA
              </span>
              <span
                className="text-lg font-bold text-zinc-100 font-mono tabular-nums leading-tight"
                title={
                  stats.avgMsPerItem !== null
                    ? `~${(stats.avgMsPerItem / 1000).toFixed(1)}s/job`
                    : 'Waiting for first completion'
                }
              >
                {stats.etaMs !== null ? formatEta(stats.etaMs) : '—'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
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
    upstreamHost,
  } = state
  const nowMs = useNow()
  const batch = useQueueBatch(queueRemaining, state.totalCompleted)
  const queueStats = computeQueueStats(state, batch, nowMs)

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
      {/* ── Top: Status summary + currently running + queue progress ─────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
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
              {running.slice(0, 2).map((r) => (
                <PromptRow key={r.promptId} prompt={r} running nowMs={nowMs} />
              ))}
              {running.length > 2 && (
                <div className="text-[10px] text-zinc-500 italic font-mono">
                  +{running.length - 2} more running
                </div>
              )}
            </div>
          )}
        </div>

        {/* Queue Progress */}
        <QueueProgressPanel stats={queueStats} />
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
