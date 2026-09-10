/**
 * P1-13 Run 直播与事件时间线（03 §8 双受众、04 G4-04）。
 *
 * - 责任人（owner）：直播文本（run.live_delta，内存缓冲、不落库）+ 完整事件流；
 * - 成员：无直播区（Hub 扇出保证收不到），事件流只有 project 缩水行
 *   （由 GET /runs/:id/events 服务端过滤，客户端不做二次裁剪）。
 * 事件渲染按已知类型映射；未知类型只显示类型名——不猜载荷形状（fail-closed 呈现）。
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { RUN_STATUS_LABEL } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import type { RunEventItem, RunView, Session } from '../../shared/api/types.js'
import { dropRunLive, getRunLiveText, subscribeRunLive } from '../../shared/realtime/run-buffer.js'
import { RunActions } from '../run/RunActions.js'
import { RunFailureNotice } from '../run/RunFailureNotice.js'

export interface RunLivePanelProps {
  runId: string
  session: Session
}

const TERMINAL_RUN: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'lost'])

const PHASE_LABEL: Record<string, string> = {
  thinking: '思考中',
  tool: '工具执行中',
  finalizing: '收尾中',
}

/** 已知事件类型 → 单行呈现；返回 null 表示未知类型（只显示类型名）。 */
function describeEvent(item: RunEventItem): string | null {
  const event = item.event as { type?: unknown }
  switch (event.type) {
    case 'runtime.ready':
      return 'DSH 运行时就绪'
    case 'run.phase': {
      const phase = (item.event as { phase?: unknown }).phase
      return `阶段：${typeof phase === 'string' ? (PHASE_LABEL[phase] ?? phase) : '未知'}`
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

export function RunLivePanel({ runId, session }: RunLivePanelProps): ReactNode {
  const runQuery = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: () => api.get<RunView>(`/runs/${runId}`),
  })
  const eventsQuery = useQuery({
    queryKey: queryKeys.runEvents(runId),
    queryFn: () => api.get<{ events: RunEventItem[] }>(`/runs/${runId}/events`),
  })
  const liveText = useSyncExternalStore(
    (listener) => subscribeRunLive(runId, listener),
    () => getRunLiveText(runId),
  )
  const liveRef = useRef<HTMLPreElement>(null)

  const run = runQuery.data
  const isOwner = run !== undefined && run.ownerUserId === session.userId
  const isActive = run !== undefined && !TERMINAL_RUN.has(run.status)

  // 直播区自动滚到底；Run 终态且无人再看时释放缓冲（可丢语义，03 §8）。
  useEffect(() => {
    // 直接赋 scrollTop（jsdom 无 scrollTo；属性赋值各处安全）。
    const el = liveRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [liveText])
  useEffect(() => {
    return () => {
      dropRunLive(runId)
    }
  }, [runId])

  if (runQuery.isPending) return <p className="mutation-hint">正在加载 Run…</p>
  if (runQuery.isError || run === undefined) {
    return <p className="empty-state">Run 加载失败或不存在。</p>
  }

  const events = eventsQuery.data?.events ?? []
  return (
    <section
      className="card run-live"
      data-testid="run-live-panel"
      aria-labelledby="run-live-heading"
    >
      <div className="run-live-head">
        <h3 id="run-live-heading">Run {run.id.slice(0, 8)}</h3>
        <span className={`badge badge-run badge-run-${run.status}`}>
          {RUN_STATUS_LABEL[run.status]}
        </span>
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
        <p className="run-lineage" data-testid="run-lineage">
          由 Run {run.rerunOfRunId.slice(0, 8)} 重跑
        </p>
      ) : null}

      {/* P1-16：failed/lost 明示未知副作用警示；取消/重跑动作（权限内呈现）。 */}
      <RunFailureNotice run={run} />
      <RunActions run={run} session={session} />

      {isOwner ? (
        <div className="run-live-stream">
          <h4>实时输出</h4>
          {liveText === '' ? (
            <p className="empty-state">
              {isActive
                ? '等待输出…（直播帧不落库，断线期间的内容以最终消息为准）'
                : '无直播内容。'}
            </p>
          ) : (
            <pre ref={liveRef} className="run-live-text" data-testid="run-live-text">
              {liveText}
            </pre>
          )}
        </div>
      ) : null}

      <div className="run-live-events" data-testid="run-live-events">
        <h4>事件</h4>
        {eventsQuery.isPending ? <p className="mutation-hint">正在加载事件…</p> : null}
        {events.length === 0 && !eventsQuery.isPending ? (
          <p className="empty-state">还没有事件。</p>
        ) : null}
        <ol className="run-event-list">
          {events.map((item) => {
            const text = describeEvent(item)
            return (
              <li
                key={`${item.audience}-${item.seq}`}
                className={`run-event audience-${item.audience}`}
              >
                <span className="run-event-seq">#{item.seq}</span>
                <span className="run-event-text">{text ?? item.type}</span>
                <RelativeTime iso={item.occurredAt} />
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
