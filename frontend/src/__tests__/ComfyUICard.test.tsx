import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ComfyUICard, formatAgo } from '../components/engines/ComfyUICard'
import type { ComfyUIState } from '../types/comfyui'

const BASE: ComfyUIState = {
  connectionStatus: 'connected',
  error: null,
  queueRemaining: 0,
  running: [],
  pending: [],
  history: [],
  totalCompleted: 0,
  totalErrors: 0,
  progress: null,
  upstreamHost: 'localhost:8188',
}

describe('formatAgo', () => {
  it('rounds tiny deltas to "just now"', () => {
    expect(formatAgo(1_000_000, 1_001_000)).toBe('just now')
  })
  it('formats seconds, minutes, hours, days', () => {
    expect(formatAgo(0, 10_000)).toBe('10s ago')
    expect(formatAgo(0, 120_000)).toBe('2m ago')
    expect(formatAgo(0, 3 * 3600_000)).toBe('3h ago')
    expect(formatAgo(0, 2 * 86_400_000)).toBe('2d ago')
  })
  it('clamps negative deltas to "just now"', () => {
    expect(formatAgo(2_000, 1_000)).toBe('just now')
  })
})

describe('ComfyUICard', () => {
  it('renders the server-side reachability hint when disconnected', () => {
    render(
      <ComfyUICard
        state={{
          ...BASE,
          connectionStatus: 'disconnected',
          error: 'HTTP 502 Bad Gateway',
          upstreamHost: 'comfy.example.com:8188',
        }}
      />,
    )
    expect(screen.getByText('ComfyUI not reachable')).toBeDefined()
    // The hint blames the dashboard server (not the browser) and points at
    // the SPARK_DASHBOARD_COMFYUI_URL override.
    expect(screen.getByText(/dashboard server/)).toBeDefined()
    expect(screen.getByText(/SPARK_DASHBOARD_COMFYUI_URL/)).toBeDefined()
    expect(screen.getByText('comfy.example.com:8188')).toBeDefined()
    expect(screen.getByText(/HTTP 502 Bad Gateway/)).toBeDefined()
  })

  it('shows idle messaging when connected with empty queue and history', () => {
    render(<ComfyUICard state={BASE} />)
    expect(screen.getByText('No jobs executing.')).toBeDefined()
    expect(screen.getByText('Nothing queued.')).toBeDefined()
    expect(screen.getByText('No completed jobs yet.')).toBeDefined()
  })

  it('renders the running prompt row when a job is executing', () => {
    const state: ComfyUIState = {
      ...BASE,
      queueRemaining: 1,
      running: [
        {
          number: 42,
          promptId: 'abcd1234-ef',
          nodeCount: 5,
          outputNodeCount: 1,
          primaryNodeTypes: ['KSampler', 'CheckpointLoaderSimple'],
          modelName: 'sdxl.safetensors',
          queuedAtMs: Date.now() - 30_000,
          startedAtMs: Date.now() - 10_000,
        },
      ],
    }
    render(<ComfyUICard state={state} />)
    expect(screen.getByText('#42')).toBeDefined()
    expect(screen.getByText('sdxl.safetensors')).toBeDefined()
    expect(screen.getByText(/started \d+s ago/)).toBeDefined()
  })

  it('renders pending and recent history entries with timestamps', () => {
    const now = Date.now()
    const state: ComfyUIState = {
      ...BASE,
      queueRemaining: 1,
      pending: [
        {
          number: 43,
          promptId: 'pending-id',
          nodeCount: 6,
          outputNodeCount: 1,
          primaryNodeTypes: ['CLIPTextEncode'],
          modelName: null,
          queuedAtMs: now - 45_000,
          startedAtMs: null,
        },
      ],
      history: [
        {
          promptId: 'hist-1',
          number: 41,
          status: 'success',
          completed: true,
          outputImageCount: 2,
          nodeCount: 5,
          completedAtMs: now - 3 * 60_000,
        },
        {
          promptId: 'hist-2',
          number: 40,
          status: 'error',
          completed: false,
          outputImageCount: 0,
          nodeCount: 5,
          completedAtMs: now - 10 * 60_000,
        },
      ],
      totalCompleted: 1,
      totalErrors: 1,
    }
    render(<ComfyUICard state={state} />)
    expect(screen.getByText('#43')).toBeDefined()
    expect(screen.getByText('CLIPTextEncode')).toBeDefined()
    expect(screen.getByText(/queued 45s ago/)).toBeDefined()
    // history rows
    expect(screen.getByText('2 outputs')).toBeDefined()
    expect(screen.getByText('failed')).toBeDefined()
    expect(screen.getByText(/finished 3m ago/)).toBeDefined()
    expect(screen.getByText(/finished 10m ago/)).toBeDefined()
    // error counter in the status panel
    expect(screen.getByText(/\+1 err/)).toBeDefined()
  })

  it('shows queue depth and workflow count in the status panel', () => {
    const now = Date.now()
    const state: ComfyUIState = {
      ...BASE,
      queueRemaining: 3,
      running: [
        {
          number: 10,
          promptId: 'r1',
          nodeCount: 4,
          outputNodeCount: 1,
          primaryNodeTypes: ['KSampler'],
          modelName: null,
          queuedAtMs: now - 1000,
          startedAtMs: now - 500,
        },
      ],
      pending: [
        {
          number: 11,
          promptId: 'p1',
          nodeCount: 4,
          outputNodeCount: 1,
          primaryNodeTypes: ['KSampler'],
          modelName: null,
          queuedAtMs: now - 200,
          startedAtMs: null,
        },
        {
          number: 12,
          promptId: 'p2',
          nodeCount: 4,
          outputNodeCount: 1,
          primaryNodeTypes: ['KSampler'],
          modelName: null,
          queuedAtMs: now - 100,
          startedAtMs: null,
        },
      ],
      totalCompleted: 5,
    }
    render(<ComfyUICard state={state} />)
    // Workflows (3) and Queue (3) both render '3'; assert it appears at
    // least twice and the unique 'Done' count of 5 is present.
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('5')).toBeDefined()
  })
})
