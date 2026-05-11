import { useMemo, useState } from 'react'
import { useMetrics } from './hooks/useMetrics'
import { useMetricsHistory } from './hooks/useMetricsHistory'
import { ConnectionBadge } from './components/ConnectionBadge'
import { Dashboard } from './components/views/Dashboard'
import type { GpuEvent, InferenceRequest } from './types/events'

function App() {
  const { metrics, connectionStatus, isStale } = useMetrics()
  const [showHeader, setShowHeader] = useState(false)

  const history = useMetricsHistory(metrics)

  const { getEvents, getRequests } = history

  const events = useMemo((): GpuEvent[] =>
    getEvents().map((e) => ({
      timestamp_ms: e.timestamp_ms,
      event_type: e.event_type as GpuEvent['event_type'],
      detail: e.detail,
    })),
    [getEvents],
  )

  const requests = useMemo((): InferenceRequest[] =>
    getRequests().map((r) => ({
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      tps: r.tokens_per_sec,
      ttft_ms: r.ttft_ms,
    })),
    [getRequests],
  )

  return (
    <div className="h-dvh flex flex-col bg-[#08080a] overflow-hidden relative">
      {/* Header is absolutely positioned and slides in on hover over the top
       *  edge of the viewport, so the dashboard can use the full height. The
       *  wrapper height is just the trigger strip (24px) when hidden, then
       *  expands to fit the header so the mouse can move into it. */}
      <div
        className="absolute top-0 left-0 right-0 z-50 overflow-hidden"
        style={{ height: showHeader ? 'auto' : '24px' }}
        onMouseEnter={() => setShowHeader(true)}
        onMouseLeave={() => setShowHeader(false)}
        aria-label="Reveal header"
      >
        <header
          className={`border-b border-white/[0.04] bg-[#08080a]/95 backdrop-blur px-4 py-1.5 flex justify-between items-center transition-transform duration-200 ${showHeader ? 'translate-y-0' : '-translate-y-full'}`}
        >
          <h1 className="text-xl font-semibold text-zinc-100 tracking-tight" style={{ fontFamily: 'Inter, sans-serif' }}>
            <span className="text-[#76B900]">Spark</span>{' '}
            <span className="text-zinc-500 font-normal">Dashboard</span>
          </h1>
          <ConnectionBadge status={connectionStatus} isStale={isStale} />
        </header>
      </div>

      <main className={`flex-1 min-h-0 flex flex-col p-3 lg:p-4 2xl:p-5 min-[1920px]:p-6 ${isStale ? 'opacity-50' : ''}`}>
        {!metrics && connectionStatus !== 'connected' && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-xl font-bold text-zinc-50 mb-2">Waiting for metrics</h2>
              <p className="text-zinc-400">
                Connecting to the metrics server at {window.location.origin}. Make sure spark-dashboard is running.
              </p>
            </div>
          </div>
        )}

        <Dashboard
          metrics={metrics}
          history={history}
          events={events}
          requests={requests}
        />
      </main>
    </div>
  )
}

export default App
