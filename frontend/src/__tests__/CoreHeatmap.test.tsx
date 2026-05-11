import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoreHeatmap } from '../components/charts/CoreHeatmap'
import type { CoreMetrics } from '../types/metrics'

function makeCores(count: number): CoreMetrics[] {
  return Array.from({ length: count }, (_, id) => ({ id, usage_percent: id * 5 }))
}

describe('CoreHeatmap', () => {
  it('renders Efficiency and Performance section labels', () => {
    render(<CoreHeatmap cores={makeCores(20)} />)
    expect(screen.getByText('Efficiency')).toBeTruthy()
    expect(screen.getByText('Performance')).toBeTruthy()
  })

  it('splits cores so 0–4 and 10–14 go to Efficiency, 5–9 and 15–19 go to Performance', () => {
    const { container } = render(<CoreHeatmap cores={makeCores(20)} />)

    // Two groups: Efficiency and Performance
    const groups = container.querySelectorAll(':scope > div > div > div')
    expect(groups.length).toBe(2)

    const [efficiencyGroup, performanceGroup] = groups
    const efficiencyCells = efficiencyGroup.querySelectorAll('div[style*="background-color"]')
    const performanceCells = performanceGroup.querySelectorAll('div[style*="background-color"]')

    expect(efficiencyCells.length).toBe(10)
    expect(performanceCells.length).toBe(10)
  })

  it('renders both sections even when only one tier has cores', () => {
    render(<CoreHeatmap cores={makeCores(5)} />)
    // 5 cores → all efficiency (ids 0–4), but the Performance label still renders
    expect(screen.getByText('Efficiency')).toBeTruthy()
    expect(screen.getByText('Performance')).toBeTruthy()
  })
})
