/** React Bits ThoughtLine, adapted for WhalePod. See LICENSE.md / manifest.json. */
import type { ReactNode } from 'react'
import './ThoughtLine.css'

/** Controlled public activity summary. No trace, timer, auto-settle or local state. */
export default function ThoughtLine({
  label,
  working,
}: {
  label: string
  working: boolean
}): ReactNode {
  return (
    <div
      className="thought-line"
      data-testid="run-activity"
      data-working={working ? '' : undefined}
    >
      <div className="thought-line__head" role="status">
        <span className="thought-line__glyph" aria-hidden="true">
          <span className="thought-line__dot" />
        </span>
        <span className="thought-line__label">
          <span className="thought-line__text" data-active="">
            <span className="thought-line__breath">{label}</span>
          </span>
        </span>
      </div>
    </div>
  )
}
