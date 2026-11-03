import {
  cancelProposedDispatchIntents,
  expireWorkSubscriptionsAndRetract,
  getAgent,
  getCurrentWorkByTask,
  getLatestWorkMandate,
  getProfileRevision,
  getTaskForUpdate,
  getWorkByKey,
  getWorkMandate,
  getWorkMandateForUpdate,
  insertWork,
  insertWorkMandate,
  listWorkMandates,
  retractAutoAdmittedInboxItemsForWork,
  transactCommand,
  transactCommandWithOrigin,
  updateWork,
  unwrapPgError,
  type Database,
  type TaskRow,
  type Tx,
  type WorkMandateRow,
} from '@whalepod/db'
import type { CreateWorkMandateRequest, WorkMandateView } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { uuidv7 } from '../shared/uuid.js'
import { lockWorkContext, requireAssignee } from './context.js'
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

function mandateContract(
  input: CreateWorkMandateRequest,
): Omit<
  WorkMandateRow,
  | 'id'
  | 'workId'
  | 'workKey'
  | 'projectId'
  | 'taskId'
  | 'version'
  | 'status'
  | 'principalUserId'
  | 'onBehalfOfUserId'
  | 'humanOwnerUserId'
  | 'draftRecipientUserId'
  | 'statusReason'
  | 'pausedAt'
  | 'revokedAt'
  | 'createdAt'
  | 'updatedAt'
> {
  return {
    autoDispatch: input.autoDispatch,
    allowedActionClasses: input.allowedActionClasses,
    allowedSourceTypes: input.allowedSourceTypes,
    allowedAgentIds: input.allowedAgentIds,
    allowedToolNames: input.allowedToolNames,
    maxRunsPerWork: input.maxRunsPerWork,
    maxCostMicros: input.maxCostMicros,
    maxTokens: input.maxTokens,
    maxAttempts: input.maxAttempts,
    waitDeadlineSeconds: input.waitDeadlineSeconds,
    expiresAt: new Date(input.expiresAt),
  }
}

function requestDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ApiError(400, 'VALIDATION_FAILED', `${label} must not contain duplicates`)
  }
}

async function assertAllowedAgents(tx: Tx, agentIds: readonly string[]): Promise<void> {
  for (const agentId of agentIds) {
    const agent = await getAgent(tx, agentId)
    if (agent === undefined || agent.archivedAt !== null) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'allowed agent is missing or archived')
    }
    if (agent.currentRevisionId === null) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'allowed agent has no profile revision')
    }
    const revision = await getProfileRevision(tx, agent.currentRevisionId)
    if (revision === undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'allowed agent has no profile revision')
    }
    // ADR-0028 §5：full_access 不能成为自主派工候选。
    if (revision.approvalPolicy === 'full_access') {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'full_access agent cannot be a mandate candidate',
      )
    }
  }
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
      if (work.state === 'retired') return toWorkView(work)
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
      return toWorkView(updated)
    },
  )
}

export async function createWorkMandate(
  deps: WorkCommandDeps,
  actorUserId: string,
  workKey: string,
  input: CreateWorkMandateRequest,
  idempotencyKey: string,
): Promise<WorkMutationOutcome<WorkMandateView>> {
  assertNoDuplicates(input.allowedActionClasses, 'allowedActionClasses')
  assertNoDuplicates(input.allowedSourceTypes, 'allowedSourceTypes')
  assertNoDuplicates(input.allowedAgentIds, 'allowedAgentIds')
  assertNoDuplicates(input.allowedToolNames, 'allowedToolNames')
  if (input.draftRecipientUserId !== undefined && input.draftRecipientUserId !== actorUserId) {
    // ADR-0028 §6/§7：RD-01 内草稿受众必须与 principal 同一成员。
    throw new ApiError(400, 'VALIDATION_FAILED', 'draft recipient must be the acting assignee')
  }
  return transactWorkMutation(
    deps.database,
    `work.mandate.create:${workKey}:${actorUserId}:${requestDigest(input)}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      requireAcceptedTask(task)
      const now = deps.now()
      if (new Date(input.expiresAt).getTime() <= now.getTime()) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'expiresAt must be in the future')
      }
      if (task.approvalPolicy === 'full_access') {
        throw new ApiError(409, 'CONFLICT', 'full_access task cannot receive a mandate')
      }
      if (work.humanOwnerUserId !== actorUserId) {
        // Task 改派后旧工作不随新 assignee 复活；新 assignee 只能显式退休后另建工作。
        throw new ApiError(
          409,
          'CONFLICT',
          'work ownership changed; retire it before creating a mandate',
        )
      }
      if (work.state !== 'active') {
        throw new ApiError(409, 'CONFLICT', 'only an active work can receive a mandate')
      }
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
      await updateWork(tx, work.id, { mandateId: mandate.id, updatedAt: now })
      // 新 Mandate 版本取代旧版本；旧 proposed 意图与订阅都引用旧版本，必须失效。
      await cancelProposedDispatchIntents(tx, work.id, now)
      await expireWorkSubscriptionsAndRetract(tx, {
        workId: work.id,
        statusReason: 'mandate_superseded',
        now,
      })
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
