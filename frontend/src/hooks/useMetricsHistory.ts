import { useRef, useState, useCallback, useEffect } from 'react'
import { CircularBuffer } from '../lib/circular-buffer'
import type { MetricsSnapshot, GpuEventData, InferenceRequestData } from '../types/metrics'

interface DataPoint {
  timestamp: number
  value: number
}

const BUFFER_CAPACITY = 900 // 15 minutes at 1 sample/sec
const EVENT_BUFFER_CAPACITY = 100
const REQUEST_BUFFER_CAPACITY = 50

const DEFAULT_WINDOW_SECONDS = 300 // 5 minutes
const STORAGE_KEY = 'spark-dashboard:history:v1'
const WRITE_INTERVAL_MS = 5000

type MetricKey =
  | 'gpuUtil'
  | 'gpuTemp'
  | 'gpuPower'
  | 'gpuClockGraphics'
  | 'cpuAggregate'
  | 'memoryUsedPercent'
  | 'diskRead'
  | 'diskWrite'
  | 'networkRx'
  | 'networkTx'

const SYSTEM_METRIC_KEYS: MetricKey[] = [
  'gpuUtil',
  'gpuTemp',
  'gpuPower',
  'gpuClockGraphics',
  'cpuAggregate',
  'memoryUsedPercent',
  'diskRead',
  'diskWrite',
  'networkRx',
  'networkTx',
]

const ENGINE_METRIC_KEYS = [
  'tps', 'avgTps', 'perReqTps', 'ttft', 'kvCache', 'e2eLatency',
  'promptTps', 'avgPromptTps', 'perReqPromptTps', 'queueTime',
  'interTokenLatency', 'batchSize',
  'ttftP50', 'ttftP95', 'ttftP99',
  'itlP50', 'itlP95', 'itlP99',
  'e2eP50', 'e2eP95', 'e2eP99',
  'activeRequests', 'queuedRequests', 'totalRequests',
] as const

type EngineMetricName = (typeof ENGINE_METRIC_KEYS)[number]
type EngineBuffers = Record<EngineMetricName, CircularBuffer<DataPoint>>

function createBuffers(): Record<MetricKey, CircularBuffer<DataPoint>> {
  const buffers = {} as Record<MetricKey, CircularBuffer<DataPoint>>
  for (const key of SYSTEM_METRIC_KEYS) {
    buffers[key] = new CircularBuffer<DataPoint>(BUFFER_CAPACITY)
  }
  return buffers
}

function createEngineBuffers(): EngineBuffers {
  const buffers = {} as EngineBuffers
  for (const key of ENGINE_METRIC_KEYS) {
    buffers[key] = new CircularBuffer<DataPoint>(BUFFER_CAPACITY)
  }
  return buffers
}

function extractValue(metrics: MetricsSnapshot, key: MetricKey): number | null {
  switch (key) {
    case 'gpuUtil':
      return metrics.gpu.utilization_percent
    case 'gpuTemp':
      return metrics.gpu.temperature_celsius
    case 'gpuPower':
      return metrics.gpu.power_watts
    case 'gpuClockGraphics':
      return metrics.gpu.clock_graphics_mhz
    case 'cpuAggregate':
      return metrics.cpu.aggregate_percent
    case 'memoryUsedPercent':
      return metrics.memory.total_bytes > 0
        ? (metrics.memory.used_bytes / metrics.memory.total_bytes) * 100
        : null
    case 'diskRead':
      return metrics.disk.read_bytes_per_sec
    case 'diskWrite':
      return metrics.disk.write_bytes_per_sec
    case 'networkRx':
      return metrics.network.rx_bytes_per_sec
    case 'networkTx':
      return metrics.network.tx_bytes_per_sec
  }
}

// ── Persistence ───────────────────────────────────────────────────────────
// The buffers above live only in memory. To make recent history survive a
// page refresh, we periodically snapshot them into sessionStorage (per-tab,
// cleared on tab close) and hydrate from that snapshot when the hook mounts.

type StoredPayload = {
  savedAt: number
  systemMetrics: Partial<Record<MetricKey, DataPoint[]>>
  engineMetrics: Record<string, Partial<Record<EngineMetricName, DataPoint[]>>>
  events: GpuEventData[]
  requests: Record<string, InferenceRequestData[]>
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function isValidDataPoint(x: unknown): x is DataPoint {
  if (!x || typeof x !== 'object') return false
  const dp = x as Record<string, unknown>
  return isFiniteNumber(dp.timestamp) && isFiniteNumber(dp.value)
}

function isValidEvent(x: unknown): x is GpuEventData {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  return (
    isFiniteNumber(e.timestamp_ms) &&
    typeof e.event_type === 'string' &&
    typeof e.detail === 'string'
  )
}

function isValidRequest(x: unknown): x is InferenceRequestData {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return (
    isFiniteNumber(r.start_ms) &&
    isFiniteNumber(r.end_ms) &&
    isFiniteNumber(r.tokens_per_sec) &&
    isFiniteNumber(r.ttft_ms)
  )
}

function parseStoredPayload(raw: string | null): StoredPayload | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (!isFiniteNumber(p.savedAt)) return null

  const systemMetrics: StoredPayload['systemMetrics'] = {}
  if (p.systemMetrics && typeof p.systemMetrics === 'object') {
    for (const [key, value] of Object.entries(p.systemMetrics as Record<string, unknown>)) {
      if (!SYSTEM_METRIC_KEYS.includes(key as MetricKey)) continue
      if (!Array.isArray(value) || !value.every(isValidDataPoint)) return null
      systemMetrics[key as MetricKey] = value
    }
  }

  const engineMetrics: StoredPayload['engineMetrics'] = {}
  if (p.engineMetrics && typeof p.engineMetrics === 'object') {
    for (const [engineKey, byMetric] of Object.entries(p.engineMetrics as Record<string, unknown>)) {
      if (!byMetric || typeof byMetric !== 'object') return null
      const inner: Partial<Record<EngineMetricName, DataPoint[]>> = {}
      for (const [metricName, value] of Object.entries(byMetric as Record<string, unknown>)) {
        if (!(ENGINE_METRIC_KEYS as readonly string[]).includes(metricName)) continue
        if (!Array.isArray(value) || !value.every(isValidDataPoint)) return null
        inner[metricName as EngineMetricName] = value
      }
      engineMetrics[engineKey] = inner
    }
  }

  let events: GpuEventData[] = []
  if (p.events !== undefined) {
    if (!Array.isArray(p.events) || !p.events.every(isValidEvent)) return null
    events = p.events
  }

  const requests: StoredPayload['requests'] = {}
  if (p.requests && typeof p.requests === 'object') {
    for (const [engineKey, value] of Object.entries(p.requests as Record<string, unknown>)) {
      if (!Array.isArray(value) || !value.every(isValidRequest)) return null
      requests[engineKey] = value
    }
  }

  return { savedAt: p.savedAt, systemMetrics, engineMetrics, events, requests }
}

function readStoredPayload(): StoredPayload | null {
  if (typeof window === 'undefined') return null
  try {
    return parseStoredPayload(window.sessionStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

type HistoryState = {
  buffers: Record<MetricKey, CircularBuffer<DataPoint>>
  engineBuffers: Record<string, EngineBuffers>
  eventBuffer: CircularBuffer<GpuEventData>
  requestBuffers: Record<string, CircularBuffer<InferenceRequestData>>
}

function createEmptyState(): HistoryState {
  return {
    buffers: createBuffers(),
    engineBuffers: {},
    eventBuffer: new CircularBuffer<GpuEventData>(EVENT_BUFFER_CAPACITY),
    requestBuffers: {},
  }
}

function hydrateState(stored: StoredPayload, cutoffMs: number): { state: HistoryState; latestTimestamp: number } {
  const state = createEmptyState()
  let latest = 0

  for (const key of SYSTEM_METRIC_KEYS) {
    const points = stored.systemMetrics[key]
    if (!points) continue
    for (const p of points) {
      if (p.timestamp >= cutoffMs) {
        state.buffers[key].push(p)
        if (p.timestamp > latest) latest = p.timestamp
      }
    }
  }

  for (const [engineKey, byMetric] of Object.entries(stored.engineMetrics)) {
    const buffers = createEngineBuffers()
    for (const metricName of ENGINE_METRIC_KEYS) {
      const points = byMetric[metricName]
      if (!points) continue
      for (const p of points) {
        if (p.timestamp >= cutoffMs) {
          buffers[metricName].push(p)
          if (p.timestamp > latest) latest = p.timestamp
        }
      }
    }
    state.engineBuffers[engineKey] = buffers
  }

  for (const e of stored.events) {
    if (e.timestamp_ms >= cutoffMs) state.eventBuffer.push(e)
  }

  for (const [engineKey, items] of Object.entries(stored.requests)) {
    const buf = new CircularBuffer<InferenceRequestData>(REQUEST_BUFFER_CAPACITY)
    for (const r of items) {
      if (r.end_ms >= cutoffMs) buf.push(r)
    }
    state.requestBuffers[engineKey] = buf
  }

  return { state, latestTimestamp: latest }
}

function initHistoryState(): { state: HistoryState; lastTimestamp: number } {
  const stored = readStoredPayload()
  if (!stored) return { state: createEmptyState(), lastTimestamp: 0 }
  const cutoff = Date.now() - DEFAULT_WINDOW_SECONDS * 1000
  const { state, latestTimestamp } = hydrateState(stored, cutoff)
  return { state, lastTimestamp: latestTimestamp }
}

function serializeState(state: HistoryState, cutoffMs: number): StoredPayload {
  const systemMetrics: StoredPayload['systemMetrics'] = {}
  for (const key of SYSTEM_METRIC_KEYS) {
    const points = state.buffers[key].toArray().filter((p) => p.timestamp >= cutoffMs)
    if (points.length > 0) systemMetrics[key] = points
  }

  const engineMetrics: StoredPayload['engineMetrics'] = {}
  for (const [engineKey, byMetric] of Object.entries(state.engineBuffers)) {
    const inner: Partial<Record<EngineMetricName, DataPoint[]>> = {}
    for (const metricName of ENGINE_METRIC_KEYS) {
      const points = byMetric[metricName].toArray().filter((p) => p.timestamp >= cutoffMs)
      if (points.length > 0) inner[metricName] = points
    }
    if (Object.keys(inner).length > 0) engineMetrics[engineKey] = inner
  }

  const events = state.eventBuffer.toArray().filter((e) => e.timestamp_ms >= cutoffMs)

  const requests: StoredPayload['requests'] = {}
  for (const [engineKey, buf] of Object.entries(state.requestBuffers)) {
    const items = buf.toArray().filter((r) => r.end_ms >= cutoffMs)
    if (items.length > 0) requests[engineKey] = items
  }

  return { savedAt: Date.now(), systemMetrics, engineMetrics, events, requests }
}

function writeStoredPayload(state: HistoryState, lastTimestamp: number): void {
  if (typeof window === 'undefined') return
  // Use the server clock when we have it (avoids clock-skew artifacts);
  // fall back to wall clock for the very first write before any data lands.
  const reference = lastTimestamp || Date.now()
  const cutoff = reference - DEFAULT_WINDOW_SECONDS * 1000
  const payload = serializeState(state, cutoff)
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // QuotaExceededError, private mode, etc. — leave the prior snapshot in place.
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useMetricsHistory(
  metrics: MetricsSnapshot | null,
) {
  const stateRef = useRef<HistoryState | null>(null)
  const lastTimestampRef = useRef<number>(0)
  if (stateRef.current === null) {
    const init = initHistoryState()
    stateRef.current = init.state
    lastTimestampRef.current = init.lastTimestamp
  }
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!metrics || metrics.timestamp_ms === lastTimestampRef.current) return
    lastTimestampRef.current = metrics.timestamp_ms

    const ts = metrics.timestamp_ms
    const state = stateRef.current!

    for (const key of SYSTEM_METRIC_KEYS) {
      const val = extractValue(metrics, key)
      if (val !== null) {
        state.buffers[key].push({ timestamp: ts, value: val })
      }
    }

    // Engine-specific metrics
    for (const engine of metrics.engines) {
      const engineKey = `${engine.engine_type}-${engine.endpoint}`
      if (!state.engineBuffers[engineKey]) {
        state.engineBuffers[engineKey] = createEngineBuffers()
      }
      const eb = state.engineBuffers[engineKey]
      if (engine.metrics) {
        if (engine.metrics.tokens_per_sec !== null) {
          eb.tps.push({ timestamp: ts, value: engine.metrics.tokens_per_sec })
        }
        if (engine.metrics.avg_tokens_per_sec !== null) {
          eb.avgTps.push({ timestamp: ts, value: engine.metrics.avg_tokens_per_sec })
        }
        if (engine.metrics.per_request_tps !== null) {
          eb.perReqTps.push({ timestamp: ts, value: engine.metrics.per_request_tps })
        }
        if (engine.metrics.ttft_ms !== null) {
          eb.ttft.push({ timestamp: ts, value: engine.metrics.ttft_ms })
        }
        if (engine.metrics.kv_cache_percent !== null) {
          eb.kvCache.push({
            timestamp: ts,
            value: engine.metrics.kv_cache_percent,
          })
        }
        if (engine.metrics.e2e_latency_ms !== null) {
          eb.e2eLatency.push({ timestamp: ts, value: engine.metrics.e2e_latency_ms })
        }
        if (engine.metrics.prompt_tokens_per_sec !== null) {
          eb.promptTps.push({ timestamp: ts, value: engine.metrics.prompt_tokens_per_sec })
        }
        if (engine.metrics.avg_prompt_tokens_per_sec !== null) {
          eb.avgPromptTps.push({ timestamp: ts, value: engine.metrics.avg_prompt_tokens_per_sec })
        }
        if (engine.metrics.per_request_prompt_tps !== null) {
          eb.perReqPromptTps.push({ timestamp: ts, value: engine.metrics.per_request_prompt_tps })
        }
        if (engine.metrics.queue_time_ms !== null) {
          eb.queueTime.push({ timestamp: ts, value: engine.metrics.queue_time_ms })
        }
        if (engine.metrics.inter_token_latency_ms !== null) {
          eb.interTokenLatency.push({ timestamp: ts, value: engine.metrics.inter_token_latency_ms })
        }
        if (engine.metrics.avg_batch_size !== null) {
          eb.batchSize.push({ timestamp: ts, value: engine.metrics.avg_batch_size })
        }
        const tp = engine.metrics.ttft_percentiles
        if (tp) {
          if (tp.p50_ms !== null) eb.ttftP50.push({ timestamp: ts, value: tp.p50_ms })
          if (tp.p95_ms !== null) eb.ttftP95.push({ timestamp: ts, value: tp.p95_ms })
          if (tp.p99_ms !== null) eb.ttftP99.push({ timestamp: ts, value: tp.p99_ms })
        }
        const ip = engine.metrics.itl_percentiles
        if (ip) {
          if (ip.p50_ms !== null) eb.itlP50.push({ timestamp: ts, value: ip.p50_ms })
          if (ip.p95_ms !== null) eb.itlP95.push({ timestamp: ts, value: ip.p95_ms })
          if (ip.p99_ms !== null) eb.itlP99.push({ timestamp: ts, value: ip.p99_ms })
        }
        const ep = engine.metrics.e2e_percentiles
        if (ep) {
          if (ep.p50_ms !== null) eb.e2eP50.push({ timestamp: ts, value: ep.p50_ms })
          if (ep.p95_ms !== null) eb.e2eP95.push({ timestamp: ts, value: ep.p95_ms })
          if (ep.p99_ms !== null) eb.e2eP99.push({ timestamp: ts, value: ep.p99_ms })
        }
        if (engine.metrics.active_requests !== null) {
          eb.activeRequests.push({ timestamp: ts, value: engine.metrics.active_requests })
        }
        if (engine.metrics.queued_requests !== null) {
          eb.queuedRequests.push({ timestamp: ts, value: engine.metrics.queued_requests })
        }
        if (engine.metrics.total_requests !== null) {
          eb.totalRequests.push({ timestamp: ts, value: engine.metrics.total_requests })
        }
      }

      // Accumulate per-engine inference requests
      if (engine.recent_requests && engine.recent_requests.length > 0) {
        if (!state.requestBuffers[engineKey]) {
          state.requestBuffers[engineKey] =
            new CircularBuffer<InferenceRequestData>(REQUEST_BUFFER_CAPACITY)
        }
        for (const req of engine.recent_requests) {
          state.requestBuffers[engineKey].push(req)
        }
      }
    }

    // Accumulate GPU events
    if (metrics.gpu_events && metrics.gpu_events.length > 0) {
      for (const event of metrics.gpu_events) {
        state.eventBuffer.push(event)
      }
    }

    setVersion((v) => v + 1)
  }, [metrics])

  // Periodic + page-hide flush to sessionStorage so recent history survives a refresh.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const flush = () => writeStoredPayload(stateRef.current!, lastTimestampRef.current)
    const id = window.setInterval(flush, WRITE_INTERVAL_MS)
    window.addEventListener('pagehide', flush)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  const getChartData = useCallback(
    (metric: string): DataPoint[] => {
      // Force dependency on version for reactivity
      void version

      const windowMs = DEFAULT_WINDOW_SECONDS * 1000
      const now = lastTimestampRef.current
      const cutoff = now - windowMs

      const state = stateRef.current!

      // Check system metrics
      const systemBuffer = state.buffers[metric as MetricKey]
      if (systemBuffer) {
        return systemBuffer
          .toArray()
          .filter((dp) => dp.timestamp >= cutoff)
      }

      // Check engine metrics (format: "engineKey:metricName")
      const colonIndex = metric.lastIndexOf(':')
      if (colonIndex > 0) {
        const engineKey = metric.substring(0, colonIndex)
        const metricName = metric.substring(colonIndex + 1) as EngineMetricName
        const eb = state.engineBuffers[engineKey]
        if (eb && eb[metricName]) {
          return eb[metricName]
            .toArray()
            .filter((dp) => dp.timestamp >= cutoff)
        }
      }

      return []
    },
    [version],
  )

  const getSparklineData = useCallback(
    (metric: string, count = 30): number[] => {
      void version

      const state = stateRef.current!

      const systemBuffer = state.buffers[metric as MetricKey]
      if (systemBuffer) {
        return systemBuffer.last(count).map((dp) => dp.value)
      }

      const colonIndex = metric.lastIndexOf(':')
      if (colonIndex > 0) {
        const engineKey = metric.substring(0, colonIndex)
        const metricName = metric.substring(colonIndex + 1) as EngineMetricName
        const eb = state.engineBuffers[engineKey]
        if (eb && eb[metricName]) {
          return eb[metricName].last(count).map((dp) => dp.value)
        }
      }

      return []
    },
    [version],
  )

  const getEvents = useCallback((): GpuEventData[] => {
    void version

    const windowMs = DEFAULT_WINDOW_SECONDS * 1000
    const now = lastTimestampRef.current
    const cutoff = now - windowMs

    return stateRef.current!.eventBuffer
      .toArray()
      .filter((e) => e.timestamp_ms >= cutoff)
  }, [version])

  const getRequests = useCallback(
    (engineKey?: string): InferenceRequestData[] => {
      void version

      const windowMs = DEFAULT_WINDOW_SECONDS * 1000
      const now = lastTimestampRef.current
      const cutoff = now - windowMs

      const requestBuffers = stateRef.current!.requestBuffers

      if (engineKey) {
        const buf = requestBuffers[engineKey]
        if (!buf) return []
        return buf.toArray().filter((r) => r.end_ms >= cutoff)
      }

      // Return all engines' requests
      const all: InferenceRequestData[] = []
      for (const buf of Object.values(requestBuffers)) {
        for (const r of buf.toArray()) {
          if (r.end_ms >= cutoff) {
            all.push(r)
          }
        }
      }
      return all
    },
    [version],
  )

  return { getChartData, getSparklineData, getEvents, getRequests }
}
