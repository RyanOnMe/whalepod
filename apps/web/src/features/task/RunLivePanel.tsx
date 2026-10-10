/**
 * P1-13 Run 直播与事件时间线（03 §8 双受众、04 G4-04）。
 *
 * - 责任人（owner）：直播文本（run.live_delta，内存缓冲、不落库）+ 完整事件流；
 * - 成员：无直播区（Hub 扇出保证收不到），事件流只有 project 缩水行
 *   （由 GET /runs/:id/events 服务端过滤，客户端不做二次裁剪）。
 * 事件渲染按已知类型映射；未知类型只显示类型名——不猜载荷形状（fail-closed 呈现）。
 */
import { useQuery } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { RUN_PHASE_LABEL } from '../../shared/format.js'
import { RunStatusBadge } from '../../shared/micro/RunStatusBadge.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ToolEventChip } from './ToolEventChip.js'
import { eventIdentity, orderedRunEvents, toolResults } from './tool-call-state.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useStickToBottom } from '../../shared/useStickToBottom.js'
import { rerunLineageLabel, SELECTED_RUN_LABEL } from './runLabels.js'
import { TERMINAL_RUN } from './run-states.js'
import type { RunEventItem, RunPhase, RunView, Session } from '../../shared/api/types.js'
import { dropRunLive, getRunLiveText, subscribeRunLive } from '../../shared/realtime/run-buffer.js'
import { RunActions } from '../run/RunActions.js'
import { RunFailureNotice } from '../run/RunFailureNotice.js'

export interface RunLivePanelProps {
  /** 点「Console」时的回调（⑥d：覆盖层放大看）。不传则不渲染入口。 */
  onOpenConsole?: () => void
  runId: string
  session: Session
  /**
   * runId → 「第 N 次运行」（Task Room 的运行记录派生）。面板只用它把血缘句里的
   * 来源 Run 说清楚（「重跑自第 2 次运行」）；来源 Run 不在表里时血缘句退回不指名的
   * 「重跑自来源运行」。
   */
  runLabels: ReadonlyMap<string, string>
}

/**
 * 已知事件类型 → 单行呈现；返回 null 表示未知类型（只显示类型名）。
 * **导出**给 Run Console（⑥d）复用：同一份协议不该有两套解读。
 */
export function describeEvent(item: RunEventItem): string | null {
  const event = item.event as { type?: unknown }
  switch (event.type) {
    case 'runtime.ready':
      return 'DSH 运行时就绪'
    case 'run.phase': {
      const phase = (item.event as { phase?: unknown }).phase
      // 取值表是协议枚举的全集（Record<RunPhase, string>，协议加阶段这里编译红）；
      // wire 上仍可能来未知值——原样呈现，不猜、不丢。
      const label = typeof phase === 'string' ? RUN_PHASE_LABEL[phase as RunPhase] : undefined
      return `阶段：${label ?? (typeof phase === 'string' ? phase : '未知')}`
    }
    case 'assistant.message': {
      const text = (item.event as { text?: unknown }).text
      return typeof text === 'string' ? text : null
    }
    case 'tool.started': {
      const name = (item.event as { toolName?: unknown }).toolName
      return `工具开始：${typeof name === 'string' ? name : '未知工具'}`
    }
    case 'tool.finished': {
      const outcome = (item.event as { outcome?: unknown }).outcome
      const label =
        outcome === 'succeeded'
          ? '成功'
          : outcome === 'failed'
            ? '失败'
            : outcome === 'cancelled'
              ? '已取消'
              : null
      return label === null ? null : `工具结束：${label}`
    }
    case 'approval.requested': {
      const reason = (item.event as { approval?: { reason?: unknown } }).approval?.reason
      // project 行 reason 恒为空（03 §8）：呈现固定文案，不显示空框。
      return typeof reason === 'string' && reason !== '' ? `请求批准：${reason}` : '等待责任人批准'
    }
    case 'approval.decided': {
      const status = (item.event as { status?: unknown }).status
      if (typeof status !== 'string') return null
      const label =
        status === 'allowed_once'
          ? '已批准一次'
          : status === 'rejected'
            ? '已拒绝'
            : status === 'expired'
              ? '已过期（按拒绝处理）'
              : status === 'cancelled'
                ? '已取消'
                : status
      return `审批决定：${label}`
    }
    case 'run.completed': {
      const finalText = (item.event as { finalText?: unknown }).finalText
      return typeof finalText === 'string' && finalText !== '' ? `完成：${finalText}` : '完成'
    }
    case 'run.failed': {
      const code = (item.event as { code?: unknown }).code
      return `失败：${typeof code === 'string' ? code : '未知错误'}`
    }
    case 'run.cancelled':
      return '已取消'
    default:
      return null
  }
}

export function RunLivePanel({
  runId,
  session,
  runLabels,
  onOpenConsole,
}: RunLivePanelProps): ReactNode {
  const runQuery = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: () => api.get<RunView>(`/runs/${runId}`),
  })
  const eventsQuery = useQuery({
    queryKey: queryKeys.runEvents(runId),
    queryFn: () => api.get<{ events: RunEventItem[] }>(`/runs/${runId}/events`),
  })
  const run = runQuery.data
  const isOwner = run !== undefined && run.ownerUserId === session.userId
  const isActive = run !== undefined && !TERMINAL_RUN.has(run.status)

  // Run 终态且无人再看时释放缓冲（可丢语义，03 §8）。
  useEffect(() => {
    return () => {
      dropRunLive(runId)
    }
  }, [runId])

  if (runQuery.isPending) return <p className="mutation-hint">正在加载 Run…</p>
  if (runQuery.isError || run === undefined) {
    return <p className="empty-state">Run 加载失败或不存在。</p>
  }

  const events = orderedRunEvents(eventsQuery.data?.events ?? [], runId)
  const results = toolResults(events)
  return (
    <section
      className="card run-live"
      data-testid="run-live-panel"
      aria-labelledby="run-live-heading"
    >
      <div className="run-live-head">
        {/* #162：面板标题说「本次运行」，不写 `Run 01a08c11`；完整 id 在 title 里。 */}
        <h3 id="run-live-heading" title={run.id}>
          {SELECTED_RUN_LABEL}
        </h3>
        <RunStatusBadge status={run.status} />
        {/* ⑥d：把这次运行"放大看"——Console 覆盖层带按 component 分层与筛选。 */}
        {onOpenConsole === undefined ? null : (
          <button
            type="button"
            className="button live-console-open"
            data-testid="open-run-console"
            onClick={onOpenConsole}
          >
            打开 Console
          </button>
        )}
        {run.startedAt !== null ? (
          <span>
            开始 <RelativeTime iso={run.startedAt} />
          </span>
        ) : null}
        {run.finishedAt !== null ? (
          <span>
            结束 <RelativeTime iso={run.finishedAt} />
          </span>
        ) : null}
      </div>

      {run.rerunOfRunId !== null ? (
        <p className="run-lineage" data-testid="run-lineage" title={run.rerunOfRunId}>
          {rerunLineageLabel(runLabels.get(run.rerunOfRunId))}
        </p>
      ) : null}

      {/* P1-16：failed/lost 明示未知副作用警示；取消/重跑动作（权限内呈现）。 */}
      <RunFailureNotice run={run} />
      <RunActions run={run} session={session} />

      {isOwner ? (
        <div className="run-live-stream">
          <h4>实时输出</h4>
          {/* #275：订阅下沉到这个子组件——面板头部/失败提示/动作区/事件列表不再因为
              "多了一个 token"而跟着重渲染（原先订阅在面板上，每帧整棵子树 reconcile）。 */}
          <RunLiveStream runId={runId} isActive={isActive} />
        </div>
      ) : null}

      <div className="run-live-events" data-testid="run-live-events">
        <h4>事件</h4>
        {eventsQuery.isPending ? <p className="mutation-hint">正在加载事件…</p> : null}
        {eventsQuery.isError ? (
          <div data-testid="run-events-error">
            <p>事件读取失败，请稍后重试。</p>
            <ErrorBanner error={eventsQuery.error} />
          </div>
        ) : null}
        {events.length === 0 && !eventsQuery.isPending && !eventsQuery.isError ? (
          <p className="empty-state">还没有事件。</p>
        ) : null}
        <ol className="run-event-list">
          {events.map((item) => {
            const text = describeEvent(item)
            return (
              <li key={eventIdentity(item)} className={`run-event audience-${item.audience}`}>
                <span className="run-event-seq">#{item.seq}</span>
                <span
                  className={`run-event-text${item.event['type'] === 'tool.started' ? ' tool-event' : ''}`}
                >
                  {item.event['type'] === 'tool.started' ? (
                    <ToolEventChip
                      item={item}
                      results={results}
                      runStatus={run.status}
                      eventsError={eventsQuery.isError}
                    />
                  ) : (
                    (text ?? item.type)
                  )}
                </span>
                <RelativeTime iso={item.occurredAt} />
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

/**
 * 直播文本（#275）：**唯一**订阅直播缓冲的组件。
 *
 * 为什么要单独拆出来：原先订阅挂在整块 `RunLivePanel` 上，而 delta 是按 token 来的
 * ——每来一个 token，标题、`RunFailureNotice`、`RunActions`、≤64KB 的 `<pre>` 与整段
 * 事件 `<ol>` 全部重新 reconcile，`scrollHeight` 的读取还构成每 token 一次的强制同步
 * 布局。订阅下沉以后，一帧的代价只剩这段文本自己。
 *
 * 另外两件"像 ChatGPT/Claude"的事也在这里：
 *   · **流式光标**：还在跑的时候，文本末尾有一个"正在写"的标记（纯装饰，`aria-hidden`，
 *     不改文本内容——按文本断言的既有用例不受影响）；终态即消失。
 *   · **跟随滚动可被用户接管**：往上翻就停止跟随并给出「回到最新」（见
 *     `shared/useStickToBottom.ts` 的语义与判据）。
 */
function RunLiveStream({ runId, isActive }: { runId: string; isActive: boolean }): ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRunLive(runId, listener),
    [runId],
  )
  const liveText = useSyncExternalStore(subscribe, () => getRunLiveText(runId))
  // 容器可能后挂载（空态是 <p>，有内容才是 <pre>），所以用回调 ref 换成 state，
  // 让下面两个 effect 在容器真的出现时重跑——用 useRef 的话滚动监听会永远挂不上。
  const [scroller, setScroller] = useState<HTMLPreElement | null>(null)
  const { following, resume } = useStickToBottom(scroller, liveText, isActive)

  if (liveText === '') {
    return (
      <p className="empty-state">
        {isActive ? '等待输出…（直播帧不落库，断线期间的内容以最终消息为准）' : '无直播内容。'}
      </p>
    )
  }
  return (
    <div className="run-live-scroll">
      <pre ref={setScroller} className="run-live-text" data-testid="run-live-text">
        {liveText}
        {isActive ? <span className="run-live-caret" aria-hidden="true" /> : null}
      </pre>
      {isActive && !following ? (
        <button
          type="button"
          className="run-live-jump"
          data-testid="run-live-jump"
          onClick={resume}
        >
          回到最新
        </button>
      ) : null}
    </div>
  )
}
