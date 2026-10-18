import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

/** Native trigger with light dismissal; portal fields stay mounted while hidden. */
export function DisclosurePanel({
  label,
  icon,
  children,
  className = '',
  defaultOpen = false,
  panelRef,
  open,
  onOpenChange,
  portal = false,
  contentLabel = '更多选项',
  disabled = false,
}: {
  label: string
  icon: ReactNode
  children: ReactNode
  className?: string
  defaultOpen?: boolean
  panelRef?: RefObject<HTMLDetailsElement | null>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  portal?: boolean
  contentLabel?: string
  disabled?: boolean
}) {
  const localRef = useRef<HTMLDetailsElement>(null)
  const ref = panelRef ?? localRef
  const panel = useRef<HTMLDivElement>(null)
  const insidePointer = useRef<Event | null>(null)
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const actualOpen = open ?? localOpen
  const panelId = useId()
  const [placement, setPlacement] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const changed = (value: boolean) => {
    setLocalOpen(value)
    onOpenChange?.(value)
  }
  const close = (focus = false) => {
    if (ref.current) ref.current.open = false
    changed(false)
    if (focus) ref.current?.querySelector('summary')?.focus()
  }
  useEffect(() => {
    if (disabled && actualOpen && panel.current?.contains(document.activeElement))
      ref.current?.querySelector('summary')?.focus()
  }, [disabled, actualOpen])
  useLayoutEffect(() => {
    if (!portal || !actualOpen) {
      setPlacement(null)
      return
    }
    const place = () => {
      const rect = ref.current?.querySelector('summary')?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(360, window.innerWidth - 24)
      const height = Math.min(panel.current?.scrollHeight ?? 480, window.innerHeight - 32, 480)
      const above = rect.top - 12
      const below = window.innerHeight - rect.bottom - 12
      const top =
        above >= height || above > below
          ? Math.max(12, rect.top - height - 8)
          : Math.min(window.innerHeight - height - 12, rect.bottom + 8)
      setPlacement({
        width,
        height,
        top,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [actualOpen, portal, children])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        ref.current?.open &&
        event !== insidePointer.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  })
  const focusables = () =>
    [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
      ) ?? []),
    ].filter((element) => {
      if (element.matches(':disabled') || element.closest('[hidden]')) return false
      for (
        let ancestor = element.parentElement;
        ancestor && ancestor !== panel.current;
        ancestor = ancestor.parentElement
      ) {
        if (
          ancestor instanceof HTMLDetailsElement &&
          !ancestor.open &&
          !ancestor.querySelector('summary')?.contains(element)
        )
          return false
      }
      return true
    })
  const contents = (
    <div
      ref={panel}
      id={panelId}
      className={portal ? 'composer-settings-popover' : 'disclosure-panel__content'}
      {...(portal
        ? {
            hidden: !actualOpen,
            'data-settings-panel': '',
            role: 'region',
            'aria-label': contentLabel,
            style:
              placement === null
                ? { visibility: 'hidden' as const }
                : {
                    left: placement.left,
                    top: placement.top,
                    width: placement.width,
                    maxHeight: placement.height,
                  },
          }
        : {})}
      onKeyDown={(event) => {
        // A nested portaled menu owns its keys (DSH handles Escape on document).
        if (!portal || !(event.target instanceof Node) || !panel.current?.contains(event.target))
          return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close(true)
          return
        }
        if (event.key === 'Tab') {
          const items = focusables()
          if (event.shiftKey && document.activeElement === items[0]) {
            event.preventDefault()
            close(true)
          } else if (!event.shiftKey && document.activeElement === items.at(-1)) close(true)
        }
      }}
    >
      {portal ? (
        <fieldset disabled={disabled} className="composer-settings-fields">
          {children}
        </fieldset>
      ) : (
        children
      )}
    </div>
  )
  return (
    <details
      ref={ref}
      className={`disclosure-panel ${className}`}
      open={actualOpen}
      onToggle={(event) => {
        if (event.currentTarget.open !== actualOpen) changed(event.currentTarget.open)
      }}
      onPointerDownCapture={(event) => {
        insidePointer.current = event.nativeEvent
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          ref.current?.open &&
          event.target instanceof Node &&
          ref.current.contains(event.target)
        ) {
          event.preventDefault()
          event.stopPropagation()
          close(true)
        }
      }}
    >
      <summary
        aria-label={label}
        title={label}
        role="button"
        aria-controls={panelId}
        onKeyDown={(event) => {
          if (portal && actualOpen && event.key === 'Tab' && event.shiftKey) close()
          if (portal && actualOpen && event.key === 'Tab' && !event.shiftKey) {
            const first = focusables()[0]
            if (first) {
              event.preventDefault()
              first.focus()
            }
          }
        }}
      >
        {icon}
      </summary>
      {portal ? createPortal(contents, document.body) : contents}
    </details>
  )
}
