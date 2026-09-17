/**
 * Run Console 覆盖层（切片⑥d；#179 决策：Console 是**覆盖层**，不是一个新页面）。
 *
 * 它回答的是排障时真正要问的问题——"这次跑到哪一步、卡在哪个组件、工具输出了什么"：
 *   · **按 component 分层**（`hub.*` / `node.*` / `runtime.*` / `dsh.*`）：出问题时先看是哪一层，
 *     这是仓库的归因口径（六原语之四），也是事件本来就带的结构化字段；
 *   · **筛选**：全部 / 工具 / 审批 / 错误——原型定的四个口径，够定位绝大多数问题；
 *   · **只读页脚**：明确"这里不是入口"——执行区的指令才是入口，Console 只读，
 *     免得有人在排障界面里找"重跑/取消"（那些动作在运行卡上）。
 *
 * 为什么与内联面板并存而不是取代它：审批流程要求**在执行栏点批准的同时**看见事件流
 * （e2e 的 G5/G6 就是那么走的），覆盖层会遮住执行栏。所以覆盖层是"放大看"的入口，
 * 内联面板保留为默认视图。这一点与原型不同，是有意的取舍，写在这里免得下次被"改回原型"。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RunEventItem } from '../../shared/api/types.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { describeEvent } from './RunLivePanel.js'

/** 原型定的四个筛选口径。 */
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'tool', label: '工具' },
  { id: 'approval', label: '审批' },
  { id: 'error', label: '错误' },
] as const

export type ConsoleFilter = (typeof FILTERS)[number]['id']

/**
 * 事件 → 筛选归类的判定（**导出以便单测直接验**，不用去点 UI）。
 * 依据是事件类型本身，不是文案：文案会随措辞变，类型是协议。
 */
export function matchesFilter(filter: ConsoleFilter, item: RunEventItem): boolean {
  if (filter === 'all') return true
  const type = String((item.event as { type?: unknown }).type ?? '')
  if (filter === 'tool') return type.startsWith('tool.')
  if (filter === 'approval') return type.startsWith('approval.')
  // 错误：事件类型里的失败面 + 工具失败（`tool.finished` 的 outcome=failed 也算，否则"工具失败"
  // 会落在"工具"里被当成正常步骤）。
  if (type === 'run.failed' || type === 'runtime.error' || type.endsWith('.error')) return true
  const outcome = (item.event as { outcome?: unknown }).outcome
  return type === 'tool.finished' && outcome === 'failed'
}

/** 事件的 component 分层（`hub.http` → `hub`）；事件没带 component 时归到 `other`。 */
export function componentLayer(item: RunEventItem): string {
  const component = (item.event as { component?: unknown }).component
  if (typeof component !== 'string' || component === '') return 'other'
  return component.split('.')[0] ?? 'other'
}

export interface RunConsoleProps {
  runId: string
  runLabel: string
  events: RunEventItem[]
  /** 事件还在加载时不要假装"没有事件"。 */
  eventsPending: boolean
  onClose: () => void
}

export function RunConsole({
  runId,
  runLabel,
  events,
  eventsPending,
  onClose,
}: RunConsoleProps): ReactNode {
  const [filter, setFilter] = useState<ConsoleFilter>('all')
  const closeRef = useRef<HTMLButtonElement>(null)

  // 打开即把焦点放进覆盖层（键盘用户不用 Tab 一圈才进来）；Esc 关闭。
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const visible = events.filter((item) => matchesFilter(filter, item))
  const layers = [...new Set(visible.map((item) => componentLayer(item)))]

  return (
    <div className="console-backdrop" data-testid="run-console">
      {/* 背景点击关闭：排障时常要一眼看完就退出（键盘用户走 Esc / 关闭按钮）。 */}
      <button
        type="button"
        className="console-scrim"
        aria-label="关闭 Console"
        data-testid="console-scrim"
        onClick={onClose}
      />
      <section
        className="console"
        role="dialog"
        aria-modal="true"
        aria-labelledby="console-heading"
      >
        <div className="console-head">
          <h2 id="console-heading">Run Console · {runLabel}</h2>
          <span className="mono">{runId.slice(0, 8)}</span>
          <button
            type="button"
            className="button console-close"
            data-testid="console-close"
            ref={closeRef}
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        <div className="console-filters" role="group" aria-label="事件筛选">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`cf${filter === item.id ? ' on' : ''}`}
              data-testid={`console-filter-${item.id}`}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
          <span className="console-count" data-testid="console-count">
            {visible.length} / {events.length} 条
          </span>
        </div>

        {/* 按 component 分层显示层级清单：排障第一步是"断在哪一层"。 */}
        <div className="console-layers" data-testid="console-layers">
          分层：{layers.length === 0 ? '（当前筛选下没有事件）' : layers.join(' · ')}
        </div>

        <div className="console-body">
          {eventsPending ? <p className="mutation-hint">正在加载事件…</p> : null}
          {!eventsPending && visible.length === 0 ? (
            <p className="empty-state" data-testid="console-empty">
              当前筛选下没有事件。换一个筛选，或确认这次运行是否真的产生了事件。
            </p>
          ) : null}
          <ol className="run-event-list console-event-list">
            {visible.map((item) => {
              const text = describeEvent(item)
              return (
                <li
                  key={`${item.audience}-${item.seq}`}
                  className={`run-event audience-${item.audience}`}
                  data-testid="console-event"
                  data-layer={componentLayer(item)}
                >
                  <span className="run-event-seq">#{item.seq}</span>
                  <span className="run-event-layer mono">{componentLayer(item)}</span>
                  <span className="run-event-text">{text ?? item.type}</span>
                  <RelativeTime iso={item.occurredAt} />
                </li>
              )
            })}
          </ol>
        </div>

        <div className="console-foot">
          <span className="chip-gray" data-testid="console-readonly">
            只读视图 · 执行区的指令才是入口（重跑/取消在运行卡上）
          </span>
        </div>
      </section>
    </div>
  )
}
