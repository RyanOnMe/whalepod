import {
  getLatestWorkMandate,
  getTask,
  getWorkByKey,
  getWorkSubscription,
  getWorkSubscriptionForUpdate,
  insertWorkSubscription,
  listWorkEntryAdmissions,
  listWorkSubscriptions,
  retractInboxItemsForSubscription,
  transactCommandWithOrigin,
  updateWorkSubscription,
  type Database,
  type WorkEntryAdmissionRow,
  type WorkSubscriptionRow,
  type Tx,
} from '@whalepod/db'
import {
  WorkEntryAdmissionViewSchema,
  WorkSubscriptionViewSchema,
  type CreateWorkSubscriptionRequest,
  type WorkEntryAdmissionView,
  type WorkSubscriptionView,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { effectiveMandate, taskIdOfBusinessRef } from './admission.js'
import { lockWorkContext, requireAssignee } from './context.js'

// ADR-0028（RD-02b）：显式订阅的写命令与读面。订阅只表达持续职责范围；
// 创建必须绑定当前有效 Mandate 版本，新版本/暂停/撤销会使旧订阅 stale。

export interface WorkSubscriptionDeps {
  readonly database: Database
  readonly now: () => Date
}

const BUSINESS_REF_PATTERN = /^[A-Za-z][A-Za-z0-9]*:[0-9a-fA-F-]{36}$/

export function toWorkSubscriptionView(row: WorkSubscriptionRow): WorkSubscriptionView {
  return WorkSubscriptionViewSchema.parse({
    id: row.id,
    workKey: row.workKey,
    targetType: row.targetType,
    targetRef: row.targetRef,
    status: row.status,
    authorizationGeneration: row.authorizationGeneration,
    mandateId: row.mandateId,
    mandateVersion: row.mandateVersion,
    createdByUserId: row.createdByUserId,
    endedByUserId: row.endedByUserId ?? null,
    statusReason: row.statusReason ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export function toWorkEntryAdmissionView(row: WorkEntryAdmissionRow): WorkEntryAdmissionView {
  return WorkEntryAdmissionViewSchema.parse({
    id: row.id,
    workKey: row.workKey,
    trigger: row.trigger,
    outcome: row.outcome,
    reason: row.reason,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceDigest: row.sourceDigest,
    authorizationGeneration: row.authorizationGeneration,
    subscriptionId: row.subscriptionId ?? null,
    inboxItemId: row.inboxItemId ?? null,
    routerInvoked: row.routerInvoked,
    routerCallId: row.routerCallId ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  })
}

function requestDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function requireOpenTask(task: {
  readonly status: string
  readonly assignmentStatus: string
  readonly approvalPolicy: string | null
}): void {
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new ApiError(409, 'TASK_TERMINAL', 'task is terminal')
  }
  if (task.assignmentStatus !== 'accepted') {
    throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
  }
  if (task.approvalPolicy === 'full_access') {
    throw new ApiError(409, 'CONFLICT', 'full_access task cannot receive subscriptions')
  }
}

interface TargetResolution {
  readonly sourceType: 'task_message' | 'context_entry'
  readonly authorizationGeneration: string
  /** 规范化后的 targetRef（UUID 段小写），保证与投影生成的 businessRef 一致。 */
  readonly targetRef: string
}

async function resolveSubscriptionTarget(
  tx: Tx,
  work: { readonly id: string; readonly taskId: string; readonly projectId: string },
  mandate: { readonly allowedSourceTypes: readonly string[] },
  input: CreateWorkSubscriptionRequest,
): Promise<TargetResolution> {
  if (input.targetType === 'task') {
    const targetRef = input.targetRef.toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(targetRef)) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'task subscription target must be a task id')
    }
    if (targetRef !== work.taskId) {
      throw new ApiError(409, 'CONFLICT', 'subscription target is outside the work task')
    }
    if (!mandate.allowedSourceTypes.includes('task_message')) {
      throw new ApiError(409, 'CONFLICT', 'mandate does not allow task messages')
    }
    return { sourceType: 'task_message', authorizationGeneration: 'member', targetRef }
  }

  const [prefix, ...segments] = input.targetRef.split(':')
  const targetRef = [prefix, ...segments.map((segment) => segment.toLowerCase())].join(':')
  if (!BUSINESS_REF_PATTERN.test(targetRef)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'business subscription target is malformed')
  }
  if (!mandate.allowedSourceTypes.includes('context_entry')) {
    throw new ApiError(409, 'CONFLICT', 'mandate does not allow context entries')
  }
  const taskId = await taskIdOfBusinessRef(tx, targetRef)
  if (taskId === undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'business reference is not resolvable')
  }
  if (taskId !== work.taskId) {
    throw new ApiError(409, 'CONFLICT', 'subscription target is outside the work task')
  }
  return { sourceType: 'context_entry', authorizationGeneration: 'internal', targetRef }
}

export interface WorkSubscriptionCommandResult {
  readonly value: WorkSubscriptionView
  readonly executed: boolean
}

export async function createWorkSubscription(
  deps: WorkSubscriptionDeps,
  actorUserId: string,
  workKey: string,
  input: CreateWorkSubscriptionRequest,
  idempotencyKey: string,
): Promise<WorkSubscriptionCommandResult> {
  return transactCommandWithOrigin(
    deps.database,
    `work.subscription.create:${workKey}:${actorUserId}:${requestDigest(input)}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      requireOpenTask(task)
      if (work.state !== 'active') {
        throw new ApiError(409, 'CONFLICT', 'only an active work can receive subscriptions', {
          workState: work.state,
        })
      }
      if (work.humanOwnerUserId !== task.assigneeUserId) {
        throw new ApiError(409, 'CONFLICT', 'work ownership changed; retire it before subscribing')
      }
      const now = deps.now()
      const latest = await getLatestWorkMandate(tx, work.id)
      const mandate = effectiveMandate(latest, now).active
      if (mandate === undefined) {
        throw new ApiError(409, 'CONFLICT', 'work has no active mandate')
      }
      const target = await resolveSubscriptionTarget(tx, work, mandate, input)
      const existing = await listWorkSubscriptions(tx, work.id)
      const active = existing.find(
        (row) =>
          row.status === 'active' &&
          row.targetType === input.targetType &&
          row.targetRef === target.targetRef,
      )
      if (active !== undefined) return toWorkSubscriptionView(active)

      const inserted = await insertWorkSubscription(tx, {
        id: uuidv7(now.getTime()),
        workId: work.id,
        workKey: work.workKey,
        projectId: work.projectId,
        taskId: work.taskId,
        targetType: input.targetType,
        targetRef: target.targetRef,
        status: 'active',
        authorizationGeneration: target.authorizationGeneration,
        mandateId: mandate.id,
        mandateVersion: mandate.version,
        createdByUserId: actorUserId,
        endedByUserId: null,
        statusReason: null,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      if (inserted !== undefined) return toWorkSubscriptionView(inserted)

      // 并发同身份：另一事务已写入 active 行，回读作为幂等结果。
      const raced = (await listWorkSubscriptions(tx, work.id)).find(
        (row) =>
          row.status === 'active' &&
          row.targetType === input.targetType &&
          row.targetRef === target.targetRef,
      )
      if (raced === undefined) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'work subscription insert lost without row')
      }
      return toWorkSubscriptionView(raced)
    },
  )
}

export async function revokeWorkSubscription(
  deps: WorkSubscriptionDeps,
  actorUserId: string,
  workKey: string,
  subscriptionId: string,
  reason: string | undefined,
  idempotencyKey: string,
): Promise<WorkSubscriptionCommandResult> {
  return transactCommandWithOrigin(
    deps.database,
    `work.subscription.revoke:${workKey}:${actorUserId}:${subscriptionId}:${requestDigest({ reason: reason ?? null })}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      const current = await getWorkSubscriptionForUpdate(tx, subscriptionId)
      if (current === undefined || current.workId !== work.id) {
        throw new ApiError(404, 'NOT_FOUND', 'work subscription not found')
      }
      if (current.status !== 'active') return toWorkSubscriptionView(current)
      const now = deps.now()
      const statusReason = reason ?? 'revoked_by_assignee'
      const updated = await updateWorkSubscription(tx, current.id, {
        status: 'revoked',
        endedAt: now,
        endedByUserId: actorUserId,
        statusReason,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'work subscription not found')
      await retractInboxItemsForSubscription(tx, updated.id, statusReason, now)
      return toWorkSubscriptionView(updated)
    },
  )
}

export async function refreshWorkSubscriptionForActor(
  database: Database,
  actorUserId: string,
  workKey: string,
  subscriptionId: string,
): Promise<WorkSubscriptionView> {
  return database.transaction(async (tx) => {
    const { work, task } = await lockWorkContext(tx, workKey)
    await requireAssignee(tx, task, actorUserId)
    const row = await getWorkSubscription(tx, subscriptionId)
    if (row === undefined || row.workId !== work.id) {
      throw new ApiError(404, 'NOT_FOUND', 'work subscription not found')
    }
    return toWorkSubscriptionView(row)
  })
}

export async function listWorkSubscriptionsForActor(
  database: Database,
  actorUserId: string,
  workKey: string,
): Promise<WorkSubscriptionView[]> {
  return database.transaction(
    async (tx) => {
      const work = await getWorkByKey(tx, workKey)
      if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
      const task = await getTask(tx, work.taskId)
      if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
      await requireAssignee(tx, task, actorUserId)
      return (await listWorkSubscriptions(tx, work.id)).map(toWorkSubscriptionView)
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

export async function listWorkEntryAdmissionsForActor(
  database: Database,
  actorUserId: string,
  workKey: string,
  limit: number,
): Promise<WorkEntryAdmissionView[]> {
  return database.transaction(
    async (tx) => {
      const work = await getWorkByKey(tx, workKey)
      if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
      const task = await getTask(tx, work.taskId)
      if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
      await requireAssignee(tx, task, actorUserId)
      return (await listWorkEntryAdmissions(tx, work.id, limit)).map(toWorkEntryAdmissionView)
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
