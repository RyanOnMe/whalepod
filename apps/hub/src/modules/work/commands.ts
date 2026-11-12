import {
  advanceDiscoveryCatalogGeneration,
  cancelProposedDispatchIntents,
  expireWorkSubscriptionsAndRetract,
  getCurrentWorkByTask,
  getDiscoveryApplicationByWork,
  getLatestWorkMandate,
  getTaskForUpdate,
  getWorkByKey,
  getWorkMandate,
  getWorkMandateForUpdate,
  insertWork,
  insertWorkMandate,
  listWorkMandates,
  retractAutoAdmittedInboxItemsForWork,
  supersedePendingWorkMandateProposals,
  transactCommand,
  transactCommandWithOrigin,
  updateWork,
  unwrapPgError,
  type Database,
  type TaskRow,
  type Tx,
  type WorkMandateRow,
  type WorkRow,
} from '@whalepod/db'
import type { CreateWorkMandateRequest, WorkMandateView } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { uuidv7 } from '../shared/uuid.js'
import { lockWorkContext, requireAssignee } from './context.js'
import { assertAllowedAgents, assertMandateScope, mandateContract } from './mandate-scope.js'
import { toWorkMandateView, toWorkView } from './queries.js'

// ADR-0028（RD-01）：工作与 Mandate 的写命令。全部操作只锁 Task/Work/Mandate 行并写协调表，
// 不创建 Run、不写 outbox/team_event，也不调用模型。

export interface WorkCommandDeps {
  readonly database: Database
  readonly now: () => Date
}

function requireAcceptedTask(task: TaskRow): void {
  if (task.assignmentStatus !== 'accepted') {
    throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new ApiError(409, 'TASK_TERMINAL', 'task is terminal')
  }
}

function requestDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function mapWorkConstraint(error: unknown): ApiError | undefined {
  const pg = unwrapPgError(error)
  if (pg === undefined) return undefined
  if (pg.code === '23505') {
    if (pg.constraintName === 'work_task_current_unique') {
      return new ApiError(409, 'CONFLICT', 'task already has a non-retired work')
    }
    if (pg.constraintName === 'work_mandate_work_version_unique') {
      return new ApiError(409, 'CONFLICT', 'mandate changed concurrently; retry')
    }
    if (pg.constraintName === 'work_inbox_item_source_pending_unique') {
      return new ApiError(409, 'CONFLICT', 'source already has a pending inbox item; retry')
    }
    return new ApiError(409, 'CONFLICT', 'work identity already exists')
  }
  if (pg.code === '23514' || pg.code === '23503') {
    return new ApiError(400, 'VALIDATION_FAILED', 'work data violates a constraint')
  }
  return undefined
}

async function transactWork<T>(
  database: Database,
  key: string,
  execute: (tx: Tx) => Promise<T>,
): Promise<T> {
  return (await transactWorkWithOrigin(database, key, execute)).value
}

async function transactWorkWithOrigin<T>(
  database: Database,
  key: string,
  execute: (tx: Tx) => Promise<T>,
) {
  try {
    return await transactCommandWithOrigin(database, key, execute)
  } catch (error) {
    const mapped = mapWorkConstraint(error)
    if (mapped !== undefined) throw mapped
    throw error
  }
}

/**
 * Mandate 变更命令的结果：`changed` 只有“本次请求真的推进了状态”才为 true。
 * 调用方据此决定是否触发派工副作用——同 key 重放与 no-op（如 resume 已 active
 * 的当前版本）都不能取消别的 Run。
 */
export interface WorkMutationOutcome<T> {
  readonly view: T
  readonly changed: boolean
}

async function transactWorkMutation<T>(
  database: Database,
  key: string,
  execute: (tx: Tx) => Promise<{ view: T; changed: boolean }>,
): Promise<WorkMutationOutcome<T>> {
  const outcome = await transactWorkWithOrigin(database, key, execute)
  // 旧版本回执是裸 view；升级后同 key 重放仍要能读。新回执是 {view, changed}，
  // 但任何重放都不算“本次推进了状态”，changed 一律 false。
  const raw = outcome.value as T | { view: T; changed: boolean }
  const value =
    typeof raw === 'object' && raw !== null && 'view' in raw
      ? raw
      : { view: raw as T, changed: false }
  return { view: value.view, changed: outcome.executed && value.changed }
}

export async function createWork(
  deps: WorkCommandDeps,
  actorUserId: string,
  taskId: string,
  input: { readonly goal: string },
  idempotencyKey: string,
) {
  return transactWork(
    deps.database,
    `work.create:${taskId}:${actorUserId}:${requestDigest(input)}:${idempotencyKey}`,
    async (tx) => {
      const task = await getTaskForUpdate(tx, taskId)
      if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
      await requireAssignee(tx, task, actorUserId)
      requireAcceptedTask(task)
      const existing = await getCurrentWorkByTask(tx, taskId)
      if (existing !== undefined) {
        throw new ApiError(409, 'CONFLICT', 'task already has a non-retired work')
      }
      const now = deps.now()
      const work = await insertWork(tx, {
        id: uuidv7(now.getTime()),
        projectId: task.projectId,
        taskId: task.id,
        workKey: uuidv7(now.getTime()),
        humanOwnerUserId: task.assigneeUserId,
        goal: input.goal,
        state: 'active',
        createdAt: now,
        updatedAt: now,
      })
      // Work goal is part of the slot coverage scope; old catalog verification is stale.
      await advanceDiscoveryCatalogGeneration(tx, task.projectId, now)
      return toWorkView(work)
    },
  )
}

export async function retireWork(
  deps: WorkCommandDeps,
  actorUserId: string,
  workKey: string,
  idempotencyKey: string,
) {
  return transactWork(
    deps.database,
    `work.retire:${workKey}:${actorUserId}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      if (work.state === 'retired') {
        // Task 终态等路径可能已退休工作但留下旧草案；幂等 retire 也要收口。
        await supersedePendingWorkMandateProposals(tx, { workId: work.id, now: deps.now() })
        return toWorkView(work)
      }
      const now = deps.now()
      const updated = await updateWork(tx, work.id, {
        state: 'retired',
        resumeMode: null,
        resumeCondition: null,
        retiredAt: now,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
      await cancelProposedDispatchIntents(tx, work.id, now)
      await expireWorkSubscriptionsAndRetract(tx, {
        workId: work.id,
        statusReason: 'work_retired',
        now,
      })
      await retractAutoAdmittedInboxItemsForWork(tx, {
        workId: work.id,
        statusReason: 'work_retired',
        now,
      })
      await supersedePendingWorkMandateProposals(tx, { workId: work.id, now })
      // Retirement removes the Work from the catalog; old slot verification must not survive it.
      await advanceDiscoveryCatalogGeneration(tx, task.projectId, now)
      return toWorkView(updated)
    },
  )
}

async function assertDiscoveryWorkCanNotDispatch(tx: Tx, workId: string): Promise<void> {
  if (await getDiscoveryApplicationByWork(tx, workId)) {
    throw new ApiError(
      409,
      'CONFLICT',
      'discovery-created work has no execution authorization in this slice',
    )
  }
}

/**
 * RD-03d2b：创建 `version=latest+1` 的 active Mandate 并把 work 指针指向它。
 * 新版本使旧 proposed 意图、订阅与仍然 pending 的扩权草案一起失效；确认路径用
 * `keepProposalId` 保留正在确认的草案，在该事务内随后标记为 confirmed。
 */
export async function insertActiveMandateVersion(
  tx: Tx,
  input: {
    readonly work: WorkRow
    readonly actorUserId: string
    readonly scope: CreateWorkMandateRequest
    readonly now: Date
    readonly subscriptionReason: string
    readonly keepProposalId?: string
  },
): Promise<WorkMandateRow> {
  const { work, actorUserId, scope, now } = input
  // ADR-0030 §4：RD-04b 只立项。发现物化的 Work 没有执行授权，任何派工入口都拒绝；
  // RD-04c 引入 execute 档并具备调用级费用守卫后，才允许在这里放行子 Mandate。
  await assertDiscoveryWorkCanNotDispatch(tx, work.id)
  const latest = await getLatestWorkMandate(tx, work.id)
  const version = (latest?.version ?? 0) + 1
  const mandate = await insertWorkMandate(tx, {
    id: uuidv7(now.getTime()),
    workId: work.id,
    workKey: work.workKey,
    projectId: work.projectId,
    taskId: work.taskId,
    version,
    status: 'active',
    principalUserId: actorUserId,
    onBehalfOfUserId: actorUserId,
    humanOwnerUserId: actorUserId,
    draftRecipientUserId: actorUserId,
    ...mandateContract(scope),
    statusReason: null,
    pausedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  })
  await updateWork(tx, work.id, { mandateId: mandate.id, updatedAt: now })
  // 新 Mandate 版本取代旧版本；旧 proposed 意图与订阅都引用旧版本，必须失效。
  await cancelProposedDispatchIntents(tx, work.id, now)
  await expireWorkSubscriptionsAndRetract(tx, {
    workId: work.id,
    statusReason: input.subscriptionReason,
    now,
  })
  await supersedePendingWorkMandateProposals(tx, {
    workId: work.id,
    now,
    ...(input.keepProposalId === undefined ? {} : { exceptId: input.keepProposalId }),
  })
  return mandate
}

export async function createWorkMandate(
  deps: WorkCommandDeps,
  actorUserId: string,
  workKey: string,
  input: CreateWorkMandateRequest,
  idempotencyKey: string,
): Promise<WorkMutationOutcome<WorkMandateView>> {
  return transactWorkMutation(
    deps.database,
    `work.mandate.create:${workKey}:${actorUserId}:${requestDigest(input)}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      requireAcceptedTask(task)
      const now = deps.now()
      assertMandateScope(input, actorUserId, now)
      if (task.approvalPolicy === 'full_access') {
        throw new ApiError(409, 'CONFLICT', 'full_access task cannot receive a mandate')
      }
      if (work.humanOwnerUserId !== actorUserId) {
        // Task 改派后旧工作不随新 assignee 复活；新 assignee 先 accept 承接或退休后另建工作。
        throw new ApiError(
          409,
          'CONFLICT',
          'work ownership changed; accept the work or retire it before creating a mandate',
        )
      }
      if (work.state !== 'active') {
        throw new ApiError(409, 'CONFLICT', 'only an active work can receive a mandate')
      }
      await assertAllowedAgents(tx, input.allowedAgentIds)
      const mandate = await insertActiveMandateVersion(tx, {
        work,
        actorUserId,
        scope: input,
        now,
        subscriptionReason: 'mandate_superseded',
      })
      return { view: toWorkMandateView(mandate, now, true), changed: true }
    },
  )
}

/**
 * ADR-0028 §2/§6（RD-03d1）：Task 改派后，新 assignee 显式承接旧工作。
 *
 * 承接不是恢复旧 Mandate：同一事务内建立属于新 assignee 的新 Mandate 版本
 * （principal/onBehalf/humanOwner/draftRecipient 都是新 assignee），再把 work
 * 归到新 owner/新 Mandate。旧 Mandate 原样保留为历史，不转移、不改写。
 */
export async function acceptWorkAfterOwnerChange(
  deps: WorkCommandDeps,
  actorUserId: string,
  workKey: string,
  input: CreateWorkMandateRequest,
  idempotencyKey: string,
): Promise<WorkMutationOutcome<WorkMandateView>> {
  return transactWorkMutation(
    deps.database,
    `work.accept:${workKey}:${actorUserId}:${requestDigest(input)}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      requireAcceptedTask(task)
      if (task.approvalPolicy === 'full_access') {
        throw new ApiError(409, 'CONFLICT', 'full_access task cannot receive a mandate')
      }
      if (work.state !== 'waiting' || work.resumeMode !== 'owner_confirmation') {
        throw new ApiError(409, 'CONFLICT', 'work is not waiting for owner confirmation')
      }
      await assertDiscoveryWorkCanNotDispatch(tx, work.id)
      const now = deps.now()
      assertMandateScope(input, actorUserId, now)
      await assertAllowedAgents(tx, input.allowedAgentIds)
      const latest = await getLatestWorkMandate(tx, work.id)
      const version = (latest?.version ?? 0) + 1
      const mandate = await insertWorkMandate(tx, {
        id: uuidv7(now.getTime()),
        workId: work.id,
        workKey: work.workKey,
        projectId: work.projectId,
        taskId: work.taskId,
        version,
        status: 'active',
        principalUserId: actorUserId,
        onBehalfOfUserId: actorUserId,
        humanOwnerUserId: actorUserId,
        draftRecipientUserId: actorUserId,
        ...mandateContract(input),
        statusReason: null,
        pausedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      const updated = await updateWork(tx, work.id, {
        state: 'active',
        resumeMode: null,
        resumeCondition: null,
        humanOwnerUserId: actorUserId,
        mandateId: mandate.id,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
      // 旧 proposed 意图/订阅引用旧 Mandate；承接后必须重新评估，不得沿用。
      await cancelProposedDispatchIntents(tx, work.id, now)
      await expireWorkSubscriptionsAndRetract(tx, {
        workId: work.id,
        statusReason: 'owner_changed_accept',
        now,
      })
      await supersedePendingWorkMandateProposals(tx, { workId: work.id, now })
      // waiting → active changes the catalog's work state.
      await advanceDiscoveryCatalogGeneration(tx, work.projectId, now)
      return { view: toWorkMandateView(mandate, now, true), changed: true }
    },
  )
}

export type MandateMutation = 'pause' | 'resume' | 'revoke'

export async function changeWorkMandateStatus(
  deps: WorkCommandDeps,
  actorUserId: string,
  mandateId: string,
  mutation: MandateMutation,
  reason: string | undefined,
  idempotencyKey: string,
): Promise<WorkMutationOutcome<WorkMandateView>> {
  return transactWorkMutation(
    deps.database,
    `work.mandate.${mutation}:${mandateId}:${actorUserId}:${requestDigest(reason ?? null)}:${idempotencyKey}`,
    async (tx) => {
      const snapshot = await getWorkMandate(tx, mandateId)
      if (snapshot === undefined) throw new ApiError(404, 'NOT_FOUND', 'mandate not found')
      const { work, task } = await lockWorkContext(tx, snapshot.workKey)
      await requireAssignee(tx, task, actorUserId)
      if (work.humanOwnerUserId !== actorUserId && mutation !== 'revoke') {
        throw new ApiError(
          409,
          'CONFLICT',
          'work ownership changed; only revoke or retire is allowed',
        )
      }
      if (work.state === 'retired') {
        throw new ApiError(409, 'CONFLICT', 'retired work cannot change mandate status')
      }
      const current = await getWorkMandateForUpdate(tx, mandateId)
      if (current === undefined) throw new ApiError(404, 'NOT_FOUND', 'mandate not found')
      if (current.workId !== work.id || current.workKey !== work.workKey) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'mandate and work are inconsistent')
      }
      const latest = await getLatestWorkMandate(tx, work.id)
      if (latest?.id !== current.id) {
        throw new ApiError(409, 'CONFLICT', 'only the current mandate can change status')
      }
      const now = deps.now()
      if (current.expiresAt.getTime() <= now.getTime()) {
        throw new ApiError(409, 'CONFLICT', 'mandate has expired')
      }
      if (current.status === mutationTargetStatus(mutation)) {
        return { view: toWorkMandateView(current, now, work.state === 'active'), changed: false }
      }
      const allowed =
        mutation === 'pause'
          ? current.status === 'active'
          : mutation === 'resume'
            ? current.status === 'paused'
            : current.status === 'active' || current.status === 'paused'
      if (!allowed) {
        throw new ApiError(409, 'CONFLICT', `cannot ${mutation} a ${current.status} mandate`)
      }
      const status = mutationTargetStatus(mutation)
      const next = await insertWorkMandate(tx, {
        id: uuidv7(now.getTime()),
        workId: current.workId,
        workKey: current.workKey,
        projectId: current.projectId,
        taskId: current.taskId,
        version: current.version + 1,
        status,
        principalUserId: current.principalUserId,
        onBehalfOfUserId: current.onBehalfOfUserId,
        humanOwnerUserId: current.humanOwnerUserId,
        draftRecipientUserId: current.draftRecipientUserId,
        autoDispatch: current.autoDispatch,
        allowedActionClasses: current.allowedActionClasses,
        allowedSourceTypes: current.allowedSourceTypes,
        allowedAgentIds: current.allowedAgentIds,
        allowedToolNames: current.allowedToolNames,
        maxRunsPerWork: current.maxRunsPerWork,
        maxCostMicros: current.maxCostMicros,
        maxTokens: current.maxTokens,
        maxAttempts: current.maxAttempts,
        waitDeadlineSeconds: current.waitDeadlineSeconds,
        expiresAt: current.expiresAt,
        statusReason: reason ?? null,
        pausedAt: status === 'paused' ? now : null,
        revokedAt: status === 'revoked' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      await updateWork(tx, work.id, { mandateId: next.id, updatedAt: now })
      // 任何新版本（暂停/恢复/撤销）都使旧 proposed 意图与订阅失效：它们引用旧版本。
      await cancelProposedDispatchIntents(tx, work.id, now)
      await expireWorkSubscriptionsAndRetract(tx, {
        workId: work.id,
        statusReason: `mandate_${mutation}`,
        now,
      })
      await supersedePendingWorkMandateProposals(tx, { workId: work.id, now })
      return { view: toWorkMandateView(next, now, work.state === 'active'), changed: true }
    },
  )
}

function mutationTargetStatus(mutation: MandateMutation): 'paused' | 'active' | 'revoked' {
  return mutation === 'pause' ? 'paused' : mutation === 'resume' ? 'active' : 'revoked'
}

export async function listWorkMandateViews(database: Database, workKey: string, now: Date) {
  const work = await getWorkByKey(database.db, workKey)
  if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  const rows = await listWorkMandates(database.db, work.id)
  return rows.map((row, index) =>
    toWorkMandateView(row, now, index === 0 && work.state === 'active'),
  )
}
