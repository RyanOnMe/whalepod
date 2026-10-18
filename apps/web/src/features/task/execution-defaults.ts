/**
 * 输入框默认目标与自动草稿判据（P1-393；ADR-0019 决定 3/4）。
 *
 * 默认目标是**一条规则**，不是每次都要重新做的选择：
 *   无历史 → 新执行；有活跃运行 → 追问；运行结束 → 续聊最近一次业务运行。
 * 业务运行 = `purpose === 'business'`（辅助 Run：约定草稿 / 交接草稿不冒充会话来源）。
 *
 * 自动草稿（`modeOrigin === 'auto'`）只在「空白、未调整设置、未发送」时才跟随运行状态
 * 更新默认模式——用户输入过文字或明确选择过模式/来源/材料/设置后，默认规则不再改写草稿；
 * 来源不可续接时只阻塞并保留草稿（见 ExecutionComposer 的 reason 链），不自动改投。
 */
import { TERMINAL_RUN } from './run-states.js'

export type ComposeMode = 'new' | 'followup' | 'resume'

export interface ComposeTarget {
  readonly mode: ComposeMode
  readonly sourceId: string
}

export interface ComposeRunLike {
  readonly id: string
  readonly status: string
  readonly purpose: string
}

export function defaultComposeTarget(runs: readonly ComposeRunLike[]): ComposeTarget {
  const activeBusiness = runs.find(
    (run) => run.purpose === 'business' && !TERMINAL_RUN.has(run.status),
  )
  if (activeBusiness !== undefined) return { mode: 'followup', sourceId: activeBusiness.id }
  // 只有辅助运行活跃时也追问它：此刻默认新执行会被「已有执行进行中」挡住，
  // 默认续聊也会被挡——追问活跃运行是这一刻唯一可发送的默认（不把用户推进死胡同）。
  const activeAny = runs.find((run) => !TERMINAL_RUN.has(run.status))
  if (activeAny !== undefined) return { mode: 'followup', sourceId: activeAny.id }
  const lastBusinessTerminal = [...runs]
    .reverse()
    .find((run) => run.purpose === 'business' && TERMINAL_RUN.has(run.status))
  if (lastBusinessTerminal !== undefined)
    return { mode: 'resume', sourceId: lastBusinessTerminal.id }
  return { mode: 'new', sourceId: '' }
}

export interface ExecutionSettingsLike {
  readonly agentId: string
  readonly profileRevisionId: string
  readonly deviceId: string
  readonly workspaceId: string
}

/** 本段草稿是否被显式指定过执行参数（任一非空即算）。 */
export function settingsAdjusted(settings: ExecutionSettingsLike): boolean {
  return (
    settings.agentId !== '' ||
    settings.profileRevisionId !== '' ||
    settings.deviceId !== '' ||
    settings.workspaceId !== ''
  )
}

export interface ExecutionDraftLike {
  readonly text: string
  readonly mode: string
  readonly sourceId: string
  readonly modeOrigin: 'auto' | 'user'
  readonly sending: boolean
  readonly reviewArtifactIds: readonly string[]
  readonly revisionContext: unknown | null
  readonly launch: { readonly key: string; readonly settings: ExecutionSettingsLike }
}

/**
 * 自动草稿的「未动过」判据：只有这些全为真，运行状态变化才允许改写默认模式。
 * - 文字与空格分开判：只打了空白不算改过（发送时会被 trim 拦截）；
 * - 执行参数只在**当前模式会用到它们**时才算「调整过」（new/review 才带目标选择；
 *   上一次新执行留下的参数不该冻结之后的追问/续聊跟随——它们不会被发出）。
 */
export function followsDefaultMode(draft: ExecutionDraftLike): boolean {
  const usesLaunchSettings = draft.mode === 'new' || draft.mode === 'review'
  return (
    draft.modeOrigin === 'auto' &&
    !draft.sending &&
    draft.text.trim() === '' &&
    draft.reviewArtifactIds.length === 0 &&
    draft.revisionContext === null &&
    (!usesLaunchSettings || !settingsAdjusted(draft.launch.settings))
  )
}
