import { ArcGauge, type GaugeSegment } from '@/components/gauges/ArcGauge'
import { CoreHeatmap } from '@/components/charts/CoreHeatmap'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { EngineSection } from '@/components/engines/EngineSection'
import { THRESHOLDS } from '@/lib/theme'
import { formatBytes, formatGiB, formatMhz, formatRate } from '@/lib/format'
import type { MetricsSnapshot } from '@/types/metrics'
import type { GpuEvent, InferenceRequest } from '@/types/events'

interface DashboardProps {
  metrics: MetricsSnapshot | null
  history: {
    getChartData: (metric: string) => Array<{ timestamp: number; value: number }>
    getSparklineData: (metric: string, count?: number) => number[]
  }
  events: GpuEvent[]
  requests: InferenceRequest[]
}

function HwCard({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111115] rounded-md sm:rounded-lg border border-white/[0.04] px-1.5 pt-1 pb-0.5 lg:px-2 lg:pt-1.5 lg:pb-1 2xl:px-2.5 2xl:pt-2 2xl:pb-1.5 flex flex-col min-h-0 min-w-0 overflow-hidden transition-colors duration-200 hover:border-[#76B900]/10">
      {(title || subtitle) && (
        <div className="mb-0.5 2xl:mb-1 flex items-baseline gap-1.5 min-w-0 shrink-0">
          {title && <span className="text-[10px] lg:text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-200 tracking-tight shrink-0">{title}</span>}
          {title && subtitle && <span className="text-zinc-600 shrink-0 hidden lg:inline">·</span>}
          {subtitle && <span className="hidden lg:inline text-[10px] 2xl:text-[11px] min-[1920px]:text-xs text-zinc-400 truncate min-w-0" title={subtitle}>{subtitle}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

/** Shared responsive height for hardware mini-charts and gauges.
 *  Aggressive lower bounds keep the heatmap and memory split visible on
 *  cramped screens (13" laptops); upper bounds let big monitors breathe. */
const HW_CHART_HEIGHT = 'clamp(28px, 7vh, 140px)'
const HW_GAUGE_PX = 'clamp(36px, 5vw, 96px)'

export function Dashboard({
  metrics,
  history,
  events,
  requests,
}: DashboardProps) {
  if (!metrics) return null

  const powerPercent = (metrics.gpu.power_watts !== null && metrics.gpu.power_limit_watts !== null && metrics.gpu.power_limit_watts > 0)
    ? (metrics.gpu.power_watts / metrics.gpu.power_limit_watts) * 100
    : 0

  const gpuUsed = metrics.memory.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, metrics.memory.used_bytes - gpuUsed)
  const freeAndCached = metrics.memory.available_bytes
  const memTotal = metrics.memory.total_bytes
  const totalGB = formatGiB(metrics.memory.display_total_bytes ?? metrics.memory.total_bytes)

  // Memory tile colours — shared by the segmented dial and the multi-series
  // chart so the legend on the chart reads against both visuals.
  const MEM_GPU_COLOR = '#76B900'
  const MEM_CPU_COLOR = '#3B82F6'
  const MEM_FREE_COLOR = '#71717A'

  const memorySegments: GaugeSegment[] = [
    { value: gpuUsed, total: memTotal, color: MEM_GPU_COLOR, label: 'GPU' },
    { value: cpuUsed, total: memTotal, color: MEM_CPU_COLOR, label: 'CPU' },
    { value: freeAndCached, total: memTotal, color: MEM_FREE_COLOR, label: 'Free' },
  ]

  const allEvents = events.map(e => ({
    timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
  }))
  const requestSpans = requests.map(r => ({
    start: r.start_ms, end: r.end_ms, tps: r.tps, ttft: r.ttft_ms,
  }))

  // Compute totals as sum of two series, aligned by timestamp.
  const sumSeries = (
    a: Array<{ timestamp: number; value: number }>,
    b: Array<{ timestamp: number; value: number }>,
  ): Array<{ timestamp: number; value: number }> => {
    const map = new Map<number, number>()
    for (const p of a) map.set(p.timestamp, p.value)
    for (const p of b) map.set(p.timestamp, (map.get(p.timestamp) ?? 0) + p.value)
    return Array.from(map.entries())
      .sort((x, y) => x[0] - y[0])
      .map(([timestamp, value]) => ({ timestamp, value }))
  }

  const diskRead = history.getChartData('diskRead')
  const diskWrite = history.getChartData('diskWrite')
  const diskTotal = sumSeries(diskRead, diskWrite)
  const networkRx = history.getChartData('networkRx')
  const networkTx = history.getChartData('networkTx')
  const networkTotal = sumSeries(networkRx, networkTx)

  const DISK_READ_COLOR = '#76B900'
  const DISK_WRITE_COLOR = '#F59E0B'
  const TOTAL_COLOR = '#A1A1AA'
  const NET_RX_COLOR = '#3B82F6'
  const NET_TX_COLOR = '#A855F7'

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {/* ── Hardware Overview — fills the rest of the viewport ── */}
      <div className="flex-1 min-h-0 bg-[#0a0a0d]/80 rounded-xl border border-white/[0.03] p-1 lg:p-1.5 2xl:p-2 flex flex-col">
        <div className="flex-1 min-h-0 grid grid-cols-2 sm:grid-cols-4 gap-1 lg:gap-1.5 auto-rows-fr">

          {/* GPU Utilization */}
          <HwCard title="GPU Utilization" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <ArcGauge value={metrics.gpu.utilization_percent ?? 0} label="GPU Util" unit="%" size={HW_GAUGE_PX} />
              <div className="flex-1 min-w-0">
                <TimeSeriesChart data={history.getChartData('gpuUtil')} yDomain={[0, 100]} unit="%" events={allEvents} requests={requestSpans} height={HW_CHART_HEIGHT} />
              </div>
            </div>
          </HwCard>

          {/* GPU Temperature */}
          <HwCard title="GPU Temp" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <ArcGauge value={metrics.gpu.temperature_celsius ?? 0} label="GPU Temp" unit="°C" thresholds={THRESHOLDS.gpuTemp} size={HW_GAUGE_PX} />
              <div className="flex-1 min-w-0">
                <TimeSeriesChart data={history.getChartData('gpuTemp')} yDomain={[0, 100]} unit="°C" height={HW_CHART_HEIGHT} />
              </div>
            </div>
          </HwCard>

          {/* GPU Power */}
          <HwCard title="GPU Power" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <ArcGauge
                value={powerPercent}
                label="GPU Power"
                unit="W"
                thresholds={THRESHOLDS.gpuPower}
                displayValue={metrics.gpu.power_watts !== null ? Math.round(metrics.gpu.power_watts) : 0}
                size={HW_GAUGE_PX}
              />
              <div className="flex-1 min-w-0">
                <TimeSeriesChart data={history.getChartData('gpuPower')} unit="W" height={HW_CHART_HEIGHT} />
              </div>
            </div>
          </HwCard>

          {/* GPU Clock */}
          <HwCard title="GPU Clock" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <div className="flex flex-col items-center justify-center shrink-0" style={{ width: HW_GAUGE_PX, height: HW_GAUGE_PX }}>
                <span className="text-sm 2xl:text-base min-[1920px]:text-lg font-bold text-zinc-100 font-mono">{formatMhz(metrics.gpu.clock_graphics_mhz)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <TimeSeriesChart data={history.getChartData('gpuClockGraphics')} unit="MHz" height={HW_CHART_HEIGHT} />
              </div>
            </div>
          </HwCard>

          {/* CPU */}
          <HwCard title="CPU" subtitle={metrics.cpu.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <ArcGauge value={metrics.cpu.aggregate_percent} label="CPU" unit="%" thresholds={THRESHOLDS.cpuUsage} size={HW_GAUGE_PX} />
              <div className="flex-1 min-w-0">
                <TimeSeriesChart data={history.getChartData('cpuAggregate')} yDomain={[0, 100]} unit="%" height={HW_CHART_HEIGHT} />
              </div>
            </div>
            {metrics.cpu.per_core.length > 0 && <CoreHeatmap cores={metrics.cpu.per_core} />}
          </HwCard>

          {/* Memory */}
          <HwCard title="Memory" subtitle={`${totalGB} Unified`}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <ArcGauge
                label="Memory"
                unit="%"
                segments={memorySegments}
                size={HW_GAUGE_PX}
                hideSegmentLegend
              />
              <div className="flex-1 min-w-0">
                <TimeSeriesChart
                  series={[
                    { data: history.getChartData('memoryGpuPercent'), label: `GPU ${formatBytes(gpuUsed)}`, color: MEM_GPU_COLOR },
                    { data: history.getChartData('memoryCpuPercent'), label: `CPU ${formatBytes(cpuUsed)}`, color: MEM_CPU_COLOR },
                    { data: history.getChartData('memoryFreePercent'), label: `Free ${formatBytes(freeAndCached)}`, color: MEM_FREE_COLOR },
                  ]}
                  yDomain={[0, 100]}
                  unit="%"
                  height={HW_CHART_HEIGHT}
                />
              </div>
            </div>
          </HwCard>

          {/* Disk I/O */}
          <HwCard title="Disk I/O" subtitle={metrics.disk.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <div className="flex flex-col items-center justify-center gap-0.5 shrink-0" style={{ width: HW_GAUGE_PX, height: HW_GAUGE_PX }}>
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">R</span>
                  <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.disk.read_bytes_per_sec)}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">W</span>
                  <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.disk.write_bytes_per_sec)}</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <TimeSeriesChart
                  series={[
                    { data: diskTotal, label: 'Total', color: TOTAL_COLOR },
                    { data: diskRead, label: 'Read', color: DISK_READ_COLOR },
                    { data: diskWrite, label: 'Write', color: DISK_WRITE_COLOR },
                  ]}
                  unit="B/s"
                  height={HW_CHART_HEIGHT}
                />
              </div>
            </div>
          </HwCard>

          {/* Network I/O */}
          <HwCard title="Network" subtitle={metrics.network.name ?? undefined}>
            <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
              <div className="flex flex-col items-center justify-center gap-0.5 shrink-0" style={{ width: HW_GAUGE_PX, height: HW_GAUGE_PX }}>
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">RX</span>
                  <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.network.rx_bytes_per_sec)}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">TX</span>
                  <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.network.tx_bytes_per_sec)}</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <TimeSeriesChart
                  series={[
                    { data: networkTotal, label: 'Total', color: TOTAL_COLOR },
                    { data: networkRx, label: 'RX', color: NET_RX_COLOR },
                    { data: networkTx, label: 'TX', color: NET_TX_COLOR },
                  ]}
                  unit="B/s"
                  height={HW_CHART_HEIGHT}
                />
              </div>
            </div>
          </HwCard>

        </div>
      </div>

      {/* ── LLM Engines — auto-height, fits content; hardware fills remainder ── */}
      <div className="shrink-0 min-h-0">
        <EngineSection
          engines={metrics.engines}
          showCharts={true}
          getChartData={history.getChartData}
          requests={requests}
        />
      </div>
    </div>
  )
}
