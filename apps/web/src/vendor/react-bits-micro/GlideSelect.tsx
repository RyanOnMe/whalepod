/** React Bits GlideSelect, adapted for WhalePod. See LICENSE.md / manifest.json. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './GlideSelect.css'

export interface GlideSelectOption {
  value: string
  label: ReactNode
  disabled: boolean
}

/** Controlled choice; the menu is portaled so a scrolling composer cannot clip it. */
export default function GlideSelect({
  id,
  label,
  value,
  display,
  options,
  onChange,
  disabled = false,
  hintId,
}: {
  id: string
  label: string
  value: string
  display: ReactNode
  onChange: (value: string) => void
  options: readonly GlideSelectOption[]
  disabled?: boolean
  hintId?: string
}): ReactNode {
  const menuId = useId()
  const valueId = `${id}-value`
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(true)
  const [active, setActive] = useState<number | null>(null)
  const [placement, setPlacement] = useState<{
    left: number
    top: number
    width: number
    height: number
    side: 'top' | 'bottom'
  } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const rows = useRef<Array<HTMLButtonElement | null>>([])
  const [glow, setGlow] = useState({ top: 0, height: 40 })
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect === undefined) return
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24)
      const below = Math.max(0, window.innerHeight - rect.bottom - 20)
      const above = Math.max(0, rect.top - 20)
      const wanted = (viewport.current?.scrollHeight ?? options.length * 40) + 12
      const side = below < wanted && above > below ? 'top' : 'bottom'
      const height = Math.min(wanted, side === 'top' ? above : below, 320)
      setPlacement({
        width,
        height,
        side,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: side === 'top' ? Math.max(12, rect.top - height - 6) : rect.bottom + 6,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, options.length])

  // The portal is initially hidden until measured. Browsers reject focus on that
  // hidden frame, so move focus only after its positioned frame is committed.
  const positioned = placement !== null
  useLayoutEffect(() => {
    if (open && positioned) rows.current.find((row) => row !== null && !row.disabled)?.focus()
  }, [open, positioned])

  useLayoutEffect(() => {
    const row = active === null ? null : rows.current[active]
    if (row !== null && row !== undefined) setGlow({ top: row.offsetTop, height: row.offsetHeight })
  }, [active, open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <span
      className="glide-select"
      data-instant={instant ? '' : undefined}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setInstant(true)
          close()
        }
      }}
    >
      <button
        ref={trigger}
        id={id}
        type="button"
        className="glide-select__trigger"
        aria-label={label}
        aria-describedby={[valueId, hintId].filter(Boolean).join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onKeyDown={() => setInstant(true)}
        onClick={(event) => {
          setInstant(event.detail === 0)
          setOpen(!open)
        }}
      >
        <span id={valueId} className="glide-select__label select-menu-value">
          {display}
        </span>
        <svg
          className="glide-select__chevron"
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="m3 4.5 3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={menu}
              id={menuId}
              role="menu"
              aria-label="可用选项"
              className="glide-select__menu"
              data-instant={instant ? '' : undefined}
              data-side={placement?.side ?? 'top'}
              style={
                placement === null
                  ? { visibility: 'hidden' }
                  : {
                      left: placement.left,
                      top: placement.top,
                      width: placement.width,
                      maxHeight: placement.height,
                    }
              }
              onKeyDown={(event) => {
                setInstant(true)
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  close()
                  return
                }
                if (event.key === 'Tab') {
                  close()
                  return
                }
                const enabled = rows.current.filter(
                  (row): row is HTMLButtonElement => row !== null && !row.disabled,
                )
                const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? enabled.length - 1
                      : event.key === 'ArrowDown'
                        ? (index + 1) % enabled.length
                        : event.key === 'ArrowUp'
                          ? (index - 1 + enabled.length) % enabled.length
                          : -1
                if (next >= 0 && enabled.length > 0) {
                  event.preventDefault()
                  enabled[next]?.focus()
                  return
                }
                if (event.key.length === 1 && /\S/.test(event.key)) {
                  const matches =
                    enabled.find(
                      (row, i) =>
                        i > index &&
                        row.textContent?.toLowerCase().startsWith(event.key.toLowerCase()),
                    ) ??
                    enabled.find((row) =>
                      row.textContent?.toLowerCase().startsWith(event.key.toLowerCase()),
                    )
                  if (matches !== undefined) {
                    event.preventDefault()
                    matches.focus()
                  }
                }
              }}
            >
              <div
                ref={viewport}
                className="glide-select__viewport"
                style={{ maxHeight: placement === null ? 308 : Math.max(0, placement.height - 12) }}
              >
                <span
                  className="glide-select__glow"
                  aria-hidden="true"
                  style={{
                    transform: `translateY(${glow.top}px)`,
                    height: glow.height,
                    opacity: active === null ? 0 : 1,
                  }}
                />
                {options.map((option, index) => (
                  <button
                    key={option.value}
                    ref={(node) => {
                      rows.current[index] = node
                    }}
                    type="button"
                    role="menuitem"
                    className="glide-select__row"
                    disabled={option.disabled}
                    aria-current={option.value === value && !option.disabled ? 'true' : undefined}
                    onPointerMove={() => {
                      if (!option.disabled) {
                        setInstant(false)
                        setActive(index)
                      }
                    }}
                    onFocus={() => setActive(index)}
                    onClick={() => {
                      if (!option.disabled && !disabled) {
                        close()
                        onChange(option.value)
                      }
                    }}
                  >
                    <span>{option.label}</span>
                    {option.value === value && !option.disabled ? (
                      <span aria-hidden="true">✓</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
