/**
 * Adapted from React Bits StatusMark (David Haz, 2026), MIT + Commons Clause.
 * Upstream revision and original hashes: manifest.json. Full terms: LICENSE.md.
 * App adaptation: controlled CSS geometry, no Motion/progress/strike/English label.
 */
import type { ReactNode } from 'react'
import './StatusMark.css'

export type StatusMarkStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

const CHECK = 'M7.5 12.25 10.5 15.25 16.75 8.75'
const CROSS = 'M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5'
const C = 2 * Math.PI * 9
const P = C / 8

export default function StatusMark({ status, label, active = false, paused = false }: {
  status: StatusMarkStatus
  label: ReactNode
  active?: boolean
  paused?: boolean
}): ReactNode {
  const solid = status === 'running' || status === 'done' || status === 'failed' || paused
  const arc = status === 'running' ? 0.68 : 1
  return (
    <span className="status-mark" data-status={status} data-indeterminate={active && status === 'running' ? '' : undefined} data-paused={paused ? '' : undefined}>
      <svg className="status-mark__glyph" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle className="status-mark__track" cx="12" cy="12" r="9" />
        <circle className="status-mark__ring" cx="12" cy="12" r="9" strokeDasharray={solid ? `${arc * C} ${(1 - arc) * C}` : `${0.3 * P} ${0.7 * P}`} />
        <path className="status-mark__check" d={CHECK} pathLength="1" />
        <path className="status-mark__cross" d={CROSS} pathLength="1" />
        <path className="status-mark__pause" d="M10 8.5v7M14 8.5v7" />
      </svg>
      <span className="status-mark__label">{label}</span>
    </span>
  )
}
