import React, { useState, useCallback, useMemo } from 'react'
import type { CoreMetrics } from '@/types/metrics'

interface CoreHeatmapProps {
  cores: CoreMetrics[]
}

function coreColor(usage: number): string {
  if (usage >= 90) return '#ef4444'
  if (usage >= 70) return '#eab308'
  if (usage >= 40) return '#76B900'
  if (usage >= 10) return '#365314'
  return '#27272a'
}

// DGX Spark CPU layout: cores 0–4 and 10–14 are efficiency,
// 5–9 and 15–19 are performance — i.e. id mod 10 < 5 ⇒ efficiency.
function isEfficiencyCore(id: number): boolean {
  return id % 10 < 5
}

export const CoreHeatmap = React.memo(function CoreHeatmap({ cores }: CoreHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ coreId: number; usage: number; x: number; y: number } | null>(null)

  const handleMouseEnter = useCallback((core: CoreMetrics, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTooltip({ coreId: core.id, usage: core.usage_percent, x: rect.left + rect.width / 2, y: rect.top })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  const { efficiency, performance } = useMemo(() => {
    const efficiency: CoreMetrics[] = []
    const performance: CoreMetrics[] = []
    for (const core of cores) {
      if (isEfficiencyCore(core.id)) efficiency.push(core)
      else performance.push(core)
    }
    return { efficiency, performance }
  }, [cores])

  const renderGroup = (label: string, group: CoreMetrics[]) => {
    // Wide grid: more columns = fewer rows = less vertical space
    const cols = Math.max(1, Math.ceil(Math.sqrt(group.length * 4)))
    return (
      <div className="flex-1 min-w-0">
        <div className="text-[8px] lg:text-[9px] font-medium text-zinc-600 mb-0.5 truncate">{label}</div>
        <div
          className="grid w-full"
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: '1px',
          }}
        >
          {group.map((core) => (
            <div
              key={core.id}
              className="h-[6px] lg:h-[10px] 2xl:h-[12px] rounded-[1px] transition-colors duration-300"
              style={{ backgroundColor: coreColor(core.usage_percent) }}
              onMouseEnter={(e) => handleMouseEnter(core, e)}
              onMouseLeave={handleMouseLeave}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="relative shrink-0 mt-0.5 lg:mt-1">
      <div className="flex gap-2 w-full">
        {renderGroup('Efficiency', efficiency)}
        {renderGroup('Performance', performance)}
      </div>
      {tooltip && (
        <div
          className="fixed z-50 bg-[#1a1a1e] border border-white/[0.06] rounded px-2 py-1 text-xs pointer-events-none -translate-x-1/2 -translate-y-full -mt-1"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span className="text-zinc-400">Core {tooltip.coreId}:</span>{' '}
          <span className="text-zinc-100 font-semibold">{Math.round(tooltip.usage)}%</span>
        </div>
      )}
    </div>
  )
})
