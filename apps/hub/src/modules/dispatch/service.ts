/**
 * ADR-0028 §6（RD-03a）：受控派工端口。
 *
 * 意图状态机在此收口：proposed → approved（人类确认）→ dispatched（端口复核后建
 * 机器 Run）。端口与 Run 创建同事务，复用 `RunOrchestrator.createWithinTransaction`，
 * 不复制 Run 守卫，也不允许普通建 Run 入口伪造 origin='mandate'。
 *
 * 锁序固定 Task → Work → dispatch_intent → Run；`lockWorkContext` 已锁前两者，
 * 本文件只按序锁意图，再交给创建核心锁 Run 相关行。
 */
import {
  countFailedMachineRunsForWork,
  countChargedRouterFailuresForWork,
  getCoordinatorState,
  getCoordinationTeamPolicy,
  getRouterConfig,
  getTeam,
  getWorkCoordinationBudget,
  countMachineRunsForWork,
  expireDispatchIntent,
  getAgent,
  getDispatchIntent,
  getDispatchIntentForUpdate,
  getLatestPendingInboxItemForSource,
  getProfileRevision,
  getWorkByKey,
  getWorkMandateForUpdate,
  listActiveRunsByTask,
  listCancellableMachineRunIdsForWork,
  listDevicesByOwner,
  listMachineRunsForMandateInvalidation,
  listWorkInboxItemsByIds,
  listWorkspacesByOwner,
  markDispatchIntentAutoDispatched,
  markRunMandateInvalidated,
  reserveExecutorUsage,
  setDispatchIntentCandidates,
  approveDispatchIntent as approveIntentRow,
  markDispatchIntentDispatched,
  rejectDispatchIntent as rejectIntentRow,
  transactCommandWithOrigin,
  updateWork,
  unwrapPgError,
  type Database,
  type DispatchIntentRow,
  type MachineRunMandateFacts,
  type Outbox,
  type TaskRow,
  type Tx,
  type WorkRow,
} from '@whalepod/db'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { asUserId, DomainError } from '@whalepod/domain'
import { schema } from '@whalepod/db'
import type {
  DispatchIntentDispatchRequest,
  DispatchIntentView,
  ErrorCode,
  MandateInvalidationReason,
  WorkActionClass,
  WorkDraftToolName,
  WorkSourceType,
} from '@whalepod/protocol'
import { RunMandateInvalidatedSchema, WorkDraftToolNameSchema } from '@whalepod/protocol'
import {
  MANAGED_DRAFT_CONTROL_VERSION,
  WORK_INPUT_CAPABILITY,
  coordinationUsageCost,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { ERROR_HTTP_STATUS, errorCodeOf } from '../run/routes.js'
import { getDeviceDshDistributionVersion } from '../run/queries.js'
import { deriveDeviceStatus } from '../device/pairing.js'
import { contextCapabilitiesOf } from '../context/run-snapshot.js'
import type { RunOrchestrator } from '../run/orchestrator.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { lockWorkContext, requireAssignee } from '../work/context.js'
import { loadWorkSource, WORK_ADMISSION_RULES_VERSION } from '../work/admission.js'
import { toDispatchIntentView } from '../work/queries.js'
import { openNoCandidateQuestion } from '../work/questions.js'
import {
  queueManagedDraftPreparation,
  type ManagedDraftPlacement,
} from '../draft-share/dispatch.js'

export interface DispatchDeps {
  readonly database: Database
  readonly orchestrator: RunOrchestrator
  readonly outbox: Outbox
  readonly now: () => Date
  readonly managedDraftPlacement?: ManagedDraftPlacement | undefined
}

function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'dispatch intent not found')
}

function conflict(message: string): ApiError {
  return new ApiError(409, 'CONFLICT', message)
}

/**
 * 意图的绑定事实（work/task/mandate/来源）在派工前失效时，意图本身已无可救：
 * 端口把它落 rejected，并把同一理由作为 409 返回。请求候选错误（agent/device/
 * actionClass）不在此列——成员可以改参数重试，意图仍保持 approved。
 */
class IntentBindingError extends Error {}

/** 预留失败必须回滚整个派工事务（包括已建的 Run），再由事务外拒绝意图。 */
class ExecutorBudgetError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

function assertIntentOwned(
  intent: DispatchIntentRow | undefined,
  work: WorkRow,
  task: TaskRow,
): DispatchIntentRow {
  if (
    intent === undefined ||
    intent.workId !== work.id ||
    intent.workKey !== work.workKey ||
    intent.taskId !== task.id
  ) {
    throw notFound()
  }
  return intent
}

function assertActiveWork(work: WorkRow, task: TaskRow): void {
  if (work.state !== 'active') {
    throw new ApiError(409, 'CONFLICT', `work is ${work.state}`)
  }
  if (task.assignmentStatus !== 'accepted') {
    throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new ApiError(409, 'TASK_TERMINAL', 'task is terminal')
  }
}

function assertIntentLive(intent: DispatchIntentRow, now: Date): void {
  if (intent.expiresAt.getTime() <= now.getTime()) {
    throw conflict('dispatch intent has expired')
  }
}

interface TriggerRef {
  readonly sourceType: WorkSourceType
  readonly sourceId: string
  readonly sourceVersion: string
  readonly sourceDigest: string
  readonly authorizationGeneration: string
}

function parseTriggerRefs(value: readonly unknown[]): TriggerRef[] {
  const refs: TriggerRef[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      throw new IntentBindingError('dispatch intent trigger refs are malformed')
    }
    const ref = raw as Record<string, unknown>
    if (
      (ref.sourceType !== 'task_message' && ref.sourceType !== 'context_entry') ||
      typeof ref.sourceId !== 'string' ||
      typeof ref.sourceVersion !== 'string' ||
      typeof ref.sourceDigest !== 'string' ||
      typeof ref.authorizationGeneration !== 'string'
    ) {
      throw new IntentBindingError('dispatch intent trigger refs are malformed')
    }
    refs.push({
      sourceType: ref.sourceType,
      sourceId: ref.sourceId,
      sourceVersion: ref.sourceVersion,
      sourceDigest: ref.sourceDigest,
      authorizationGeneration: ref.authorizationGeneration,
    })
  }
  if (refs.length === 0) {
    throw new IntentBindingError('dispatch intent has no trigger refs')
  }
  return refs
}

/**
 * 派工前重放准入时的来源事实：来源版本/摘要/授权代次任一变化，说明意图所依据的
 * 输入已经不是成员确认时的那一份；inputDigest 是这些事实的摘要，同时复核以防
 * triggerRefs 与摘要本身被迁移/脏数据改坏。
 */
async function verifyIntentBinding(
  tx: Tx,
  work: WorkRow,
  intent: DispatchIntentRow,
): Promise<TriggerRef[]> {
  if (work.mandateId === null || work.mandateId !== intent.mandateId) {
    throw new IntentBindingError('work mandate changed; dispatch must be re-evaluated')
  }
  const refs = parseTriggerRefs(intent.triggerRefs)
  for (const ref of refs) {
    let source
    try {
      source = await loadWorkSource(tx, work, ref.sourceType, ref.sourceId)
    } catch (error) {
      // 404/403/409 是来源事实已失效；5xx 是服务端故障，不能把意图永久终结。
      if (error instanceof ApiError && error.statusCode < 500) {
        throw new IntentBindingError('source changed since the intent was approved')
      }
      throw error
    }
    if (
      source.ignored !== undefined ||
      source.sourceVersion !== ref.sourceVersion ||
      source.sourceDigest !== ref.sourceDigest ||
      source.authorizationGeneration !== ref.authorizationGeneration
    ) {
      throw new IntentBindingError('source changed since the intent was approved')
    }
  }
  const inputDigest = sha256Hex(
    canonicalJson({
      workKey: work.workKey,
      rulesVersion: WORK_ADMISSION_RULES_VERSION,
      workAuthorizationVersion: intent.mandateVersion,
      items: refs.map((ref) => ({
        sourceType: ref.sourceType,
        sourceId: ref.sourceId,
        sourceVersion: ref.sourceVersion,
        sourceDigest: ref.sourceDigest,
        authorizationGeneration: ref.authorizationGeneration,
      })),
    }),
  )
  if (inputDigest !== intent.inputDigest) {
    throw new IntentBindingError('input digest changed since the intent was approved')
  }
  return refs
}

async function assertSelectedItemsInIntent(
  tx: Tx,
  work: WorkRow,
  task: TaskRow,
  refs: readonly TriggerRef[],
  itemIds: readonly string[] | undefined,
): Promise<void> {
  if (itemIds === undefined) return
  if (new Set(itemIds).size !== itemIds.length) {
    throw conflict('work input item ids must not contain duplicates')
  }
  const items = await listWorkInboxItemsByIds(tx, [...itemIds])
  if (items.length !== itemIds.length) {
    throw conflict('one or more work input items do not exist')
  }
  for (const item of items) {
    if (item.workId !== work.id || item.taskId !== task.id) {
      throw conflict('work input item does not belong to this work and task')
    }
    if (item.status !== 'pending') {
      throw conflict(`work input item is ${item.status}, not pending`)
    }
    const inIntent = refs.some(
      (ref) =>
        ref.sourceType === item.sourceType &&
        ref.sourceId === item.sourceId &&
        ref.sourceVersion === item.sourceVersion &&
        ref.sourceDigest === item.sourceDigest &&
        ref.authorizationGeneration === item.authorizationGeneration,
    )
    if (!inIntent) {
      throw conflict('work input item is not part of the approved intent')
    }
  }
}

/** 派工端口失败统一映射为 API 错误；Run 创建核心的 RunCommandError 也在此收敛。 */
export async function mapDispatchErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    const pg = unwrapPgError(error)
    if (pg?.code === '23505') {
      if ((pg.constraintName ?? '').includes('run_one_active_per_task')) {
        throw new ApiError(409, 'RUN_ALREADY_ACTIVE', 'task already has an active run')
      }
      throw conflict('dispatch intent or run was already created')
    }
    if (error instanceof DomainError) {
      throw new ApiError(ERROR_HTTP_STATUS[error.code] ?? 409, error.code, error.message)
    }
    const mapped = errorCodeOf(error)
    if (mapped.code !== 'INTERNAL_ERROR') {
      throw new ApiError(ERROR_HTTP_STATUS[mapped.code] ?? 409, mapped.code, mapped.message)
    }
    throw error
  }
}

export async function approveDispatchIntent(
  deps: DispatchDeps,
  actor: { readonly userId: string },
  workKey: string,
  intentId: string,
  idempotencyKey: string,
): Promise<DispatchIntentView> {
  const outcome = await transactCommandWithOrigin(
    deps.database,
    `work.dispatch.approve:${workKey}:${intentId}:${actor.userId}:${idempotencyKey}`,
    async (tx) => {
      const now = deps.now()
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actor.userId)
      assertActiveWork(work, task)
      const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work, task)
      if (intent.status !== 'proposed') {
        throw conflict(`dispatch intent is ${intent.status}`)
      }
      assertIntentLive(intent, now)
      const row = await approveIntentRow(tx, intent.id, now)
      if (row === undefined) throw conflict('dispatch intent changed concurrently')
      return toDispatchIntentView(row, now)
    },
  )
  return outcome.executed
    ? outcome.value
    : refreshDispatchIntent(deps.database, intentId, deps.now())
}

export async function rejectDispatchIntent(
  deps: DispatchDeps,
  actor: { readonly userId: string },
  workKey: string,
  intentId: string,
  reason: string,
  idempotencyKey: string,
): Promise<DispatchIntentView> {
  const outcome = await transactCommandWithOrigin(
    deps.database,
    `work.dispatch.reject:${workKey}:${intentId}:${actor.userId}:${reason}:${idempotencyKey}`,
    async (tx) => {
      const now = deps.now()
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actor.userId)
      const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work, task)
      if (intent.status !== 'proposed' && intent.status !== 'approved') {
        throw conflict(`dispatch intent is ${intent.status}`)
      }
      assertIntentLive(intent, now)
      const row = await rejectIntentRow(tx, intent.id, reason, now)
      if (row === undefined) throw conflict('dispatch intent changed concurrently')
      return toDispatchIntentView(row, now)
    },
  )
  return outcome.executed
    ? outcome.value
    : refreshDispatchIntent(deps.database, intentId, deps.now())
}

interface Candidate {
  readonly agentId: string
  readonly profileRevisionId: string
  readonly deviceId: string
  readonly workspaceId: string
  readonly actionClass: WorkActionClass
  readonly dshDistributionVersion: string
  readonly allowedToolNames: WorkDraftToolName[]
  readonly mandateVersion: number
  /** ADR-0028 §17（RD-03r2）：Executor 用量上限/费用单价；缺任一即拒绝机器派工。 */
  readonly maxTokens: number | null
  readonly inputPriceMicrosPerMillionTokens: number | null
  readonly outputPriceMicrosPerMillionTokens: number | null
}

async function machineBudgetReason(
  tx: Tx,
  work: WorkRow,
  mandate: {
    readonly maxRunsPerWork: number
    readonly maxAttempts: number
    readonly maxTokens: number
    readonly maxCostMicros: number
  },
): Promise<string | undefined> {
  const totalRuns = await countMachineRunsForWork(tx, work.workKey)
  if (totalRuns >= mandate.maxRunsPerWork) return 'max_runs_exhausted'
  const failedRuns = await countFailedMachineRunsForWork(tx, work.workKey)
  const failedRouter = await countChargedRouterFailuresForWork(tx, work.workKey)
  if (failedRuns + failedRouter >= mandate.maxAttempts) return 'max_attempts_exhausted'
  // ADR-0028 §17（RD-03r2）：Router 与 Executor 共享 work lifetime 用量行。
  // 已用 + 在途预留触及任一上限即拒绝；未知实耗不再作为永久拒绝理由。
  const budget = await getWorkCoordinationBudget(tx, work.workKey)
  const usedTokens =
    (budget?.inputTokens ?? 0) + (budget?.outputTokens ?? 0) + (budget?.reservedTokens ?? 0)
  const usedCost = (budget?.costMicros ?? 0) + (budget?.reservedCostMicros ?? 0)
  if (usedTokens >= mandate.maxTokens) return 'budget_exhausted'
  if (usedCost >= mandate.maxCostMicros) return 'budget_exhausted'
  return undefined
}

async function resolveCandidate(
  tx: Tx,
  work: WorkRow,
  task: TaskRow,
  intent: DispatchIntentRow,
  request: DispatchIntentDispatchRequest,
  now: Date,
  managedPreparation = false,
): Promise<Candidate> {
  const mandate = await getWorkMandateForUpdate(tx, intent.mandateId)
  if (
    mandate === undefined ||
    mandate.workId !== work.id ||
    mandate.version !== intent.mandateVersion ||
    mandate.status !== 'active' ||
    mandate.expiresAt.getTime() <= now.getTime()
  ) {
    throw new IntentBindingError('mandate is not active at the referenced version')
  }
  // ADR-0028 §10：次数闸是派工端口的硬闸，人工确认路径也不能绕过。
  const budgetReason = await machineBudgetReason(tx, work, mandate)
  if (budgetReason !== undefined) throw new IntentBindingError(budgetReason)
  if (
    mandate.principalUserId !== task.assigneeUserId ||
    mandate.onBehalfOfUserId !== task.assigneeUserId ||
    mandate.humanOwnerUserId !== task.assigneeUserId ||
    mandate.draftRecipientUserId !== task.assigneeUserId ||
    intent.onBehalfOfUserId !== task.assigneeUserId ||
    intent.authorizedByUserId !== mandate.principalUserId
  ) {
    throw new ApiError(403, 'FORBIDDEN', 'mandate identity does not match the task assignee')
  }
  if (!mandate.allowedActionClasses.includes(request.actionClass)) {
    throw new ApiError(403, 'FORBIDDEN', 'action class is outside the mandate')
  }
  const agent = await getAgent(tx, request.agentId)
  if (agent === undefined || agent.archivedAt !== null) {
    throw new ApiError(404, 'NOT_FOUND', 'agent not found')
  }
  if (mandate.allowedAgentIds.length > 0 && !mandate.allowedAgentIds.includes(agent.id)) {
    throw new ApiError(403, 'FORBIDDEN', 'agent is outside the mandate')
  }
  const revisionId = request.profileRevisionId ?? agent.currentRevisionId
  if (revisionId === null) throw new ApiError(404, 'NOT_FOUND', 'agent has no profile revision')
  const revision = await getProfileRevision(tx, revisionId)
  if (revision === undefined || revision.agentId !== agent.id) {
    throw new ApiError(404, 'NOT_FOUND', 'profile revision not found')
  }
  if (revision.approvalPolicy === 'full_access' || task.approvalPolicy === 'full_access') {
    throw new ApiError(403, 'FORBIDDEN', 'full_access cannot be used for a machine run')
  }
  // #394：事务内读设备版本，必须复用同一事务句柄；另开连接看不到本事务的锁序，
  // 也把「在线」判定与派工提交拆成了两个快照。
  const dshDistributionVersion = managedPreparation
    ? MANAGED_DRAFT_CONTROL_VERSION
    : await getDeviceDshDistributionVersion(tx, request.deviceId, now)
  if (dshDistributionVersion === undefined) {
    throw new ApiError(409, 'DEVICE_OFFLINE', 'device is not connected')
  }
  return {
    agentId: agent.id,
    profileRevisionId: revision.id,
    deviceId: request.deviceId,
    workspaceId: request.workspaceId,
    actionClass: request.actionClass,
    dshDistributionVersion,
    allowedToolNames: mandate.allowedToolNames.map((name) => WorkDraftToolNameSchema.parse(name)),
    mandateVersion: mandate.version,
    maxTokens: revision.maxTokens,
    inputPriceMicrosPerMillionTokens: revision.inputPriceMicrosPerMillionTokens,
    outputPriceMicrosPerMillionTokens: revision.outputPriceMicrosPerMillionTokens,
  }
}

export type DispatchIntentOutcome =
  | { readonly ok: true; readonly intent: DispatchIntentView }
  | {
      readonly ok: false
      readonly status: number
      readonly code: ErrorCode
      readonly message: string
    }

async function reserveExecutorForMachineRun(
  tx: Tx,
  input: {
    readonly work: WorkRow
    readonly intent: DispatchIntentRow
    readonly candidate: Candidate
    readonly runId: string
    readonly workInputItemIds?: readonly string[] | undefined
    readonly now: Date
  },
): Promise<void> {
  const { work, intent, candidate, runId, now } = input
  const mandate = await getWorkMandateForUpdate(tx, intent.mandateId)
  if (
    mandate === undefined ||
    mandate.workId !== work.id ||
    mandate.version !== intent.mandateVersion ||
    mandate.status !== 'active' ||
    mandate.expiresAt.getTime() <= now.getTime()
  ) {
    throw new IntentBindingError('mandate is not active at the referenced version')
  }
  // ADR-0026 §13：无法核定输出上限/费用时不得派发；不把未知费用按零处理。
  if (candidate.maxTokens === null) throw new ExecutorBudgetError('executor_usage_unavailable')
  if (
    candidate.inputPriceMicrosPerMillionTokens === null ||
    candidate.outputPriceMicrosPerMillionTokens === null
  ) {
    throw new ExecutorBudgetError('executor_usage_unavailable')
  }
  // 预留必须覆盖一次 Run 的输入与输出上界。输入用与 Router 同族的保守估算
  // （byteSize*8 + prompt overhead）；maxTokens 是单次请求输出上限。
  const items =
    input.workInputItemIds === undefined
      ? []
      : await listWorkInboxItemsByIds(tx, input.workInputItemIds)
  const inputBytes =
    Buffer.byteLength(work.goal) +
    items.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0)
  const inputTokensEstimate = inputBytes * 8 + 16_384
  if (!Number.isSafeInteger(inputTokensEstimate))
    throw new ExecutorBudgetError('invalid_reservation')
  const reservedTokens = inputTokensEstimate + candidate.maxTokens
  const budget = await getWorkCoordinationBudget(tx, work.workKey)
  const usedTokens =
    (budget?.inputTokens ?? 0) + (budget?.outputTokens ?? 0) + (budget?.reservedTokens ?? 0)
  if (reservedTokens > mandate.maxTokens - usedTokens)
    throw new ExecutorBudgetError('budget_exhausted')
  let reservedCostMicros: number
  try {
    reservedCostMicros = coordinationUsageCost({
      inputTokens: inputTokensEstimate,
      outputTokens: candidate.maxTokens,
      inputPriceMicrosPerMillionTokens: candidate.inputPriceMicrosPerMillionTokens,
      outputPriceMicrosPerMillionTokens: candidate.outputPriceMicrosPerMillionTokens,
    })
  } catch {
    throw new ExecutorBudgetError('invalid_reservation')
  }
  const team = await getTeam(tx)
  if (team === undefined) throw new ExecutorBudgetError('team_missing')
  const cfg = await getRouterConfig(tx, work.projectId)
  const policy = await getCoordinationTeamPolicy(tx, team.id)
  // 团队日额度是团队级策略：项目没有 Router 配置也不能绕过。
  const teamLimits =
    policy !== undefined
      ? {
          calls: policy.dailyCallLimit,
          tokens: policy.dailyTokenLimit,
          costMicros: policy.dailyCostMicrosLimit,
        }
      : cfg !== undefined
        ? {
            calls: cfg.teamDailyCallLimit,
            tokens: cfg.teamDailyTokenLimit,
            costMicros: cfg.teamDailyCostMicrosLimit,
          }
        : undefined
  const projectLimits =
    cfg === undefined
      ? undefined
      : {
          calls: cfg.projectDailyCallLimit,
          tokens: cfg.projectDailyTokenLimit,
          costMicros: cfg.projectDailyCostMicrosLimit,
        }
  const reserved = await reserveExecutorUsage(tx, {
    runId,
    projectId: work.projectId,
    teamId: team.id,
    workKey: work.workKey,
    mandateId: mandate.id,
    utcDate: now.toISOString().slice(0, 10),
    reservedTokens,
    reservedCostMicros,
    workLimits: { tokens: mandate.maxTokens, costMicros: mandate.maxCostMicros },
    ...(teamLimits === undefined ? {} : { teamLimits }),
    ...(projectLimits === undefined ? {} : { projectLimits }),
  })
  if (!reserved.ok) throw new ExecutorBudgetError(reserved.reason)
}

async function createMachineRunForIntent(
  tx: Tx,
  deps: DispatchDeps,
  actor: { readonly userId: string; readonly role: 'owner' | 'admin' | 'member' },
  work: WorkRow,
  task: TaskRow,
  intent: DispatchIntentRow,
  candidate: Candidate,
  workInputItemIds: readonly string[] | undefined,
  now: Date,
  approvalBasis: 'human' | 'mandate',
  candidates: unknown[] = [],
  exclusionReasons: unknown[] = [],
): Promise<DispatchIntentView> {
  const run = await deps.orchestrator.createWithinTransaction(
    tx,
    { userId: asUserId(actor.userId), role: actor.role },
    task.id,
    {
      idempotencyKey: `machine-run:${intent.id}`,
      agentId: candidate.agentId,
      profileRevisionId: candidate.profileRevisionId,
      deviceId: candidate.deviceId,
      workspaceId: candidate.workspaceId,
      prompt: work.goal,
      dshDistributionVersion: candidate.dshDistributionVersion,
      ...(workInputItemIds === undefined ? {} : { workInputItemIds: [...workInputItemIds] }),
      origin: 'mandate',
      workKey: work.workKey,
      mandateId: intent.mandateId,
      dispatchIntentId: intent.id,
      onBehalfOfUserId: task.assigneeUserId,
      toolPolicy: {
        mode: 'draft',
        allowedToolNames: candidate.allowedToolNames,
        mandateVersion: candidate.mandateVersion,
        workKey: work.workKey,
      },
    },
  )
  // ADR-0028 §17（RD-03r2）：Run 创建与用量预留同事务；预留失败整体回滚，
  // 不留下未记账的机器 Run。
  await reserveExecutorForMachineRun(tx, {
    work,
    intent,
    candidate,
    runId: run.id,
    ...(workInputItemIds === undefined ? {} : { workInputItemIds }),
    now,
  })
  const target = {
    agentId: candidate.agentId,
    profileRevisionId: candidate.profileRevisionId,
    deviceId: candidate.deviceId,
    workspaceId: candidate.workspaceId,
    actionClass: candidate.actionClass,
  }
  const row =
    approvalBasis === 'mandate'
      ? await markDispatchIntentAutoDispatched(
          tx,
          intent.id,
          run.id,
          { ...target, candidates, exclusionReasons },
          now,
        )
      : await markDispatchIntentDispatched(tx, intent.id, run.id, target, now)
  if (row === undefined) throw conflict('dispatch intent changed concurrently')
  // Run 活跃期间工作不可再派工；终态由 run-status 复核回 active（RD-03a 不建下一 Run）。
  await updateWork(tx, work.id, {
    state: 'waiting',
    resumeMode: 'auto',
    resumeCondition: `run:${run.id}`,
    updatedAt: now,
  })
  return toDispatchIntentView(row, now)
}

function triggerRefMatchesItem(
  ref: TriggerRef,
  item: {
    readonly sourceType: string
    readonly sourceId: string
    readonly sourceVersion: string
    readonly sourceDigest: string
    readonly authorizationGeneration: string
  },
): boolean {
  return (
    ref.sourceType === item.sourceType &&
    ref.sourceId === item.sourceId &&
    ref.sourceVersion === item.sourceVersion &&
    ref.sourceDigest === item.sourceDigest &&
    ref.authorizationGeneration === item.authorizationGeneration
  )
}

interface AutoCandidateEvaluation {
  readonly candidate?: {
    readonly agentId: string
    readonly profileRevisionId: string
    readonly deviceId: string
    readonly workspaceId: string
    readonly actionClass: WorkActionClass
    readonly workInputItemIds: string[]
  }
  readonly candidates: unknown[]
  readonly exclusionReasons: unknown[]
}

async function evaluateAutoCandidate(
  tx: Tx,
  work: WorkRow,
  task: TaskRow,
  mandate: {
    readonly allowedAgentIds: string[]
    readonly allowedActionClasses: string[]
  },
  intent: DispatchIntentRow,
  now: Date,
  isOrdinaryDevice: (id: string) => boolean,
): Promise<AutoCandidateEvaluation> {
  const exclusionReasons: unknown[] = []
  const actionClass = (
    mandate.allowedActionClasses.includes('draft') ? 'draft' : mandate.allowedActionClasses[0]
  ) as WorkActionClass | undefined
  if (actionClass === undefined) {
    return {
      candidates: [],
      exclusionReasons: [{ kind: 'action_class', reason: 'no_allowed_action_class' }],
    }
  }
  if (mandate.allowedAgentIds.length === 0) {
    return {
      candidates: [],
      exclusionReasons: [{ kind: 'agent', reason: 'allowlist_empty' }],
    }
  }

  const eligibleAgents: Array<{ agentId: string; profileRevisionId: string }> = []
  for (const agentId of mandate.allowedAgentIds) {
    const agent = await getAgent(tx, agentId)
    if (agent === undefined || agent.archivedAt !== null) {
      exclusionReasons.push({ kind: 'agent', id: agentId, reason: 'unavailable' })
      continue
    }
    if (agent.currentRevisionId === null) {
      exclusionReasons.push({ kind: 'agent', id: agentId, reason: 'no_profile_revision' })
      continue
    }
    const revision = await getProfileRevision(tx, agent.currentRevisionId)
    if (revision === undefined || revision.agentId !== agent.id) {
      exclusionReasons.push({ kind: 'agent', id: agentId, reason: 'revision_missing' })
      continue
    }
    if (revision.approvalPolicy === 'full_access' || task.approvalPolicy === 'full_access') {
      exclusionReasons.push({ kind: 'agent', id: agentId, reason: 'full_access' })
      continue
    }
    // 无法核定输出上限/单价时该候选不能进入 Executor 预算；跳过它继续尝试
    // 下一个 allowlist Agent，而不是让首选 Agent 把整条自动链终态拒绝。
    if (
      revision.maxTokens === null ||
      revision.inputPriceMicrosPerMillionTokens === null ||
      revision.outputPriceMicrosPerMillionTokens === null
    ) {
      exclusionReasons.push({ kind: 'agent', id: agentId, reason: 'executor_usage_unavailable' })
      continue
    }
    eligibleAgents.push({ agentId: agent.id, profileRevisionId: revision.id })
  }
  const agent = eligibleAgents[0]
  if (agent === undefined) {
    return { candidates: [], exclusionReasons }
  }
  for (const extra of eligibleAgents.slice(1)) {
    exclusionReasons.push({ kind: 'agent', id: extra.agentId, reason: 'lower_priority' })
  }

  const devices = (await listDevicesByOwner(tx, task.assigneeUserId))
    .filter((device) => {
      if (!isOrdinaryDevice(device.id)) {
        exclusionReasons.push({ kind: 'device', id: device.id, reason: 'offline' })
        return false
      }
      if (device.revokedAt !== null) {
        exclusionReasons.push({ kind: 'device', id: device.id, reason: 'revoked' })
        return false
      }
      if (device.dshDistributionVersion === null) {
        exclusionReasons.push({ kind: 'device', id: device.id, reason: 'no_dsh_version' })
        return false
      }
      if (!contextCapabilitiesOf(device).includes(WORK_INPUT_CAPABILITY)) {
        exclusionReasons.push({
          kind: 'device',
          id: device.id,
          reason: 'missing_work_input_capability',
        })
        return false
      }
      if (deriveDeviceStatus(device, now) !== 'online') {
        exclusionReasons.push({ kind: 'device', id: device.id, reason: 'offline' })
        return false
      }
      return true
    })
    .sort((left, right) => {
      const rightSeen = right.lastSeenAt?.getTime() ?? 0
      const leftSeen = left.lastSeenAt?.getTime() ?? 0
      if (rightSeen !== leftSeen) return rightSeen - leftSeen
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
  if (devices.length === 0) {
    exclusionReasons.push({ kind: 'device', reason: 'no_online_device' })
    return { candidates: [], exclusionReasons }
  }

  const workspaces = await listWorkspacesByOwner(tx, task.assigneeUserId)
  let selected: { deviceId: string; workspaceId: string } | undefined
  for (const device of devices) {
    const candidates = workspaces
      .filter((workspace) => workspace.deviceId === device.id && workspace.available)
      .sort((left, right) => {
        const rightChecked = right.lastCheckedAt.getTime()
        const leftChecked = left.lastCheckedAt.getTime()
        if (rightChecked !== leftChecked) return rightChecked - leftChecked
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      })
    const workspace = candidates[0]
    if (workspace === undefined) {
      exclusionReasons.push({
        kind: 'workspace',
        deviceId: device.id,
        reason: 'no_available_workspace',
      })
      continue
    }
    selected = { deviceId: device.id, workspaceId: workspace.id }
    break
  }
  if (selected === undefined) {
    return { candidates: [], exclusionReasons }
  }

  const refs = parseTriggerRefs(intent.triggerRefs)
  const workInputItemIds: string[] = []
  let missingTrigger = false
  for (const ref of refs) {
    const item = await getLatestPendingInboxItemForSource(tx, work.id, ref.sourceType, ref.sourceId)
    if (item === undefined || !triggerRefMatchesItem(ref, item)) {
      missingTrigger = true
      exclusionReasons.push({
        kind: 'input',
        sourceId: ref.sourceId,
        reason: 'no_pending_trigger_item',
      })
      continue
    }
    workInputItemIds.push(item.id)
  }
  // 自动派工不能少带触发本次决定的输入：缺任一条就不是同一个执行前提。
  if (missingTrigger || workInputItemIds.length !== refs.length) {
    return { candidates: [], exclusionReasons }
  }

  const candidate = {
    ...agent,
    ...selected,
    actionClass,
    workInputItemIds,
  }
  return {
    candidate,
    candidates: [{ ...candidate, selected: true }],
    exclusionReasons,
  }
}

interface DispatchViewResult {
  readonly view: DispatchIntentView
}

interface DispatchRejectionResult {
  readonly rejection: {
    readonly status: number
    readonly code: ErrorCode
    readonly message: string
  }
}

type DispatchTxResult = DispatchViewResult | DispatchRejectionResult

function isRejection(value: DispatchTxResult): value is DispatchRejectionResult {
  return 'rejection' in value
}

export async function dispatchIntent(
  deps: DispatchDeps,
  actor: { readonly userId: string; readonly role: 'owner' | 'admin' | 'member' },
  workKey: string,
  intentId: string,
  request: DispatchIntentDispatchRequest,
  idempotencyKey: string,
): Promise<DispatchIntentOutcome> {
  let outcome: Awaited<ReturnType<typeof transactCommandWithOrigin<DispatchTxResult>>>
  try {
    outcome = await transactCommandWithOrigin<DispatchTxResult>(
      deps.database,
      // 幂等键必须绑定请求体：同一 key 换候选不是重放，不能被第一份回执吞掉。
      `work.dispatch.dispatch:${workKey}:${intentId}:${actor.userId}:${sha256Hex(
        canonicalJson(request),
      )}:${idempotencyKey}`,
      async (tx) => {
        const now = deps.now()
        const { work, task } = await lockWorkContext(tx, workKey)
        await requireAssignee(tx, task, actor.userId)
        assertActiveWork(work, task)
        const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work, task)
        // ADR-0029: a managed source needs a separate verified execution path. Never
        // hand this request to the ordinary machine Run, even on a capable-looking device.
        if (request.executionProfile === 'managed_draft_source') {
          throw conflict('managed draft source execution is unavailable')
        }
        const preparing = request.executionProfile === 'managed_draft_source_preparation'
        const placement = deps.managedDraftPlacement
        if (
          preparing &&
          (placement === undefined ||
            request.managedDraftSourceId === undefined ||
            request.workInputItemIds !== undefined ||
            request.actionClass !== 'draft' ||
            request.deviceId !== placement.host.deviceId ||
            request.workspaceId !== placement.host.workspaceId ||
            request.profileRevisionId !== placement.host.profileRevisionId ||
            actor.userId !== placement.host.ownerUserId)
        ) {
          throw conflict('managed draft source preparation is unavailable')
        }
        if (!preparing && !deps.orchestrator.isOrdinaryDevice(request.deviceId)) {
          throw new ApiError(409, 'DEVICE_OFFLINE', 'device is unavailable for ordinary execution')
        }
        if (!preparing && request.managedDraftSourceId !== undefined) {
          throw conflict('managed draft source preparation is required')
        }
        if (intent.status !== 'approved') {
          throw conflict(`dispatch intent is ${intent.status}; approve it first`)
        }
        if (intent.expiresAt.getTime() <= now.getTime()) {
          await expireDispatchIntent(tx, intent.id, 'dispatch intent has expired', now)
          return {
            rejection: {
              status: 409,
              code: 'CONFLICT',
              message: 'dispatch intent has expired',
            },
          }
        }

        let refs: TriggerRef[]
        let candidate: Candidate
        try {
          refs = await verifyIntentBinding(tx, work, intent)
          candidate = await resolveCandidate(tx, work, task, intent, request, now, preparing)
        } catch (error) {
          if (error instanceof IntentBindingError) {
            const rejected = await rejectIntentRow(tx, intent.id, error.message, now)
            if (rejected === undefined) {
              await expireDispatchIntent(tx, intent.id, error.message, now)
            }
            return {
              rejection: { status: 409, code: 'CONFLICT', message: error.message },
            }
          }
          throw error
        }
        if (preparing) {
          if (placement === undefined || request.managedDraftSourceId === undefined)
            throw conflict('managed draft source preparation is unavailable')
          const run = await queueManagedDraftPreparation(tx, deps.outbox, {
            actorUserId: actor.userId,
            workKey,
            now,
            intent,
            agentId: candidate.agentId,
            placement,
            sourceId: request.managedDraftSourceId,
          })
          const row = await markDispatchIntentDispatched(
            tx,
            intent.id,
            run.id,
            {
              agentId: run.agentId,
              profileRevisionId: run.profileRevisionId,
              deviceId: run.deviceId,
              workspaceId: run.workspaceId,
              actionClass: 'draft',
            },
            now,
          )
          if (row === undefined) throw conflict('dispatch intent changed concurrently')
          await updateWork(tx, work.id, {
            state: 'waiting',
            resumeMode: 'auto',
            resumeCondition: `run:${run.id}`,
            updatedAt: now,
          })
          return { view: toDispatchIntentView(row, now) }
        }
        await assertSelectedItemsInIntent(tx, work, task, refs, request.workInputItemIds)

        return {
          view: await createMachineRunForIntent(
            tx,
            deps,
            actor,
            work,
            task,
            intent,
            candidate,
            request.workInputItemIds,
            now,
            'human',
          ),
        }
      },
    )
  } catch (error) {
    if (!(error instanceof ExecutorBudgetError)) throw error
    await deps.database.transaction((tx) => rejectIntentRow(tx, intentId, error.reason, deps.now()))
    return { ok: false, status: 409, code: 'CONFLICT', message: error.reason }
  }
  if (isRejection(outcome.value)) {
    return { ok: false, ...outcome.value.rejection }
  }
  return {
    ok: true,
    intent: outcome.executed
      ? outcome.value.view
      : await refreshDispatchIntent(deps.database, intentId, deps.now()),
  }
}

/**
 * ADR-0028 §6（RD-03b）：autoDispatch='existing_task' 的系统直达。
 *
 * 与人工路径共用同一派工端口/创建核心；区别只在入口状态（proposed）、候选由
 * 端口按 Mandate 与现场确定性选择、approvalBasis 落 'mandate'。无候选/无输入/
 * 有活跃 Run 时保留 proposed 并记排除理由，成员仍可人工派工；绑定失效与预算耗尽
 * 是终态拒绝，避免无意义重试。
 */
export async function autoDispatchProposedIntent(
  deps: DispatchDeps,
  actor: { readonly userId: string; readonly role: 'owner' | 'admin' | 'member' },
  workKey: string,
  intentId: string,
): Promise<DispatchIntentView | null> {
  try {
    return await deps.database.transaction(async (tx) => {
      const now = deps.now()
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actor.userId)
      const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work, task)
      if (intent.status !== 'proposed') return toDispatchIntentView(intent, now)
      if (intent.expiresAt.getTime() <= now.getTime()) {
        await expireDispatchIntent(tx, intent.id, 'dispatch intent has expired', now)
        const row = await getDispatchIntent(tx, intent.id)
        return toDispatchIntentView(row ?? intent, now)
      }
      if (
        work.state !== 'active' ||
        task.assignmentStatus !== 'accepted' ||
        task.status === 'done' ||
        task.status === 'cancelled'
      ) {
        return toDispatchIntentView(intent, now)
      }

      const mandate = await getWorkMandateForUpdate(tx, intent.mandateId)
      if (
        mandate === undefined ||
        mandate.workId !== work.id ||
        mandate.version !== intent.mandateVersion ||
        mandate.status !== 'active' ||
        mandate.expiresAt.getTime() <= now.getTime()
      ) {
        const rejected = await rejectIntentRow(
          tx,
          intent.id,
          'mandate is not active at the referenced version',
          now,
        )
        return toDispatchIntentView(rejected ?? intent, now)
      }
      if (mandate.autoDispatch !== 'existing_task') return toDispatchIntentView(intent, now)

      // 自动派工跨了两个事务：应用提交后协调可能被暂停/停用。急停必须生效，
      // 意图保持 proposed，由成员人工决定。
      const coordinator = await getCoordinatorState(tx, work.projectId)
      if (coordinator !== undefined && (!coordinator.enabled || coordinator.pausedAt !== null)) {
        const row = await setDispatchIntentCandidates(
          tx,
          intent.id,
          [],
          [{ kind: 'coordinator', reason: 'paused' }],
          now,
        )
        return toDispatchIntentView(row ?? intent, now)
      }

      let refs: TriggerRef[]
      try {
        refs = await verifyIntentBinding(tx, work, intent)
      } catch (error) {
        if (error instanceof IntentBindingError) {
          const rejected = await rejectIntentRow(tx, intent.id, error.message, now)
          return toDispatchIntentView(rejected ?? intent, now)
        }
        throw error
      }

      if ((await listActiveRunsByTask(tx, task.id)).length > 0) {
        const row = await setDispatchIntentCandidates(
          tx,
          intent.id,
          [],
          [{ kind: 'run', reason: 'active_run' }],
          now,
        )
        return toDispatchIntentView(row ?? intent, now)
      }

      const budgetReason = await machineBudgetReason(tx, work, mandate)
      if (budgetReason !== undefined) {
        await setDispatchIntentCandidates(
          tx,
          intent.id,
          [],
          [{ kind: 'budget', reason: budgetReason }],
          now,
        )
        const rejected = await rejectIntentRow(tx, intent.id, budgetReason, now)
        return toDispatchIntentView(rejected ?? intent, now)
      }

      const evaluation = await evaluateAutoCandidate(tx, work, task, mandate, intent, now, (id) =>
        deps.orchestrator.isOrdinaryDevice(id),
      )
      if (evaluation.candidate === undefined) {
        const row = await setDispatchIntentCandidates(
          tx,
          intent.id,
          evaluation.candidates,
          evaluation.exclusionReasons,
          now,
        )
        // ADR-0028 §8（RD-03d2a）：无合格候选是确定性 ask，生成可绑定回答的 open 问题。
        await openNoCandidateQuestion(tx, {
          work,
          task,
          mandate,
          intent: row ?? intent,
          exclusionReasons: evaluation.exclusionReasons,
          now,
        })
        return toDispatchIntentView(row ?? intent, now)
      }

      let candidate: Candidate
      try {
        candidate = await resolveCandidate(tx, work, task, intent, evaluation.candidate, now)
        await assertSelectedItemsInIntent(
          tx,
          work,
          task,
          refs,
          evaluation.candidate.workInputItemIds,
        )
      } catch (error) {
        if (error instanceof IntentBindingError) {
          const rejected = await rejectIntentRow(tx, intent.id, error.message, now)
          return toDispatchIntentView(rejected ?? intent, now)
        }
        if (error instanceof ApiError) {
          const row = await setDispatchIntentCandidates(
            tx,
            intent.id,
            evaluation.candidates,
            [...evaluation.exclusionReasons, { kind: 'candidate', reason: error.code }],
            now,
          )
          return toDispatchIntentView(row ?? intent, now)
        }
        throw error
      }

      return createMachineRunForIntent(
        tx,
        deps,
        actor,
        work,
        task,
        intent,
        candidate,
        evaluation.candidate.workInputItemIds,
        now,
        'mandate',
        evaluation.candidates,
        evaluation.exclusionReasons,
      )
    })
  } catch (error) {
    if (!(error instanceof ExecutorBudgetError)) throw error
    return deps.database.transaction(async (tx) => {
      const now = deps.now()
      const current = await getDispatchIntent(tx, intentId)
      if (current === undefined) throw notFound()
      const rejected = await rejectIntentRow(tx, intentId, error.reason, now)
      return toDispatchIntentView(rejected ?? current, now)
    })
  }
}

/**
 * ADR-0028 §9：把在途机器 Run 的失效事实映射为受控原因。纯函数，便于逐分支钉住。
 * 优先级：Work 不可用 > 当前 Mandate 状态（revoked/paused/expired） > 版本切换。
 */
export function mandateInvalidationReason(
  facts: MachineRunMandateFacts,
  now: Date,
): MandateInvalidationReason | undefined {
  if (facts.mandateId === null) return undefined
  if (facts.status !== 'running' && facts.status !== 'waiting_approval') return undefined
  // 机器 Run 活跃期间 work 是 waiting(auto, run:<id>)（RD-03a），不是 active；
  // 只有其他 waiting/retired 才是 Work 不可用。
  const workAllowsRun =
    facts.workState === 'active' ||
    (facts.workState === 'waiting' &&
      facts.workResumeMode === 'auto' &&
      facts.workResumeCondition === `run:${facts.runId}`)
  if (!workAllowsRun) return 'work_unavailable'
  const pointerChanged = facts.workMandateId !== facts.mandateId
  if (pointerChanged) {
    if (facts.currentMandateStatus === 'revoked') return 'mandate_revoked'
    if (facts.currentMandateStatus === 'paused') return 'mandate_paused'
    if (facts.currentMandateStatus === 'expired') return 'mandate_expired'
    if (
      facts.currentMandateExpiresAt !== null &&
      facts.currentMandateExpiresAt.getTime() <= now.getTime()
    ) {
      return 'mandate_expired'
    }
    return 'mandate_changed'
  }
  if (facts.mandateStatus === 'revoked') return 'mandate_revoked'
  if (facts.mandateStatus === 'paused') return 'mandate_paused'
  if (facts.mandateStatus === 'expired') return 'mandate_expired'
  if (facts.mandateExpiresAt !== null && facts.mandateExpiresAt.getTime() <= now.getTime()) {
    return 'mandate_expired'
  }
  return undefined
}

/**
 * 标记单个在途 Run 并原子入队下行命令。Run 行 FOR UPDATE 与条件更新双重去重：
 * 并发清扫/回调重复到达时只有第一个事务能写入标记与命令。
 */
async function invalidateMachineRun(
  deps: Pick<DispatchDeps, 'database' | 'outbox' | 'now'>,
  facts: MachineRunMandateFacts,
  reason: MandateInvalidationReason,
): Promise<boolean> {
  const now = deps.now()
  return deps.database.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, facts.runId))
      .for('update')
    if (
      run === undefined ||
      run.origin !== 'mandate' ||
      run.mandateId === null ||
      run.mandateId !== facts.mandateId ||
      run.mandateInvalidatedAt !== null
    ) {
      return false
    }
    const updated = await markRunMandateInvalidated(tx, run.id, reason, now)
    if (updated === undefined) return false
    const commandId = randomUUID()
    const payload = RunMandateInvalidatedSchema.shape.payload.parse({
      commandId,
      runId: run.id,
      mandateId: run.mandateId,
      reason,
    })
    await deps.outbox.enqueue(tx, {
      id: commandId,
      deviceId: run.deviceId,
      type: 'run.mandate_invalidated',
      payload,
      notBefore: now,
    })
    return true
  })
}

/**
 * ADR-0028 §9（RD-03a/c2）：Mandate 新建/暂停/恢复/撤销提交后：
 * - queued / dispatching 仍走既有取消；
 * - running / waiting_approval 不自动杀死，标记失效并向 Node 下发实时信号。
 */
export async function cancelInvalidatedMachineRuns(
  deps: Pick<DispatchDeps, 'database' | 'orchestrator' | 'outbox' | 'now'>,
  actor: { readonly userId: string; readonly role: 'owner' | 'admin' | 'member' },
  workKey: string,
): Promise<{ cancelled: number; failed: number; invalidated: number; invalidateFailed: number }> {
  const work = await getWorkByKey(deps.database.db, workKey)
  if (work === undefined) {
    return { cancelled: 0, failed: 0, invalidated: 0, invalidateFailed: 0 }
  }
  const now = deps.now()
  const runIds = await listCancellableMachineRunIdsForWork(
    deps.database.db,
    work.id,
    work.mandateId,
  )
  let cancelled = 0
  let failed = 0
  for (const runId of runIds) {
    try {
      await deps.orchestrator.cancel({ userId: asUserId(actor.userId), role: actor.role }, runId)
      cancelled += 1
    } catch {
      // 单个 Run 的取消失败不阻断 Mandate 主流程；失败数由调用方记观测日志。
      failed += 1
    }
  }
  const facts = await listMachineRunsForMandateInvalidation(deps.database.db, {
    now,
    workId: work.id,
  })
  let invalidated = 0
  let invalidateFailed = 0
  for (const fact of facts) {
    const reason = mandateInvalidationReason(fact, now)
    if (reason === undefined) continue
    try {
      if (await invalidateMachineRun(deps, fact, reason)) invalidated += 1
    } catch {
      invalidateFailed += 1
    }
  }
  return { cancelled, failed, invalidated, invalidateFailed }
}

/**
 * ADR-0028 §9（RD-03c2）：周期清扫 Mandate 到期/版本漂移/Work 不可用的在途机器 Run。
 * 只标记并入队，不改变 Run 状态；终态与已标记行由条件更新跳过。
 */
export async function reconcileMandateInvalidation(
  deps: Pick<DispatchDeps, 'database' | 'outbox' | 'now'>,
  now: Date,
): Promise<{ invalidated: number; failed: number }> {
  const facts = await listMachineRunsForMandateInvalidation(deps.database.db, { now })
  let invalidated = 0
  let failed = 0
  for (const fact of facts) {
    const reason = mandateInvalidationReason(fact, now)
    if (reason === undefined) continue
    try {
      if (await invalidateMachineRun(deps, fact, reason)) invalidated += 1
    } catch {
      failed += 1
    }
  }
  return { invalidated, failed }
}

export async function refreshDispatchIntent(
  database: Database,
  intentId: string,
  now: Date,
): Promise<DispatchIntentView> {
  const row = await getDispatchIntent(database.db, intentId)
  if (row === undefined) throw notFound()
  return toDispatchIntentView(row, now)
}
