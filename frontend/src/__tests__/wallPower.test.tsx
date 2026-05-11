import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMetricsHistory } from '@/hooks/useMetricsHistory'
import { EMPTY_COMFY_STATE } from '@/types/comfyui'
import type { MetricsSnapshot, PowerState } from '@/types/metrics'

const STORAGE_KEY = 'spark-dashboard:history:v1'

function emptyPower(): PowerState {
  return {
    status: 'disabled',
    wall_watts: null,
    voltage: null,
    current_amps: null,
    power_factor: null,
    pdu_name: null,
    outlet_label: null,
    last_seen_ms: null,
    error: null,
  }
}

function makeSnapshot(timestamp_ms: number, power: PowerState): MetricsSnapshot {
  return {
    timestamp_ms,
    gpu: {
      name: 'GB10',
      utilization_percent: 50,
      temperature_celsius: 55,
      power_watts: 220,
      power_limit_watts: 500,
      clock_graphics_mhz: 1500,
      clock_sm_mhz: 1500,
      clock_memory_mhz: 8000,
      fan_speed_percent: null,
    },
    cpu: { name: null, aggregate_percent: 0, per_core: [] },
    memory: {
      total_bytes: 0,
      used_bytes: 0,
      available_bytes: 0,
      cached_bytes: 0,
      gpu_estimated_bytes: null,
      gpu_memory_total_bytes: null,
      gpu_memory_used_bytes: null,
      is_unified: false,
    },
    disk: { name: null, read_bytes_per_sec: 0, write_bytes_per_sec: 0 },
    network: { name: null, rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
    engines: [],
    gpu_events: [],
    comfyui: EMPTY_COMFY_STATE,
    power,
  }
}

describe('wall-power history integration', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    window.sessionStorage.clear()
  })

  it('records wallPower only when the PDU collector is connected with a value', () => {
    const { result, rerender } = renderHook(
      ({ snap }: { snap: MetricsSnapshot | null }) => useMetricsHistory(snap),
      { initialProps: { snap: null as MetricsSnapshot | null } },
    )

    const t0 = Date.now()
    // Disabled — should NOT be recorded
    act(() => {
      rerender({ snap: makeSnapshot(t0, emptyPower()) })
    })
    expect(result.current.getChartData('wallPower')).toEqual([])

    // Connected with a reading — recorded.
    act(() => {
      rerender({
        snap: makeSnapshot(t0 + 1000, {
          ...emptyPower(),
          status: 'connected',
          wall_watts: 342.7,
          outlet_label: 'Spark',
        }),
      })
    })
    const points = result.current.getChartData('wallPower')
    expect(points).toHaveLength(1)
    expect(points[0].value).toBeCloseTo(342.7)
  })

  it('deduplicates runs of identical wallPower readings', () => {
    const { result, rerender } = renderHook(
      ({ snap }: { snap: MetricsSnapshot | null }) => useMetricsHistory(snap),
      { initialProps: { snap: null as MetricsSnapshot | null } },
    )

    const t0 = Date.now()
    const sample = (offsetMs: number, watts: number): MetricsSnapshot =>
      makeSnapshot(t0 + offsetMs, {
        ...emptyPower(),
        status: 'connected',
        wall_watts: watts,
        outlet_label: 'Spark',
      })

    // 100 W → recorded
    act(() => rerender({ snap: sample(1000, 100) }))
    // 100 W repeated → skipped
    act(() => rerender({ snap: sample(2000, 100) }))
    act(() => rerender({ snap: sample(3000, 100) }))
    // 120 W → recorded
    act(() => rerender({ snap: sample(4000, 120) }))
    // 120 W repeated → skipped
    act(() => rerender({ snap: sample(5000, 120) }))

    const points = result.current.getChartData('wallPower')
    expect(points.map((p) => p.value)).toEqual([100, 120])
    expect(points.map((p) => p.timestamp)).toEqual([t0 + 1000, t0 + 4000])
  })

  it('skips wallPower when status is connected but wall_watts is null', () => {
    const { result, rerender } = renderHook(
      ({ snap }: { snap: MetricsSnapshot | null }) => useMetricsHistory(snap),
      { initialProps: { snap: null as MetricsSnapshot | null } },
    )

    act(() => {
      rerender({
        snap: makeSnapshot(Date.now(), {
          ...emptyPower(),
          status: 'connected',
          wall_watts: null,
        }),
      })
    })
    expect(result.current.getChartData('wallPower')).toEqual([])
  })

  it('anchors wallPower at power.last_seen_ms when present', () => {
    const { result, rerender } = renderHook(
      ({ snap }: { snap: MetricsSnapshot | null }) => useMetricsHistory(snap),
      { initialProps: { snap: null as MetricsSnapshot | null } },
    )

    const t0 = Date.now()
    // Snapshot arrived at t0+5000 but the controller's last_seen reports
    // the reading was actually refreshed at t0+1234 — the chart point
    // should land at last_seen, not the snapshot's ingest time.
    act(() => {
      rerender({
        snap: makeSnapshot(t0 + 5000, {
          ...emptyPower(),
          status: 'connected',
          wall_watts: 200,
          last_seen_ms: t0 + 1234,
        }),
      })
    })
    const points = result.current.getChartData('wallPower')
    expect(points).toHaveLength(1)
    expect(points[0].timestamp).toBe(t0 + 1234)
    expect(points[0].value).toBe(200)
  })

  it('survives a sessionStorage round-trip via persistence', () => {
    const now = Date.now()
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: now,
        systemMetrics: {
          wallPower: [{ timestamp: now - 1000, value: 250 }],
        },
        engineMetrics: {},
        events: [],
        requests: {},
      }),
    )

    const { result } = renderHook(() => useMetricsHistory(null))
    expect(result.current.getChartData('wallPower')).toEqual([
      { timestamp: now - 1000, value: 250 },
    ])
  })
})
