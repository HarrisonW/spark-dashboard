import React from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
} from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { NVIDIA_THEME } from '@/lib/theme'
import { cn } from '@/lib/utils'

interface DataPoint {
  timestamp: number
  value: number
}

export interface ChartSeries {
  data: DataPoint[]
  label: string
  color: string
  /**
   * Axis to plot the series against. Defaults to "left". Set "right" on
   * series with a different magnitude (e.g. ITL ~10ms vs TTFT ~300ms) so
   * each line gets its own y-scale and small variations stay visible.
   */
  axis?: 'left' | 'right'
}

interface TimeSeriesChartProps {
  /** Single-line mode (backward compat) */
  data?: DataPoint[]
  color?: string
  /** Multi-line mode — when provided, `data` and `color` are ignored */
  series?: ChartSeries[]
  events?: Array<{ timestamp: number; type: string; detail: string }>
  requests?: Array<{ start: number; end: number; tps: number; ttft: number }>
  yDomain?: [number, number]
  unit?: string
  /** Pixel number, or any CSS length (`"clamp(80px, 13vh, 120px)"`, etc.). */
  height?: number | string
  title?: string
  /** Extra classes applied to the outer wrapper (e.g. grid column placement). */
  className?: string
  /** When true, the plot area stretches to fill its parent's height
   *  instead of using `height`. The parent must establish a height
   *  (e.g. via `h-full` inside a flex column). */
  fillHeight?: boolean
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function eventStrokeColor(type: string): string {
  if (type === 'thermal' || type === 'xid') return NVIDIA_THEME.critical
  return NVIDIA_THEME.warning
}

// Chart window — must match DEFAULT_WINDOW_SECONDS in useMetricsHistory.
// Anchoring the x-axis to a fixed window (instead of deriving it from the
// observed sample interval × point count) keeps the chart span consistent
// regardless of cadence drift or sparse series like PDU wall-power.
export const CHART_WINDOW_MS = 5 * 60 * 1000

export function latestTimestamp(
  data: DataPoint[] | undefined,
  seriesList: ChartSeries[] | undefined,
): number {
  let tEnd = 0
  if (data) {
    for (const p of data) if (p.timestamp > tEnd) tEnd = p.timestamp
  }
  if (seriesList) {
    for (const s of seriesList) {
      for (const p of s.data) if (p.timestamp > tEnd) tEnd = p.timestamp
    }
  }
  return tEnd
}

export function clampSingleSeries(
  data: DataPoint[],
  tStart: number,
  tEnd: number,
): DataPoint[] {
  const out: DataPoint[] = []
  for (const p of data) {
    if (p.timestamp >= tStart && p.timestamp <= tEnd) out.push(p)
  }
  return out
}

/**
 * Merge multiple series into a single array keyed by timestamp.
 * Each entry has `timestamp` plus one field per series index: `s0`, `s1`, ...
 *
 * Series may have very different cadences (e.g. 1 Hz GPU power vs a PDU
 * reading that updates once every ~50 s). The chart x-axis is anchored to
 * [tEnd - CHART_WINDOW_MS, tEnd] via an explicit XAxis domain, so we don't
 * need to extrapolate any padding here — just merge the real points that
 * fall inside the window and let recharts position them numerically.
 */
export function mergeSeries(
  seriesList: ChartSeries[],
  tStart: number,
  tEnd: number,
): Array<Record<string, number>> {
  const map = new Map<number, Record<string, number>>()
  for (let si = 0; si < seriesList.length; si++) {
    for (const pt of seriesList[si].data) {
      if (pt.timestamp < tStart || pt.timestamp > tEnd) continue
      let row = map.get(pt.timestamp)
      if (!row) {
        row = { timestamp: pt.timestamp }
        map.set(pt.timestamp, row)
      }
      row[`s${si}`] = pt.value
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

export const TimeSeriesChart = React.memo(function TimeSeriesChart({
  data,
  series,
  events,
  requests,
  color,
  yDomain,
  unit,
  height = 160,
  title,
  className,
  fillHeight,
}: TimeSeriesChartProps) {
  const isMulti = series && series.length > 0

  // Anchor the x-axis to a fixed 5-minute window ending at the latest
  // observed sample. Falling back to `Date.now()` on a fully empty chart
  // keeps tick labels current instead of rendering at the Unix epoch.
  const observedEnd = latestTimestamp(data, series)
  const tEnd = observedEnd > 0 ? observedEnd : Date.now()
  const tStart = tEnd - CHART_WINDOW_MS

  // Build chart config and data depending on mode
  let chartData: Array<Record<string, number>>
  let chartConfig: Record<string, { label: string; color: string }>
  let lineKeys: Array<{ key: string; color: string; axis: 'left' | 'right' }>

  if (isMulti) {
    chartData = mergeSeries(series, tStart, tEnd)
    chartConfig = {}
    lineKeys = []
    for (let i = 0; i < series.length; i++) {
      const key = `s${i}`
      chartConfig[key] = { label: series[i].label, color: series[i].color }
      lineKeys.push({ key, color: series[i].color, axis: series[i].axis ?? 'left' })
    }
  } else {
    const lineColor = color ?? NVIDIA_THEME.chartLine
    const clamped = clampSingleSeries(data ?? [], tStart, tEnd)
    chartData = clamped.map((d) => ({ timestamp: d.timestamp, value: d.value }))
    chartConfig = { value: { label: unit ?? '', color: lineColor } }
    lineKeys = [{ key: 'value', color: lineColor, axis: 'left' }]
  }
  const hasRightAxis = lineKeys.some((l) => l.axis === 'right')
  // Tight y-axis width so the plot area sits close to the card's left
  // edge — keeps chart lines roughly aligned with the title/legend above.
  const Y_AXIS_WIDTH = 32

  return (
    <div className={cn(fillHeight && 'flex flex-col h-full min-h-0', className)}>
      {/* Header band: title left, legend right — always a single row.
          Legend stays inline (flex-nowrap, no internal wrapping) so it
          sits beside the title even in narrow chart cells. The title
          truncates if the row gets tight rather than pushing the legend
          onto a second line below. */}
      <div className="flex items-center justify-between gap-2 mb-1 min-h-[1.25rem]">
        <h3 className="text-xs font-medium text-zinc-500 truncate min-w-0">
          {title}
        </h3>
        {isMulti && (
          <div className="flex items-center gap-2 flex-nowrap shrink-0">
            {series.map((s, i) => (
              <div key={i} className="flex items-center gap-1 whitespace-nowrap">
                <span
                  className="inline-block w-2 h-[2px] rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-[10px] text-zinc-500">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <ChartContainer
        config={chartConfig}
        style={fillHeight ? undefined : { height: typeof height === 'number' ? `${height}px` : height }}
        className={cn('w-full', fillHeight && 'flex-1 min-h-0')}
      >
        <LineChart data={chartData}>
          <CartesianGrid
            stroke={NVIDIA_THEME.chartGrid}
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={[tStart, tEnd]}
            scale="time"
            stroke={NVIDIA_THEME.chartAxis}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTime}
            minTickGap={60}
            allowDataOverflow
          />
          <YAxis
            yAxisId="left"
            width={Y_AXIS_WIDTH}
            stroke={NVIDIA_THEME.chartAxis}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            domain={yDomain ?? [0, 'auto']}
            // Anchor every chart to 0 visually. Recharts' default
            // `interval="preserveEnd"` drops the first (0) tick when the
            // plot area is short — e.g. on narrower viewports where the
            // hardware-card charts compress vertically. `preserveStartEnd`
            // keeps both the 0 and max labels regardless.
            interval="preserveStartEnd"
          />
          {hasRightAxis && (
            <YAxis
              yAxisId="right"
              width={Y_AXIS_WIDTH}
              orientation="right"
              stroke={NVIDIA_THEME.chartAxis}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              domain={[0, 'auto']}
              interval="preserveStartEnd"
            />
          )}
          <ChartTooltip content={<ChartTooltipContent />} />
          {requests?.map((req, i) => (
            <ReferenceArea
              key={`req-${i}`}
              yAxisId="left"
              x1={req.start}
              x2={req.end}
              fill={NVIDIA_THEME.accent}
              fillOpacity={0.15}
            />
          ))}
          {events?.map((evt, i) => (
            <ReferenceLine
              key={`evt-${i}`}
              yAxisId="left"
              x={evt.timestamp}
              stroke={eventStrokeColor(evt.type)}
              strokeDasharray="4 4"
              strokeWidth={2}
              label={{
                value: evt.type.charAt(0).toUpperCase(),
                position: 'top',
                fill: '#fafafa',
                fontSize: 10,
              }}
            />
          ))}
          {lineKeys.map(({ key, color: c, axis }) => (
            <Line
              key={key}
              yAxisId={axis}
              type="monotone"
              dataKey={key}
              stroke={c}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  )
})
