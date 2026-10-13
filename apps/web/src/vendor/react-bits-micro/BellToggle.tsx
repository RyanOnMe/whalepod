/**
 * Adapted from React Bits BellToggle (David Haz, 2026), MIT + Commons Clause.
 * Upstream revision and original hashes: manifest.json. Full terms: LICENSE.md.
 * App adaptation: the control is fully controlled by its owner (`pressed` / `onChange`) so a
 * click can never look "on" before the real permission result arrives; the ring is a counted
 * receipt (`data-ring`) replayed by a CSS keyframe, no Motion/Hugeicons dependency, no sonar
 * waves, clapper, spring reveal or colour props; the bell glyph is the upstream inline path.
 * The badge shows only the real unread count it is handed.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import './BellToggle.css'

export interface BellToggleProps {
  /** 稳定的无障碍名称（不随开关状态变化）。 */
  label: string
  /** 可见文案：关。 */
  offLabel: string
  /** 可见文案：开。 */
  onLabel: string
  pressed: boolean
  /** 真实未读数；0 或省略时不渲染徽标（不做空徽标）。 */
  count?: number
  /** 真实请求在途：禁止重复触发，但不假装已经开/关。 */
  pending?: boolean
  disabled?: boolean
  onChange: () => void
  className?: string
}

const BELL_BODY = 'M6 16.5V10a6 6 0 0 1 12 0v6.5l1.6 2.3H4.4L6 16.5z'

export default function BellToggle({
  label,
  offLabel,
  onLabel,
  pressed,
  count = 0,
  pending = false,
  disabled = false,
  onChange,
  className = '',
}: BellToggleProps): ReactNode {
  const [ringCount, setRingCount] = useState(0)
  const prev = useRef({ pressed, count })

  useEffect(() => {
    const before = prev.current
    prev.current = { pressed, count }
    // 响铃是事件回执：只有「真的从未开变成已开」或「已开时真的多了一条未读」才响。
    if (pressed && (!before.pressed || count > before.count)) setRingCount((n) => n + 1)
  }, [pressed, count])

  const on = pressed
  return (
    <span
      className={`bell-toggle${className === '' ? '' : ` ${className}`}`}
      data-on={on ? 'true' : 'false'}
      data-ring={ringCount}
      data-pending={pending ? '' : undefined}
    >
      <button
        type="button"
        className="bell-toggle__button"
        aria-pressed={on}
        aria-label={label}
        disabled={disabled || pending}
        onClick={onChange}
      >
        <span className="bell-toggle__bell" aria-hidden="true">
          <span key={ringCount} className="bell-toggle__glyph">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
            >
              <path d={BELL_BODY} />
            </svg>
          </span>
          {count > 0 ? (
            <span className="bell-toggle__badge" data-testid="bell-badge" aria-hidden="true">
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </span>
        <span className="bell-toggle__say" aria-hidden="true">
          <span className="bell-toggle__face" data-face="off">
            {offLabel}
          </span>
          <span className="bell-toggle__face" data-face="on">
            {onLabel}
          </span>
        </span>
      </button>
    </span>
  )
}
