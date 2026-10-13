/**
 * Adapted from React Bits CallChip (David Haz, 2026), MIT + Commons Clause.
 * Upstream revision and original hashes: manifest.json. Full terms: LICENSE.md.
 * App adaptation: passive fact display; no clock, expected progress, shake or retry.
 * Icons are supplied by the host instead of importing a second icon library.
 */
import type { ReactNode } from 'react'
import './CallChip.css'

export type CallChipStatus = 'running' | 'done' | 'error' | 'cancelled' | 'paused' | 'unknown'

export default function CallChip({ name, status, label, icon, doneIcon, errorIcon }: {
  name: string
  status: CallChipStatus
  label: string
  icon: ReactNode
  doneIcon: ReactNode
  errorIcon: ReactNode
}): ReactNode {
  const glyph = status === 'done' ? 'check' : status === 'error' || status === 'cancelled' ? 'error' : 'tool'
  return (
    <span className="call-chip" data-status={status} data-testid="tool-call-chip">
      <span className="call-chip__fill" aria-hidden="true" />
      <span className="call-chip__slot" aria-hidden="true">
        <span className="call-chip__glyph" data-state={glyph === 'tool' ? 'in' : undefined}>{icon}</span>
        <span className="call-chip__glyph" data-state={glyph === 'check' ? 'in' : undefined}>{doneIcon}</span>
        <span className="call-chip__glyph" data-state={glyph === 'error' ? 'in' : undefined}>{errorIcon}</span>
      </span>
      <span className="call-chip__name" title={name}>工具开始：{name}</span>
      <span className="call-chip__arg">{label}</span>
    </span>
  )
}
