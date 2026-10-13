/**
 * Adapted from React Bits SwipeToast (David Haz, 2026), MIT + Commons Clause.
 * Upstream revision and original hashes: manifest.json. Full terms: LICENSE.md.
 * App adaptation: the card maps one store item (message/leaving) and owns the real
 * countdown so it can pause — hover, focus, page hidden or mid-drag hold the remaining time
 * instead of letting the toast vanish under the reader. Dismissal is four honest paths:
 * swipe down, Escape, the close button, or the real deadline. No Motion dependency, no
 * spring settle, no action button (our toasts carry no actions), no fuse guessing: the fuse
 * length is exactly the remaining window it is handed.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import './SwipeToast.css'

export interface SwipeToastProps {
  message: string
  /** 两段式退场：置真后由外层在退场时长后移除。 */
  leaving: boolean
  /** 真实可见剩余时长（毫秒）。 */
  durationMs: number
  /** 真实到期（不是动画结束回调，也不推进任何系统状态）。 */
  onExpire: () => void
  /** 用户主动关闭（滑动 / Escape / 关闭按钮）。 */
  onDismiss: () => void
  closeLabel?: string
}

const DEAD_ZONE_PX = 3
const RESIST_PX = 24
const SWIPE_PX = 40
const FLICK_PX_PER_MS = 0.11

interface Drag {
  id: number
  startY: number
  grab: number | null
  moved: boolean
  hist: Array<[number, number]>
}

/** 上滑给阻尼（下拉才是关闭方向），与上游同款公式。 */
const rubberband = (over: number, dim: number, c = 0.55): number =>
  (over * dim * c) / (dim + c * Math.abs(over))
const velocityOf = (hist: Array<[number, number]>): number => {
  if (hist.length < 2) return 0
  const [t0, y0] = hist[0] as [number, number]
  const [t1, y1] = hist[hist.length - 1] as [number, number]
  return performance.now() - t1 > 100 ? 0 : (y1 - y0) / Math.max(1, t1 - t0)
}

export default function SwipeToast({
  message,
  leaving,
  durationMs,
  onExpire,
  onDismiss,
  closeLabel = '关闭提示',
}: SwipeToastProps): ReactNode {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(false)
  const drag = useRef<Drag | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const startedAt = useRef(0)
  const remaining = useRef(durationMs)
  const closed = useRef(false)
  const latest = useRef({ onExpire, onDismiss })
  latest.current = { onExpire, onDismiss }

  const paused = !leaving && (hovered || focused || hidden || dragging)

  // 真实剩余时间只在两个地方推进：这里（真实的计时器）与 CSS 的 fuse（同一时长）。
  useEffect(() => {
    if (leaving || closed.current) return undefined
    const schedule = (ms: number): void => {
      clearTimeout(timer.current)
      startedAt.current = Date.now()
      timer.current = setTimeout(() => {
        closed.current = true
        latest.current.onExpire()
      }, ms)
    }
    if (paused) {
      clearTimeout(timer.current)
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current))
      return undefined
    }
    schedule(remaining.current)
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, leaving])

  useEffect(() => {
    const onVisibility = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      clearTimeout(timer.current)
    }
  }, [])

  const dismiss = (): void => {
    if (closed.current || leaving) return
    closed.current = true
    clearTimeout(timer.current)
    latest.current.onDismiss()
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (
      event.button !== 0 ||
      leaving ||
      closed.current ||
      drag.current !== null ||
      (event.target as HTMLElement).closest('button') !== null
    ) {
      return
    }
    drag.current = {
      id: event.pointerId,
      startY: event.clientY,
      grab: null,
      moved: false,
      hist: [[performance.now(), 0]],
    }
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.id !== event.pointerId) return
    if (current.grab === null) {
      if (Math.abs(event.clientY - current.startY) < DEAD_ZONE_PX) return
      current.grab = event.clientY
    }
    const raw = event.clientY - current.grab
    const next = raw >= 0 ? raw : rubberband(raw, RESIST_PX)
    current.moved = true
    current.hist.push([performance.now(), next])
    if (current.hist.length > 4) current.hist.shift()
    setOffset(next)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
    const dy = offset
    const velocity = velocityOf(current.hist)
    if (dy > 0 && (velocity > FLICK_PX_PER_MS || dy >= SWIPE_PX)) {
      setOffset(0)
      dismiss()
      return
    }
    setOffset(0)
  }

  return (
    <div
      className={`toast-item${leaving ? ' leaving' : ''}`}
      data-testid="toast-item"
      data-paused={paused ? 'true' : 'false'}
      data-dragging={dragging ? '' : undefined}
      data-offset={String(Math.round(offset))}
      style={
        {
          '--toast-offset': `${offset}px`,
          // fuse 的时长 = 这张卡真实的剩余窗口（同一处取值，不由动画推断）。
          '--toast-fuse-ms': `${durationMs}ms`,
        } as CSSProperties
      }
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') setHovered(false)
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          dismiss()
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="toast-item__message">{message}</span>
      <button type="button" className="toast-item__close" aria-label={closeLabel} onClick={dismiss}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {durationMs > 0 ? <i className="toast-item__fuse" aria-hidden="true" /> : null}
    </div>
  )
}
