import type { ReactNode } from 'react'

/** Low-frequency guidance stays reachable without competing with the current action. */
export function HelpDisclosure({
  label = '了解更多',
  children,
}: {
  label?: string
  children: ReactNode
}) {
  return (
    <details className="help-disclosure">
      <summary>{label}</summary>
      <div className="help-disclosure-content">{children}</div>
    </details>
  )
}
