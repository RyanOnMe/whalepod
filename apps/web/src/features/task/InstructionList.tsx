/**
 * 执行区：指令流（切片⑥a；ADR-0010 决策 1/2）。
 *
 * 与「讨论」是两条流：讨论里的话**永不触发运行**，这里的每一条都驱动过（或试图驱动）Agent。
 * 四种状态就是这一列要如实回答的问题——「我那句话到底怎么了」：
 *   待受理（pending）——Hub 已记账，还在等 `run.start` 的受理回执；
 *   已受理（accepted）——设备接下了，这一句开始干活；
 *   已排队（queued）——Run 还没进 running，按 ③c-1 的语义先排队（不是没受理）；
 *   已拒绝（rejected）——**当场拒绝并给理由**（理由与状态同列落库，长期可读；
 *                          团队事件只有 24 小时窗口，靠事件承载理由会在一天后丢失）。
 *
 * 视觉一律走产品 token（--dsw-*），不新造颜色；状态色用产品自己的 state-* 语义档。
 */
import type { ReactNode } from 'react'
import type { InstructionView } from '../../shared/api/types.js'
import { RelativeTime } from '../../shared/RelativeTime.js'

type KnownState = NonNullable<InstructionView['instructionState']>

const STATE_LABEL: Record<KnownState, string> = {
  pending: '待受理',
  accepted: '已受理',
  rejected: '已拒绝',
}

/** 状态 → 产品 token 的语义档（成功/警示/错误/中性）。 */
const STATE_CLASS: Record<KnownState, string> = {
  pending: 'instruction-state-pending',
  accepted: 'instruction-state-accepted',
  rejected: 'instruction-state-rejected',
}

export interface InstructionListProps {
  instructions: InstructionView[]
  session: { userId: string } | null
  /**
   * 排队中的指令（③c-1）。由调用方给出——"排队"不是消息自身的状态：
   * 它是「pending 且当前 Run 还没进 running」，需要 Run 的信息才能判断。
   */
  queuedIds?: ReadonlySet<string>
  /** 点运行号 → 打开该 Run 的 Console（#179 决策：卡内覆盖层）。 */
  onOpenRun?: (runId: string) => void
  /**
   * 人名解析**由调用方注入**（不在组件里直接调 `useMemberDirectory`）：
   * 那个 hook 依赖 react-query，会把纯展示组件绑死在 provider 上，也让组件测试必须搭整套
   * 请求夹具。默认退化成短 id——调用方（任务房间）传 `directory.personOf`。
   */
  authorName?: (userId: string) => string
}

export function InstructionList({
  instructions,
  session,
  queuedIds,
  onOpenRun,
  authorName,
}: InstructionListProps): ReactNode {
  const nameOf = authorName ?? ((userId: string) => userId.slice(0, 8))
  if (instructions.length === 0) {
    return (
      <p className="empty-state">
        还没有人驱动过这个任务。在下面说一句「让 Agent 干这个」就会起第一个运行。
      </p>
    )
  }
  return (
    <ol className="instruction-list" role="list">
      {instructions.map((instruction) => {
        const isMine = session !== null && instruction.authorUserId === session.userId
        // 空串按"没有运行"处理：契约是 `string | null`，空串只会画出一个空的运行号入口
        // （复核 R4：判空写成 `=== null` 时空串会画出坏入口，而且没有任何判据看得见）。
        const runId =
          instruction.runId !== null && instruction.runId !== '' ? instruction.runId : null
        // 排队态优先于"待受理"：对用户来说「我的话排在当前运行后面」比「还没回执」更准确。
        const queued =
          instruction.instructionState === 'pending' && (queuedIds?.has(instruction.id) ?? false)
        // #210 收敛后类型如实说"可空"：服务端执行流永远发非空（该字段就是执行流的意义），
        // 但类型是与 CommentView 同构的、可空就是可空。null 不崩——画"未知状态"。
        const knownState: KnownState | null = instruction.instructionState
        const stateLabel = queued
          ? '已排队'
          : knownState === null
            ? '未知状态'
            : STATE_LABEL[knownState]
        const stateClass = queued
          ? 'instruction-state-queued'
          : knownState === null
            ? 'instruction-state-unknown'
            : STATE_CLASS[knownState]
        return (
          <li key={instruction.id} className="instruction-item" data-testid="instruction-item">
            <div className="instruction-head">
              <strong data-testid="instruction-author">
                {isMine ? '你' : nameOf(instruction.authorUserId)}
              </strong>
              <span className="instruction-kind">
                {instruction.kind === 'followup' ? '追问' : '指令'}
              </span>
              <RelativeTime iso={instruction.createdAt} />
              <span className={stateClass} data-testid="instruction-state">
                {stateLabel}
              </span>
            </div>
            <p className="instruction-body">{instruction.body}</p>
            {instruction.instructionState === 'rejected' ? (
              // 理由必须画出来——它正是「被拒了，为什么」的答案。
              <p className="instruction-error" data-testid="instruction-error">
                <span className="mono">{instruction.instructionErrorCode ?? 'REJECTED'}</span>
                {' · '}
                {instruction.instructionErrorMessage ?? '未给出理由'}
              </p>
            ) : null}
            {runId === null ? null : (
              <div className="instruction-foot">
                <button
                  type="button"
                  className="link-button"
                  data-testid="instruction-run"
                  onClick={() => onOpenRun?.(runId)}
                >
                  运行 {runId.slice(0, 8)}
                </button>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
