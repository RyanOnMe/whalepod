import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStateCore } from '../src/vendor/collectui/collectui.js'
afterEach(cleanup)
describe('mirrored Agent core presentation', () => {
  it('reflects distinct real phases and stops immediately at approval and completion', () => {
    const { rerender } = render(<AgentStateCore state="thinking" active />)
    const core = screen.getByTestId('agent-state-core')
    expect(core.dataset.state).toBe('thinking')
    expect(core).toHaveAttribute('data-active')
    for (const state of ['tool', 'finalizing']) {
      rerender(<AgentStateCore state={state} active />)
      expect(core.dataset.state).toBe(state)
    }
    rerender(<AgentStateCore state="approval" active={false} />)
    expect(core).not.toHaveAttribute('data-active')
    expect(core.dataset.state).toBe('approval')
    rerender(<AgentStateCore state="completed" active={false} />)
    expect(core).not.toHaveAttribute('data-active')
    expect(core.dataset.state).toBe('completed')
  })
  it('keeps historical completion still and provides an equivalent no-WebGL presentation', () => {
    render(<AgentStateCore state="completed" active={false} />)
    const core = screen.getByTestId('agent-state-core')
    expect(core).toHaveAttribute('aria-hidden', 'true')
    expect(core).not.toHaveAttribute('data-completing')
    expect(core).toHaveAttribute('data-renderer', 'fallback')
    expect(core.textContent).not.toMatch(/%|token|listening|speaking/)
  })
})
