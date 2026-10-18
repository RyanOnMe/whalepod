/** React Bits SquishSwitch, adapted for WhalePod. See LICENSE.md / manifest.json. */
import { useState, type ReactNode } from 'react'
import './SquishSwitch.css'

/** The thumb follows confirmed state; a press only requests a change. */
export default function SquishSwitch({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  busy = false,
  title,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  ariaLabel?: string
  disabled?: boolean
  busy?: boolean
  title?: string
}): ReactNode {
  const [instant, setInstant] = useState(true)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      aria-busy={busy}
      className="squish-switch"
      disabled={disabled || busy}
      title={title}
      data-on={checked ? '' : undefined}
      data-instant={instant ? '' : undefined}
      onPointerDown={() => setInstant(false)}
      onKeyDown={() => setInstant(true)}
      onClick={(event) => {
        setInstant(event.detail === 0)
        onChange(!checked)
      }}
    >
      <span className="squish-switch__track" aria-hidden="true">
        <span className="squish-switch__thumb" />
      </span>
      <span className="squish-switch__label">{label}</span>
    </button>
  )
}
