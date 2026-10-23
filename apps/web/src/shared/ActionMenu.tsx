import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu } from '../vendor/dsh-ui/Menu.js'
import { WorkspaceIcon } from './WorkspaceIcon.js'

export interface FileAction {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
}

/** Application actions over the existing portal Menu; no additional dependency. */
export function ActionMenu({ actions }: { actions: readonly FileAction[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const firstItem = useRef<HTMLSpanElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!open) return
    // Wait for the portal's placement commit before focusing its first item.
    const frame = requestAnimationFrame(() => {
      const first = firstItem.current?.closest('button')
      const menu = first?.closest('[role="menu"]')
      // The user may already have moved with ArrowDown before this frame runs.
      // Only repair missing initial focus; never reset an active menu item.
      if (
        !menu?.contains(document.activeElement) &&
        (document.activeElement === trigger.current || document.activeElement === document.body)
      ) {
        first?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [open])
  if (actions.length === 0) return null
  return (
    <span
      className="artifact-more-menu"
      onKeyDownCapture={(event) => {
        if (!open) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        if (event.key === 'Tab') close()
      }}
    >
      <Menu
        open={open}
        portal
        autoFocus
        align="end"
        dense
        getAnchorRect={() => trigger.current?.getBoundingClientRect() ?? null}
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          const action = actions.find((item) => item.id === id)
          close()
          action?.onSelect()
        }}
        items={actions.map((item, index) => ({
          id: item.id,
          label: index === 0 ? <span ref={firstItem}>{item.label}</span> : item.label,
          icon: item.icon,
        }))}
        anchor={
          <button
            ref={trigger}
            type="button"
            className="button button-quiet artifact-more"
            aria-label="更多文件操作"
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid="artifact-more"
            onClick={() => setOpen(!open)}
          >
            <WorkspaceIcon name="更多" />
            <span>更多</span>
          </button>
        }
      />
    </span>
  )
}
