import { TabsTrigger } from '@/components/ui/tabs'
import type { ComfyUIConnectionStatus } from '@/types/comfyui'

export const COMFYUI_TAB_VALUE = '__comfyui'

interface ComfyUITabProps {
  connectionStatus: ComfyUIConnectionStatus
  queueRemaining: number
  /** Rotation cycle counter — used as `key` so the CSS countdown animation restarts per cycle. */
  cycle?: number
  /** Current cycle duration in ms. `0` disables the countdown animation. */
  intervalMs?: number
  /** `true` when this tab is the active tab AND rotation is enabled. */
  showCountdown?: boolean
}

export function ComfyUITab({
  connectionStatus,
  queueRemaining,
  cycle,
  intervalMs,
  showCountdown,
}: ComfyUITabProps) {
  const isDisconnected = connectionStatus === 'disconnected'
  const showBar = showCountdown === true && typeof intervalMs === 'number' && intervalMs > 0

  return (
    <TabsTrigger
      value={COMFYUI_TAB_VALUE}
      className={`relative flex items-center gap-2.5 px-6 py-4 leading-none rounded-md transition-colors duration-200 min-w-0 !flex-initial hover:bg-white/[0.03] data-[active]:bg-white/[0.05] ${
        isDisconnected ? 'opacity-40' : ''
      } data-[active]:border-b-2 data-[active]:border-[#76B900]`}
      aria-label={`ComfyUI · ${connectionStatus} · ${queueRemaining} queued`}
    >
      <span
        className={`text-xs font-semibold tracking-tight leading-none truncate min-w-0 ${
          isDisconnected ? 'text-zinc-600' : 'text-zinc-200'
        }`}
      >
        ComfyUI
      </span>
      {queueRemaining > 0 && (
        <span
          aria-hidden="true"
          className="text-[10px] font-mono font-semibold text-[#76B900] bg-[#76B900]/10 rounded px-1.5 py-0.5 leading-none"
        >
          {queueRemaining}
        </span>
      )}
      {showBar && (
        <span
          key={cycle}
          aria-hidden="true"
          className="tab-rotation-bar absolute left-0 bottom-0 h-0.5 w-full bg-[#76B900]/70"
          style={{ ['--rotation-duration' as string]: `${intervalMs}ms` }}
        />
      )}
    </TabsTrigger>
  )
}
