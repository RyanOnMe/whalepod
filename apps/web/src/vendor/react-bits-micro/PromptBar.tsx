/** React Bits PromptBar, adapted for WhalePod. See LICENSE.md / manifest.json. */
import type { ReactNode } from 'react'
import './PromptBar.css'

/** Presentation slots only. The host retains its form, draft, permission and submit path. */
export default function PromptBar({
  children,
  controls,
  action,
}: {
  children: ReactNode
  controls?: ReactNode
  action: ReactNode
}): ReactNode {
  return (
    <div className="prompt-bar" data-testid="prompt-bar">
      <div className="prompt-bar__field">{children}</div>
      <div className="prompt-bar__bar">
        <div className="prompt-bar__controls">{controls}</div>
        <div className="prompt-bar__send">{action}</div>
      </div>
    </div>
  )
}
