/**
 * 一段运行（P1-393；ADR-0019 决定 1/2/6/7）。
 *
 * 执行区按 Run 成段连续阅读：段的头是一个「运行详情」入口（完整 id 由 Hint 提供，
 * 关标签与状态就在入口上），段内按时间呈现指令、Agent 回复、文件卡片与运行记录——
 * 不需要先选择运行。设备、时间、版本、血缘与时长移入运行详情（RunDetailPanel）。
 *
 * 直播（#275）：只有 owner 收到 live 帧；活跃运行有一个流式回复区，运行结束后它被
 * 持久化回复替代——**没有收进最终消息的部分**（断线/未收全）仍在「工具与运行记录」里
 * 可查，不让直播与最终内容重复并排。滚动跟随交给对话的唯一主滚动容器（TaskRoomPage）。
 */
import { useCallback, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'
import { Hint } from '../../shared/micro/Hint.js'
import { RunStatusBadge } from '../../shared/micro/RunStatusBadge.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { formatBytes } from '../../shared/format.js'
import type { RunEventItem, RunView, Session, TaskView } from '../../shared/api/types.js'
import { getRunLiveText, subscribeRunLive } from '../../shared/realtime/run-buffer.js'
import { RunActions } from '../run/RunActions.js'
import { RunFailureNotice } from '../run/RunFailureNotice.js'
import { ApprovalCards } from './approval-cards.js'
import type { ConversationSegment } from './conversation.js'
import { InstructionBubble } from './InstructionBubble.js'
import { RunActivityLine } from './RunActivityLine.js'
import { describeEvent } from './run-event-text.js'
import { ToolEventChip } from './ToolEventChip.js'
import { eventIdentity, orderedRunEvents, toolResults } from './tool-call-state.js'
import { TERMINAL_RUN } from './run-states.js'
import type { RunEventStatus } from './useRunWindows.js'

export interface RunSegmentRead {
  /** 运行详情（`GET /runs/:id`）：owner 判定、失败原因都取它；未读到前为 undefined。 */
  readonly detail: RunView | undefined
  readonly events: readonly RunEventItem[]
  readonly eventsStatus: RunEventStatus
  readonly retry: () => void
}

export interface RunSegmentProps {
  task: TaskView
  session: Session | null
  segment: ConversationSegment
  read: RunSegmentRead
  /** 排队中的指令（③c-1）：pending 且当前 Run 还没进 running。 */
  queuedIds?: ReadonlySet<string>
  authorName?: (userId: string) => string
  onOpenDetail: (runId: string) => void
  onOpenConsole: (runId: string) => void
  onOpenArtifact: (artifactId: string) => void
  /** 「继续此会话」：把来源交给底部统一输入框（保留已有文字）。 */
  onContinueSession: (runId: string) => void
  /** 流式文本增长：主滚动容器据此跟随（跟随判定只在 TaskRoomPage 一处）。 */
  onStreamGrowth: () => void
  /** 审批锚点只有在执行视图可见（详情关着）时才落焦。 */
  approvalVisible: boolean
}

/** 交付物卡片（P1-393 从 TaskRoomPage 拆出，按 runId 落在对应回复之后）。 */
function ArtifactCards({
  segment,
  onOpenArtifact,
}: {
  segment: ConversationSegment
  onOpenArtifact: (artifactId: string) => void
}): ReactNode {
  if (segment.artifacts.length === 0) return null
  return (
    <section className="conversation-artifacts" aria-label="本次运行交付物">
      {segment.artifacts.map((artifact) => (
        <button
          type="button"
          className="workspace-file"
          key={artifact.id}
          aria-label={`查看交付物 ${artifact.title}`}
          onClick={() => onOpenArtifact(artifact.id)}
        >
          <span className="workspace-file-icon" aria-hidden="true">
            <svg viewBox="0 0 24 28" width="24" height="28" fill="none">
              <path
                d="M5 1h9l6 6v18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M14 1v7h6M7 14h9M7 18h9M7 22h5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span>
            <strong>{artifact.title}</strong>
            <small>
              {artifact.status === 'candidate' ? '仅你可见 · 待检查发布' : '已发布给团队'} ·{' '}
              {formatBytes(artifact.byteSize)}
            </small>
          </span>
          <span aria-hidden="true">↗</span>
        </button>
      ))}
    </section>
  )
}

/**
 * 直播文本区（#275 的订阅下沉保留）：**唯一**订阅直播缓冲的组件。
 * 终态不再渲染它（流式区被持久化回复替换）；未收全的部分由调用方放进运行记录。
 */
function RunLiveText({
  runId,
  isActive,
  onGrowth,
}: {
  runId: string
  isActive: boolean
  onGrowth: () => void
}): ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRunLive(runId, listener),
    [runId],
  )
  const liveText = useSyncExternalStore(subscribe, () => getRunLiveText(runId))
  // 每来一个 delta，DOM 已在本帧更新；跟随判定在父级一处，这里只报告「底部长大了」。
  useLayoutEffect(() => {
    if (liveText !== '') onGrowth()
  }, [liveText, onGrowth])

  if (liveText === '') {
    return (
      <p className="empty-state">
        {isActive ? '等待输出…（直播帧不落库，断线期间的内容以最终消息为准）' : '无直播内容。'}
      </p>
    )
  }
  return (
    <pre className="run-live-text" data-testid="run-live-text">
      {liveText}
      {isActive ? <span className="run-live-caret" aria-hidden="true" /> : null}
    </pre>
  )
}

export function RunSegment({
  task,
  session,
  segment,
  read,
  queuedIds,
  authorName,
  onOpenDetail,
  onOpenConsole,
  onOpenArtifact,
  onContinueSession,
  onStreamGrowth,
  approvalVisible,
}: RunSegmentProps): ReactNode {
  const { run } = segment
  const detail = read.detail
  const isOwner = detail !== undefined && session !== null && detail.ownerUserId === session.userId
  const isActive = !TERMINAL_RUN.has(run.status)
  // 事件按身份去重 + seq 排序后再消费（分页读取已保证顺序，这里再钉一次口径，
  // 免得调用方拿到乱序数组时活动行/工具配对给出错误结论）。
  const events = orderedRunEvents(read.events, run.id)
  const results = toolResults(events)
  // 终态运行的直播缓冲是「没进最终消息」的兜底记录：订阅它（终态之后仍可能有迟到的
  // delta 落地，一次性读会在那之前把内容读空）；活跃运行不订阅——流式区自己订阅。
  const archivedEligible = isOwner && !isActive
  const subscribeArchived = useCallback(
    (listener: () => void) =>
      archivedEligible ? subscribeRunLive(run.id, listener) : () => undefined,
    [archivedEligible, run.id],
  )
  const archivedLive = useSyncExternalStore(subscribeArchived, () =>
    archivedEligible ? getRunLiveText(run.id) : '',
  )
  const persisted = segment.replies.map((reply) => reply.text.trim()).join('\n')
  // 直播与最终内容重复并排是用户点名的毛病：只有「没进最终消息」的部分才留在记录里。
  const showArchivedLive = archivedLive.trim() !== '' && archivedLive.trim() !== persisted

  return (
    <li className="conversation-run" data-testid="run-segment" data-run-id={run.id}>
      <header className="conversation-run-head">
        {/* #308：完整 id 从原生 title 换成真实提示层——原始值不丢，键盘也读得到。 */}
        <Hint label={run.id} block>
          <button
            type="button"
            className="run-item-button"
            data-run-id={run.id}
            onClick={() => onOpenDetail(run.id)}
          >
            <span className="run-label">{segment.label}</span>
            <RunStatusBadge status={run.status} />
            <span className="run-item-hint">运行详情</span>
          </button>
        </Hint>
        {/* #241（ADR-0009 决策 7）：full_access 是显式放权，必须在段上显著标记。 */}
        {run.approvalPolicy === 'full_access' ? (
          <p className="run-lineage" data-testid="run-full-access">
            完全权限（工具调用未逐次批准）
          </p>
        ) : null}
      </header>

      {/* 每段一个简短状态（#261 阶段/等待/终态都在这句里）。 */}
      <RunActivityLine
        runId={run.id}
        status={run.status}
        events={events}
        pending={read.eventsStatus === 'pending'}
        failed={read.eventsStatus === 'incomplete'}
      />

      <div className="conversation-items" role="list">
        {segment.items.map((item) =>
          item.kind === 'instruction' ? (
            <InstructionBubble
              key={item.key}
              instruction={item.instruction}
              session={session}
              queued={queuedIds?.has(item.instruction.id) ?? false}
              {...(run.lastToolCall === null ? {} : { lastToolCall: run.lastToolCall })}
              onOpenRun={onOpenConsole}
              {...(authorName === undefined ? {} : { authorName })}
            />
          ) : (
            <div className="workspace-reply" role="listitem" key={item.key}>
              <p>{item.text}</p>
            </div>
          ),
        )}
      </div>

      {isOwner && isActive ? (
        <div className="run-live-stream">
          <h4 className="visually-hidden">实时输出</h4>
          <RunLiveText runId={run.id} isActive onGrowth={onStreamGrowth} />
        </div>
      ) : null}

      <ArtifactCards segment={segment} onOpenArtifact={onOpenArtifact} />

      {run.status === 'waiting_approval' ? (
        <ApprovalCards
          runId={run.id}
          task={task}
          session={session}
          events={events}
          eventsComplete={read.eventsStatus === 'complete'}
          visible={approvalVisible}
        />
      ) : null}

      {detail !== undefined ? <RunFailureNotice run={detail} /> : null}
      {detail !== undefined && session !== null ? (
        <RunActions
          run={detail}
          session={session}
          onContinueSession={() => onContinueSession(run.id)}
        />
      ) : null}

      <details className="run-records" data-testid="run-records">
        <summary>工具与运行记录</summary>
        {showArchivedLive ? (
          <pre className="run-live-archived" data-testid="run-live-archived">
            {'未持久化的直播输出（断线或未收全的部分，以最终消息为准）：\n'}
            {archivedLive}
          </pre>
        ) : null}
        <div className="run-live-events" data-testid="run-live-events">
          <h4>事件</h4>
          {read.eventsStatus === 'pending' ? <p className="mutation-hint">正在加载事件…</p> : null}
          {read.eventsStatus === 'incomplete' ? (
            <div data-testid="run-events-incomplete" role="status">
              <p>
                事件读取不完整——上面的记录是已读到的部分，不代表运行只有这些。
                {events.length === 0 ? '（还没读到任何事件）' : null}
              </p>
              <button
                type="button"
                className="button"
                data-testid="retry-run-events"
                onClick={read.retry}
              >
                重试读取
              </button>
            </div>
          ) : null}
          {events.length === 0 && read.eventsStatus === 'complete' ? (
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
                        eventsError={read.eventsStatus === 'incomplete'}
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
      </details>
    </li>
  )
}
