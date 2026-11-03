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
  expireDispatchIntent,
  getAgent,
  getDispatchIntent,
  getDispatchIntentForUpdate,
  getProfileRevision,
  getWorkByKey,
  getWorkMandateForUpdate,
  listQueuedMachineRunIdsForWork,
  listWorkInboxItemsByIds,
  approveDispatchIntent as approveIntentRow,
  markDispatchIntentDispatched,
  rejectDispatchIntent as rejectIntentRow,
  transactCommandWithOrigin,
  updateWork,
  unwrapPgError,
  type Database,
  type DispatchIntentRow,
  type TaskRow,
  type Tx,
  type WorkRow,
} from '@whalepod/db'
import { asUserId, DomainError } from '@whalepod/domain'
import type {
  DispatchIntentDispatchRequest,
  DispatchIntentView,
  ErrorCode,
  WorkActionClass,
  WorkSourceType,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { ERROR_HTTP_STATUS, errorCodeOf } from '../run/routes.js'
import { getDeviceDshDistributionVersion } from '../run/queries.js'
import type { RunOrchestrator } from '../run/orchestrator.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { lockWorkContext, requireAssignee } from '../work/context.js'
import { loadWorkSource, WORK_ADMISSION_RULES_VERSION } from '../work/admission.js'
import { toDispatchIntentView } from '../work/queries.js'

export interface DispatchDeps {
  readonly database: Database
  readonly orchestrator: RunOrchestrator
  readonly now: () => Date
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
      if (error instanceof ApiError) {
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
}

async function resolveCandidate(
  tx: Tx,
  work: WorkRow,
  task: TaskRow,
  intent: DispatchIntentRow,
  request: DispatchIntentDispatchRequest,
  now: Date,
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
  const dshDistributionVersion = await getDeviceDshDistributionVersion(tx, request.deviceId, now)
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
  const outcome = await transactCommandWithOrigin<DispatchTxResult>(
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
        candidate = await resolveCandidate(tx, work, task, intent, request, now)
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
      await assertSelectedItemsInIntent(tx, work, task, refs, request.workInputItemIds)

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
          ...(request.workInputItemIds === undefined
            ? {}
            : { workInputItemIds: request.workInputItemIds }),
          origin: 'mandate',
          workKey: work.workKey,
          mandateId: intent.mandateId,
          dispatchIntentId: intent.id,
          onBehalfOfUserId: task.assigneeUserId,
        },
      )
      const row = await markDispatchIntentDispatched(
        tx,
        intent.id,
        run.id,
        {
          agentId: candidate.agentId,
          profileRevisionId: candidate.profileRevisionId,
          deviceId: candidate.deviceId,
          workspaceId: candidate.workspaceId,
          actionClass: candidate.actionClass,
        },
        now,
      )
      if (row === undefined) throw conflict('dispatch intent changed concurrently')
      // Run 活跃期间工作不可再派工；终态由 run-status 复核回 active（RD-03a 不建下一 Run）。
      await updateWork(tx, work.id, {
        state: 'waiting',
        resumeMode: 'auto',
        resumeCondition: `run:${run.id}`,
        updatedAt: now,
      })
      return { view: toDispatchIntentView(row, now) }
    },
  )
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
 * ADR-0028 §9（RD-03a）：Mandate 新建/暂停/恢复/撤销提交后，已派发但仍 queued 的
 * 机器 Run 不得继续执行。work 模块只发回调，组合根在这里按 Run 逐个走既有取消
 * 事务（会同时作废 run.start 并让 work 从 waiting(auto) 回 active）。
 */
export async function cancelQueuedMachineRuns(
  deps: Pick<DispatchDeps, 'database' | 'orchestrator' | 'now'>,
  actor: { readonly userId: string; readonly role: 'owner' | 'admin' | 'member' },
  workKey: string,
): Promise<{ cancelled: number; failed: number }> {
  const work = await getWorkByKey(deps.database.db, workKey)
  if (work === undefined) return { cancelled: 0, failed: 0 }
  const runIds = await listQueuedMachineRunIdsForWork(deps.database.db, work.id)
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
  return { cancelled, failed }
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
