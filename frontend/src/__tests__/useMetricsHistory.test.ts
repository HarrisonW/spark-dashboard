import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMetricsHistory } from '@/hooks/useMetricsHistory'

const STORAGE_KEY = 'spark-dashboard:history:v1'

function makePoints(now: number, ageSeconds: number[], baseValue = 10): Array<{ timestamp: number; value: number }> {
  return ageSeconds.map((age, i) => ({ timestamp: now - age * 1000, value: baseValue + i }))
}

describe('useMetricsHistory persistence', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    window.sessionStorage.clear()
  })

  it('starts empty when sessionStorage has nothing', () => {
    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('cpuAggregate')).toEqual([])
    expect(result.current.getEvents()).toEqual([])
    expect(result.current.getRequests()).toEqual([])
  })

  it('restores recent system-metric points from sessionStorage on mount', () => {
    const now = Date.now()
    const points = makePoints(now, [120, 60, 30, 5]) // all within 5 min
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: now,
        systemMetrics: { cpuAggregate: points },
        engineMetrics: {},
        events: [],
        requests: {},
      }),
    )

    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('cpuAggregate')).toEqual(points)
  })

  it('drops persisted points older than the 5-minute window on restore', () => {
    const now = Date.now()
    const fresh = makePoints(now, [60, 10], 100) // within window
    const stale = makePoints(now, [3600, 1800], 200) // way outside
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: now - 3600 * 1000,
        systemMetrics: { cpuAggregate: [...stale, ...fresh] },
        engineMetrics: {},
        events: [],
        requests: {},
      }),
    )

    const { result } = renderHook(() => useMetricsHistory(null))
    const restored = result.current.getChartData('cpuAggregate')
    expect(restored).toEqual(fresh)
  })

  it('restores engine-scoped metrics under the "engineKey:metricName" lookup', () => {
    const now = Date.now()
    const tpsPoints = makePoints(now, [30, 10], 50)
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: now,
        systemMetrics: {},
        engineMetrics: {
          'Vllm-http://127.0.0.1:8000': { tps: tpsPoints },
        },
        events: [],
        requests: {},
      }),
    )

    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('Vllm-http://127.0.0.1:8000:tps')).toEqual(tpsPoints)
  })

  it('restores events and per-engine requests', () => {
    const now = Date.now()
    const event = { timestamp_ms: now - 20_000, event_type: 'thermal', detail: 'gpu hot' }
    const request = { start_ms: now - 5_000, end_ms: now - 2_000, tokens_per_sec: 40, ttft_ms: 200 }

    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: now,
        systemMetrics: {},
        engineMetrics: {},
        events: [event],
        requests: { 'Vllm-http://127.0.0.1:8000': [request] },
      }),
    )

    // getEvents / getRequests filter by lastTimestampRef. After restore that ref is
    // the latest restored timestamp (the event), which keeps both items in the 5-min window.
    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getEvents()).toEqual([event])
    expect(result.current.getRequests()).toEqual([request])
  })

  it('discards malformed JSON and falls back to empty state', () => {
    window.sessionStorage.setItem(STORAGE_KEY, '{ not valid json')
    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('cpuAggregate')).toEqual([])
  })

  it('discards a payload whose shape is wrong', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: 'not-a-number',
        systemMetrics: { cpuAggregate: [{ timestamp: 1, value: 2 }] },
      }),
    )
    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('cpuAggregate')).toEqual([])
  })

  it('rejects datapoints with non-finite values without throwing', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        systemMetrics: { cpuAggregate: [{ timestamp: Date.now(), value: 'oops' }] },
        engineMetrics: {},
        events: [],
        requests: {},
      }),
    )
    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('cpuAggregate')).toEqual([])
  })

  it('writes the current state to sessionStorage on pagehide', () => {
    renderHook(() => useMetricsHistory(null))
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()

    window.dispatchEvent(new Event('pagehide'))

    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(typeof parsed.savedAt).toBe('number')
    expect(parsed.systemMetrics).toEqual({})
    expect(parsed.engineMetrics).toEqual({})
    expect(parsed.events).toEqual([])
    expect(parsed.requests).toEqual({})
  })

  it('flushes periodically while mounted', () => {
    renderHook(() => useMetricsHistory(null))
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(5_000)

    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('stops writing after unmount', () => {
    const { unmount } = renderHook(() => useMetricsHistory(null))
    unmount()
    window.sessionStorage.clear()

    vi.advanceTimersByTime(15_000)
    window.dispatchEvent(new Event('pagehide'))

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
