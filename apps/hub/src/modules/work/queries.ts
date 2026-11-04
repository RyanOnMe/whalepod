import type {
  Database,
  DispatchIntentRow,
  RouterDecisionRow,
  WorkMandateRow,
  WorkQuestionRow,
  WorkRow,
} from '@whalepod/db'
import { listDispatchIntents, listOpenWorkQuestions, listRouterDecisions } from '@whalepod/db'
import {
  DispatchIntentViewSchema,
  WorkDecisionViewSchema,
  WorkDetailViewSchema,
  WorkDraftToolNameSchema,
  WorkMandateViewSchema,
  WorkViewSchema,
  type DispatchIntentView,
  type WorkDecisionView,
  type WorkDetailView,
  type WorkMandateView,
  type WorkQuestionView,
  type WorkView,
} from '@whalepod/protocol'
import { toWorkQuestionView } from './questions.js'

// ADR-0028（RD-01）：协调记录到 HTTP 视图的映射。所有视图都经 protocol schema
// 校验后才出网；数据库里出现越界值时抛错而不是把不可信形状降级成「看起来正常」。

export function toWorkView(row: WorkRow): WorkView {
  return WorkViewSchema.parse({
    workKey: row.workKey,
    taskId: row.taskId,
    projectId: row.projectId,
    humanOwnerUserId: row.humanOwnerUserId,
    goal: row.goal,
    state: row.state,
    resumeMode: row.resumeMode ?? null,
    resumeCondition: row.resumeCondition ?? null,
    mandateId: row.mandateId ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

/**
 * 当前 Mandate 视图。`expiresAt` 已过但尚未落 `expired` 的 active 行按 expired 呈现：
 * 读面不能把一个已经不能派工的授权显示成 active（RD-01 不做后台到期写回）。
 */
export function toWorkMandateView(
  row: WorkMandateRow,
  now: Date,
  current: boolean,
): WorkMandateView {
  const effectiveStatus =
    row.status === 'active' && row.expiresAt.getTime() <= now.getTime() ? 'expired' : row.status
  return WorkMandateViewSchema.parse({
    id: row.id,
    workKey: row.workKey,
    version: row.version,
    current,
    status: effectiveStatus,
    principalUserId: row.principalUserId,
    onBehalfOfUserId: row.onBehalfOfUserId,
    humanOwnerUserId: row.humanOwnerUserId,
    draftRecipientUserId: row.draftRecipientUserId,
    autoDispatch: row.autoDispatch,
    allowedActionClasses: row.allowedActionClasses,
    allowedSourceTypes: row.allowedSourceTypes,
    allowedAgentIds: row.allowedAgentIds,
    allowedToolNames: row.allowedToolNames.map((name) => WorkDraftToolNameSchema.parse(name)),
    maxRunsPerWork: row.maxRunsPerWork,
    maxCostMicros: row.maxCostMicros,
    maxTokens: row.maxTokens,
    maxAttempts: row.maxAttempts,
    waitDeadlineSeconds: row.waitDeadlineSeconds,
    expiresAt: row.expiresAt.toISOString(),
    statusReason: row.statusReason ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  })
}

export function toWorkDecisionView(row: RouterDecisionRow): WorkDecisionView {
  return WorkDecisionViewSchema.parse({
    id: row.id,
    decision: row.decision,
    reason: row.reason,
    summary: row.summary,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceDigest: row.sourceDigest,
    inputDigest: row.inputDigest,
    mandateId: row.mandateId ?? null,
    mandateVersion: row.mandateVersion ?? null,
    rulesVersion: row.rulesVersion,
    refs: row.refs,
    createdAt: row.createdAt.toISOString(),
  })
}

export function toDispatchIntentView(row: DispatchIntentRow, now: Date): DispatchIntentView {
  const effectiveStatus =
    (row.status === 'proposed' || row.status === 'approved') &&
    row.expiresAt.getTime() <= now.getTime()
      ? 'expired'
      : row.status
  return DispatchIntentViewSchema.parse({
    id: row.id,
    workKey: row.workKey,
    status: effectiveStatus,
    approvalBasis: row.approvalBasis ?? null,
    decisionId: row.decisionId ?? null,
    mandateId: row.mandateId,
    mandateVersion: row.mandateVersion,
    authorizedByUserId: row.authorizedByUserId,
    onBehalfOfUserId: row.onBehalfOfUserId,
    inputDigest: row.inputDigest,
    triggerRefs: row.triggerRefs,
    candidates: row.candidates,
    exclusionReasons: row.exclusionReasons,
    reason: row.reason,
    resolutionReason: row.resolutionReason ?? null,
    agentId: row.agentId ?? null,
    profileRevisionId: row.profileRevisionId ?? null,
    deviceId: row.deviceId ?? null,
    workspaceId: row.workspaceId ?? null,
    actionClass: row.actionClass ?? null,
    runId: row.runId ?? null,
    expiresAt: row.expiresAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  })
}

/**
 * 工作读面：工作、当前 Mandate、最近影子决定、仍待处理的 proposed 意图与处理水位。
 * 不返回来源正文；refs 只带不透明定位字段。
 */
export async function loadWorkDetail(
  database: Database,
  work: WorkRow,
  currentMandate: WorkMandateRow | undefined,
  now: Date,
): Promise<WorkDetailView> {
  const [decisions, intents, questions] = await Promise.all([
    listRouterDecisions(database.db, work.id, 20),
    listDispatchIntents(database.db, work.id, 50),
    listOpenWorkQuestions(database.db, work.id, 50),
  ])
  const proposed = intents.filter(
    (intent) => intent.status === 'proposed' && intent.expiresAt.getTime() > now.getTime(),
  )
  const openQuestions: WorkQuestionView[] = questions.map((question: WorkQuestionRow) =>
    toWorkQuestionView(question, work.workKey),
  )
  return WorkDetailViewSchema.parse({
    work: toWorkView(work),
    // 非 active 工作没有“当前可派工授权”；历史仍可从版本列表读取。
    currentMandate:
      currentMandate === undefined || work.state !== 'active'
        ? null
        : toWorkMandateView(currentMandate, now, true),
    recentDecisions: decisions.map(toWorkDecisionView),
    proposedIntents: proposed.map((intent) => toDispatchIntentView(intent, now)),
    dispatchIntents: intents.map((intent) => toDispatchIntentView(intent, now)),
    openQuestions,
    watermarks: {
      lastDecisionAt: decisions[0]?.createdAt.toISOString() ?? null,
      lastSourceVersion: decisions[0]?.sourceVersion ?? null,
      proposedIntentCount: proposed.length,
    },
  })
}
