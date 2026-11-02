import {
  cancelProposedDispatchIntents,
  getAgent,
  getCurrentWorkByTask,
  getEnabledMember,
  getLatestWorkMandate,
  getProfileRevision,
  getTaskForUpdate,
  getTeam,
  getWorkByKey,
  getWorkByKeyForUpdate,
  getWorkMandate,
  getWorkMandateForUpdate,
  insertWork,
  insertWorkMandate,
  listWorkMandates,
  transactCommand,
  updateWork,
  unwrapPgError,
  type Database,
  type TaskRow,
  type Tx,
  type WorkMandateRow,
  type WorkRow,
} from '@whalepod/db'
import type { CreateWorkMandateRequest } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { uuidv7 } from '../shared/uuid.js'
import { toWorkMandateView, toWorkView } from './queries.js'

// ADR-0028（RD-01）：工作与 Mandate 的写命令。全部操作只锁 Task/Work/Mandate 行并写协调表，
// 不创建 Run、不写 outbox/team_event，也不调用模型。

export interface WorkCommandDeps {
  readonly database: Database
  readonly now: () => Date
}

interface LockedWork {
  readonly work: WorkRow
  readonly task: TaskRow
}

async function lockWorkContext(tx: Tx, workKey: string): Promise<LockedWork> {
  const snapshot = await getWorkByKey(tx, workKey)
  if (snapshot === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  // 锁序固定 task → work：创建工作、退休、Mandate 与准入检查共用，避免交叉死锁。
  const task = await getTaskForUpdate(tx, snapshot.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  const work = await getWorkByKeyForUpdate(tx, workKey)
  if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  if (work.taskId !== task.id) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'work and task are inconsistent')
  }
  return { work, task }
}

/** ADR-0028 §2/§6：只有 Task 当前 assignee 能占用或释放工作槽。 */
async function requireAssignee(tx: Tx, task: TaskRow, actorUserId: string): Promise<void> {
  if (task.assigneeUserId !== actorUserId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the task assignee can manage this work')
  }
  const team = await getTeam(tx)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  const member = await getEnabledMember(tx, team.id, actorUserId)
  if (member === undefined) throw new ApiError(403, 'FORBIDDEN', 'actor is not an active member')
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
  try {
    return await transactCommand(database, key, execute)
  } catch (error) {
    const mapped = mapWorkConstraint(error)
    if (mapped !== undefined) throw mapped
    throw error
  }
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
) {
  assertNoDuplicates(input.allowedActionClasses, 'allowedActionClasses')
  assertNoDuplicates(input.allowedSourceTypes, 'allowedSourceTypes')
  assertNoDuplicates(input.allowedAgentIds, 'allowedAgentIds')
  assertNoDuplicates(input.allowedToolNames, 'allowedToolNames')
  if (input.draftRecipientUserId !== undefined && input.draftRecipientUserId !== actorUserId) {
    // ADR-0028 §6/§7：RD-01 内草稿受众必须与 principal 同一成员。
    throw new ApiError(400, 'VALIDATION_FAILED', 'draft recipient must be the acting assignee')
  }
  return transactWork(
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
      if (work.state === 'retired') {
        throw new ApiError(409, 'CONFLICT', 'retired work cannot receive a mandate')
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
      // 新 Mandate 版本取代旧版本；旧 proposed 意图不得再被确认或派发。
      await cancelProposedDispatchIntents(tx, work.id, now)
      return toWorkMandateView(mandate, now, true)
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
) {
  return transactWork(
    deps.database,
    `work.mandate.${mutation}:${mandateId}:${actorUserId}:${requestDigest(reason ?? null)}:${idempotencyKey}`,
    async (tx) => {
      const snapshot = await getWorkMandate(tx, mandateId)
      if (snapshot === undefined) throw new ApiError(404, 'NOT_FOUND', 'mandate not found')
      const { work, task } = await lockWorkContext(tx, snapshot.workKey)
      await requireAssignee(tx, task, actorUserId)
      if (work.humanOwnerUserId !== actorUserId) {
        throw new ApiError(
          409,
          'CONFLICT',
          'work ownership changed; retire it before changing a mandate',
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
        return toWorkMandateView(current, now, true)
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
      // 任何新版本（暂停/恢复/撤销）都使旧 proposed 意图失效：它们引用的是旧版本。
      await cancelProposedDispatchIntents(tx, work.id, now)
      return toWorkMandateView(next, now, true)
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
    toWorkMandateView(row, now, index === 0 && work.state !== 'retired'),
  )
}
