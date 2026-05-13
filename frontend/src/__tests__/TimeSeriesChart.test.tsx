import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  TimeSeriesChart,
  CHART_WINDOW_MS,
  clampSingleSeries,
  mergeSeries,
  latestTimestamp,
} from '../components/charts/TimeSeriesChart'

const sampleData = [
  { timestamp: 1700000000000, value: 50 },
  { timestamp: 1700000001000, value: 55 },
  { timestamp: 1700000002000, value: 60 },
  { timestamp: 1700000003000, value: 58 },
]

describe('TimeSeriesChart', () => {
  it('renders chart container', () => {
    const { container } = render(<TimeSeriesChart data={sampleData} />)
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
  })

  it('renders without crashing with events', () => {
    const events = [
      {
        timestamp: 1700000001000,
        type: 'thermal',
        detail: 'Thermal throttling active',
      },
    ]
    const { container } = render(
      <TimeSeriesChart data={sampleData} events={events} />,
    )
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
  })

  it('renders without crashing with requests', () => {
    const requests = [
      {
        start: 1700000000000,
        end: 1700000002000,
        tps: 25.5,
        ttft: 120,
      },
    ]
    const { container } = render(
      <TimeSeriesChart data={sampleData} requests={requests} />,
    )
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
  })

  // The chart x-axis must always span exactly CHART_WINDOW_MS regardless of
  // sample cadence. Previously the span was derived from observed sample
  // interval × point count, so a 2-second buffer cadence (from useMetrics'
  // React-state flush throttle) made the chart span ~10 minutes instead of 5
  // and `padData` filled the older half with a fake flat line.
  describe('5-minute window invariant', () => {
    it('clamps single-series data to the [tEnd - window, tEnd] range', () => {
      const tEnd = 1700000000000
      const tStart = tEnd - CHART_WINDOW_MS
      const data = [
        { timestamp: tEnd - CHART_WINDOW_MS - 60_000, value: 1 }, // outside
        { timestamp: tEnd - CHART_WINDOW_MS + 1_000, value: 2 }, // inside
        { timestamp: tEnd - 30_000, value: 3 }, // inside
        { timestamp: tEnd, value: 4 }, // inside (boundary)
      ]
      const clamped = clampSingleSeries(data, tStart, tEnd)
      expect(clamped.map((p) => p.value)).toEqual([2, 3, 4])
    })

    it('mergeSeries returns only points inside the window and does not pad', () => {
      const tEnd = 1700000000000
      const tStart = tEnd - CHART_WINDOW_MS
      const dense = Array.from({ length: 5 }, (_, i) => ({
        timestamp: tEnd - i * 1000,
        value: i,
      })).reverse()
      const sparse = [{ timestamp: tEnd - 200_000, value: 99 }]
      const merged = mergeSeries(
        [
          { data: dense, label: 'a', color: '#0f0' },
          { data: sparse, label: 'b', color: '#f00' },
        ],
        tStart,
        tEnd,
      )
      // Only real points — no grid seeding. 5 dense + 1 sparse = 6 unique timestamps.
      expect(merged.length).toBe(6)
      const min = Math.min(...merged.map((r) => r.timestamp))
      const max = Math.max(...merged.map((r) => r.timestamp))
      expect(min).toBeGreaterThanOrEqual(tStart)
      expect(max).toBeLessThanOrEqual(tEnd)
    })

    it('latestTimestamp picks the max timestamp across single data and series', () => {
      const a = [{ timestamp: 100, value: 0 }]
      const b: { data: { timestamp: number; value: number }[]; label: string; color: string }[] = [
        { data: [{ timestamp: 200, value: 0 }], label: 'b', color: '#fff' },
      ]
      expect(latestTimestamp(a, b)).toBe(200)
      expect(latestTimestamp(undefined, undefined)).toBe(0)
    })

    it('clampSingleSeries drops samples older than the window even when the buffer holds more', () => {
      // Simulate the cadence-confused scenario: 2-second-spaced samples
      // covering 10 minutes (300 points). Only the most recent 5-min slice
      // should reach the chart, regardless of cadence.
      const tEnd = 1700000000000
      const cadenceMs = 2000
      const data = Array.from({ length: 300 }, (_, i) => ({
        timestamp: tEnd - (299 - i) * cadenceMs,
        value: i,
      }))
      const tStart = tEnd - CHART_WINDOW_MS
      const clamped = clampSingleSeries(data, tStart, tEnd)
      expect(clamped[0].timestamp).toBeGreaterThanOrEqual(tStart)
      expect(clamped[clamped.length - 1].timestamp).toBe(tEnd)
      // 5 min / 2 s = 151 points (boundary-inclusive on both ends).
      expect(clamped.length).toBe(151)
    })
  })
})
