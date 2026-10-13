/**
 * Adapted from React Bits WarmTooltip (David Haz, 2026), MIT + Commons Clause.
 * Upstream revision and original hashes: manifest.json. Full terms: LICENSE.md.
 * App adaptation: one shared hint layer for the whole shell; the first label waits, its
 * siblings open instantly while warm; keyboard focus shows at once, Escape closes.
 * Lean/travel springs, blur layers, long-press, arming fuse and custom colours are removed
 * along with the Motion dependency; the text is exactly the caller's static label.
 */
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './WarmTooltip.css'

export type HintSide = 'top' | 'bottom'

export interface HintGroupProps {
  /** 冷启动：第一次悬停要等满这么久才出现。 */
  delayMs?: number
  /** 温暖窗口：上一次提示关闭后这么久内，相邻目标即时出现。 */
  warmWindowMs?: number
  children?: ReactNode
}

export interface HintProps {
  /** 提示文案（静态标签）。不接收 Run/事件数据。 */
  label: string
  /**
   * 触发元素。**必须是真实 DOM 元素**（`<button>` 这类）：提示层要把 `aria-describedby`
   * 挂在会渲染它的那颗节点上，传自定义组件的话属性会被组件忽略（看不见的哑失败）。
   */
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: HintSide
  delayMs?: number
  warmWindowMs?: number
  /** 触发元素是块级/整行按钮时置真：锚点跟着占满一行，不改变既有排版。 */
  block?: boolean
  disabled?: boolean
  className?: string
}

type Phase = 'closed' | 'open' | 'closing'
type Timer = ReturnType<typeof setTimeout> | undefined

interface Payload {
  id: string
  trigger: HTMLElement
  label: string
  side: HintSide
}

interface GroupApi {
  id: string
  delayMs: number
  warmWindowMs: number
  activeId: string | null
  isWarm: () => boolean
  show: (payload: Payload) => void
  hide: (hintId: string, instant?: boolean) => void
}

const DEFAULT_DELAY_MS = 400
const DEFAULT_WARM_WINDOW_MS = 300
/** 触发元素之间移动的宽限：不立刻关掉，让相邻目标能接管同一次显示。 */
const GRACE_MS = 80
/** 退场时长：与 `.hint-layer` 的 CSS 过渡一致（`--duration-base`）。 */
const EXIT_MS = 160
const GAP = 8
const MARGIN = 8

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const GroupContext = createContext<GroupApi | null>(null)

export function HintGroup({
  delayMs = DEFAULT_DELAY_MS,
  warmWindowMs = DEFAULT_WARM_WINDOW_MS,
  children,
}: HintGroupProps): ReactNode {
  const id = useId()
  const [current, setCurrent] = useState<Payload | null>(null)
  const [phase, setPhase] = useState<Phase>('closed')
  const layerRef = useRef<HTMLSpanElement | null>(null)
  const st = useRef({
    phase: 'closed' as Phase,
    current: null as Payload | null,
    warmUntil: Number.NEGATIVE_INFINITY,
    closeTimer: undefined as Timer,
    leaveTimer: undefined as Timer,
  })
  const showRef = useRef<(payload: Payload) => void>(() => {})
  const hideRef = useRef<(hintId: string, instant?: boolean) => void>(() => {})

  const isWarm = (): boolean => st.current.phase !== 'closed' || now() < st.current.warmUntil

  const finishClose = (): void => {
    st.current.phase = 'closed'
    st.current.current = null
    setPhase('closed')
    setCurrent(null)
  }

  showRef.current = (payload: Payload): void => {
    clearTimeout(st.current.closeTimer)
    clearTimeout(st.current.leaveTimer)
    st.current.phase = 'open'
    st.current.current = payload
    setCurrent(payload)
    setPhase('open')
  }

  const beginClose = (instant: boolean): void => {
    const active = st.current.current
    if (active === null || st.current.phase !== 'open') return
    st.current.phase = 'closing'
    setPhase('closing')
    // 关闭即开始计温暖窗口：窗口内换到相邻目标是即时的。
    st.current.warmUntil = now() + warmWindowMs
    clearTimeout(st.current.closeTimer)
    if (instant) {
      finishClose()
      return
    }
    st.current.closeTimer = setTimeout(finishClose, EXIT_MS)
  }

  hideRef.current = (hintId: string, instant?: boolean): void => {
    const active = st.current.current
    if (active === null || active.id !== hintId || st.current.phase !== 'open') return
    clearTimeout(st.current.leaveTimer)
    if (instant) {
      beginClose(true)
      return
    }
    st.current.leaveTimer = setTimeout(() => beginClose(false), GRACE_MS)
  }

  const group = useMemo<GroupApi>(
    () => ({
      id,
      delayMs,
      warmWindowMs,
      activeId: current === null ? null : current.id,
      isWarm,
      show: (payload: Payload) => showRef.current(payload),
      hide: (hintId: string, instant?: boolean) => hideRef.current(hintId, instant),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, delayMs, warmWindowMs, current],
  )

  // 定位：先量后画（layout effect 在绘制前跑，不会闪在错误位置）。
  useLayoutEffect(() => {
    if (current === null) return undefined
    const place = (): void => {
      const layer = layerRef.current
      if (layer === null) return
      const rect = current.trigger.getBoundingClientRect()
      const width = layer.offsetWidth
      const height = layer.offsetHeight
      const x = clamp(
        rect.left + rect.width / 2 - width / 2,
        MARGIN,
        Math.max(MARGIN, window.innerWidth - MARGIN - width),
      )
      const y =
        current.side === 'top' ? rect.top - GAP - height : rect.bottom + GAP
      layer.style.transform = `translate(${Math.round(x)}px, ${Math.round(clamp(y, MARGIN, Math.max(MARGIN, window.innerHeight - MARGIN - height)))}px)`
    }
    place()
    let raf = 0
    const follow = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(place)
    }
    const onHidden = (): void => {
      if (document.visibilityState !== 'hidden') return
      const active = st.current.current
      if (active !== null) hideRef.current(active.id, true)
    }
    window.addEventListener('scroll', follow, { capture: true, passive: true })
    window.addEventListener('resize', follow)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', follow, { capture: true })
      window.removeEventListener('resize', follow)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [current])

  useEffect(
    () => () => {
      clearTimeout(st.current.closeTimer)
      clearTimeout(st.current.leaveTimer)
    },
    [],
  )

  return (
    <GroupContext.Provider value={group}>
      {children}
      {phase !== 'closed' && current !== null && typeof document !== 'undefined'
        ? createPortal(
            <span
              id={id}
              ref={layerRef}
              role="tooltip"
              className="hint-layer"
              data-state={phase}
              data-side={current.side}
            >
              <span className="hint-layer__box">
                <span className="hint-layer__text">{current.label}</span>
              </span>
            </span>,
            document.body,
          )
        : null}
    </GroupContext.Provider>
  )
}

function HintTrigger({
  label,
  children,
  side = 'top',
  delayMs,
  block = false,
  disabled = false,
  className = '',
}: Omit<HintProps, 'warmWindowMs'>): ReactNode {
  const group = useContext(GroupContext)
  const id = useId()
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const openTimer = useRef<Timer>(undefined)

  const active = group !== null && group.activeId === id
  const coldDelayMs = delayMs ?? group?.delayMs ?? DEFAULT_DELAY_MS
  // 输入方式：鼠标按下后的那次 focus（点按钮必然带 focus）不该再弹一次提示——
  // 否则点完目标提示会挂在屏幕上不走。键盘（含 Tab）走另一条路，不等待。
  const modality = useRef<'pointer' | 'keyboard'>('keyboard')

  const payload = (): Payload | null => {
    const el = anchorRef.current
    if (el === null || group === null) return null
    return { id, trigger: el, label, side }
  }

  const hide = (instant?: boolean): void => {
    clearTimeout(openTimer.current)
    group?.hide(id, instant)
  }

  const arm = (): void => {
    if (group === null) return
    clearTimeout(openTimer.current)
    const next = payload()
    if (next === null) return
    if (group.isWarm()) {
      group.show(next)
      return
    }
    openTimer.current = setTimeout(() => {
      const cold = payload()
      if (cold !== null && group !== null) group.show(cold)
    }, coldDelayMs)
  }

  useEffect(() => {
    if (disabled) hide(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  useEffect(() => {
    if (!active) return undefined
    const onOutside = (event: PointerEvent): void => {
      const el = anchorRef.current
      if (el !== null && !el.contains(event.target as Node)) hide(false)
    }
    document.addEventListener('pointerdown', onOutside, true)
    return () => document.removeEventListener('pointerdown', onOutside, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
    },
    [],
  )

  const handlers = disabled
    ? {}
    : {
        onPointerEnter: (event: React.PointerEvent<HTMLSpanElement>): void => {
          if (event.pointerType !== 'touch') arm()
        },
        onPointerLeave: (event: React.PointerEvent<HTMLSpanElement>): void => {
          if (event.pointerType !== 'touch') hide(false)
        },
        onPointerDown: (): void => {
          // 按下就收起来：提示不该盖在即将出现的界面变化上。
          modality.current = 'pointer'
          hide(true)
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>): void => {
          if (event.key === 'Escape') {
            hide(true)
            return
          }
          modality.current = 'keyboard'
        },
        onFocus: (event: React.FocusEvent<HTMLSpanElement>): void => {
          // 键盘路径不等待：焦点到了就显示（鼠标点击带来的 focus 不算）。
          const byPointer = modality.current === 'pointer'
          const visible = (event.target as HTMLElement).matches?.(':focus-visible') ?? false
          if (byPointer && !visible) return
          const next = payload()
          if (next !== null) group?.show(next)
        },
        onBlur: (): void => {
          hide(true)
        },
      }

  // 描述只在提示真的可见时挂上；已经有的 `aria-describedby`（例如 SelectMenu 的 hint）
  // 在提示不可见时必须原样保留，不能被清掉。
  const childProps: { 'aria-describedby'?: string } = {}
  const existing = children.props['aria-describedby']
  if (active && group !== null) childProps['aria-describedby'] = group.id
  else if (existing !== undefined) childProps['aria-describedby'] = existing

  return (
    <span
      ref={anchorRef}
      className={`hint-anchor${className === '' ? '' : ` ${className}`}`}
      data-state={active ? 'open' : 'closed'}
      data-block={block ? 'true' : undefined}
      data-testid="hint-anchor"
      {...handlers}
    >
      {cloneElement(children, childProps)}
    </span>
  )
}

export default function Hint(props: HintProps): ReactNode {
  const group = useContext(GroupContext)
  if (group !== null) return <HintTrigger {...props} />
  // 单点使用：自成一个 group（不共享温暖窗口，但提示仍能显示）。
  const defaults: HintGroupProps = {}
  if (props.delayMs !== undefined) defaults.delayMs = props.delayMs
  if (props.warmWindowMs !== undefined) defaults.warmWindowMs = props.warmWindowMs
  return (
    <HintGroup {...defaults}>
      <HintTrigger {...props} />
    </HintGroup>
  )
}
