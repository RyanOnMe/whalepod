import type { ReactNode } from 'react'
import { MotionDisclosure } from './MotionDisclosure.js'

/** Low-frequency guidance stays reachable without competing with the current action. */
export function HelpDisclosure({
  label = '了解更多',
  children,
}: {
  label?: string
  children: ReactNode
}) {
  return (
    <MotionDisclosure label={label} className="help-disclosure">
      <div className="help-disclosure-content">{children}</div>
    </MotionDisclosure>
  )
}
