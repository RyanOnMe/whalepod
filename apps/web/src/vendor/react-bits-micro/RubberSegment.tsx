/** React Bits RubberSegment, adapted for WhalePod. See LICENSE.md / manifest.json. */
import { useState, type ReactNode } from 'react'
import './RubberSegment.css'

/** Native filter buttons, with a controlled indicator. No drag, momentum or radio/tab semantics. */
export default function RubberSegment<Value extends string>({
  items,
  value,
  onChange,
  label,
  testIdPrefix,
}: {
  items: ReadonlyArray<{ value: Value; label: ReactNode }>
  value: Value
  onChange: (value: Value) => void
  label: string
  testIdPrefix: string
}): ReactNode {
  const [instant, setInstant] = useState(true)
  const index = items.findIndex((item) => item.value === value)
  return (
    <div
      className="rubber-segment"
      role="group"
      aria-label={label}
      data-instant={instant ? '' : undefined}
    >
      <span
        className="rubber-segment__thumb"
        aria-hidden="true"
        style={{ width: `${100 / items.length}%`, transform: `translateX(${index * 100}%)` }}
      />
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`rubber-segment__item cf${item.value === value ? ' on' : ''}`}
          aria-pressed={item.value === value}
          data-testid={`${testIdPrefix}${item.value}`}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') setInstant(true)
          }}
          onClick={(event) => {
            setInstant(event.detail === 0)
            onChange(item.value)
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
