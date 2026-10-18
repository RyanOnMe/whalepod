/** React Bits SpringCheck, adapted for WhalePod. See LICENSE.md / manifest.json. */
import { useState, type ReactNode } from 'react'
import './SpringCheck.css'

/** Native checkbox semantics, fully controlled selection, no completion strike-through. */
export default function SpringCheck({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  className = '',
  testId,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  ariaLabel?: string
  disabled?: boolean
  className?: string
  testId?: string
}): ReactNode {
  const [instant, setInstant] = useState(true)
  return (
    <label
      className={`spring-check ${className}`}
      data-instant={instant ? '' : undefined}
      data-testid={testId}
      onPointerDownCapture={() => setInstant(false)}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onKeyDown={() => setInstant(true)}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="spring-check__box" aria-hidden="true">
        <span className="spring-check__fill" />
        <svg className="spring-check__tick" viewBox="0 0 24 24">
          <path d="m5 12 4 4L19 6" pathLength="1" />
        </svg>
      </span>
      <span className="spring-check__label">{label}</span>
    </label>
  )
}
