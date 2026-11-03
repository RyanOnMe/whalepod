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
  getAgent,
  getDispatchIntent,
  getDispatchIntentForUpdate,
  getProfileRevision,
  getWorkMandateForUpdate,
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
  WorkActionClass,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { ERROR_HTTP_STATUS, errorCodeOf } from '../run/routes.js'
import type { RunOrchestrator } from '../run/orchestrator.js'
import { lockWorkContext, requireAssignee } from '../work/context.js'
import { toDispatchIntentView } from '../work/queries.js'

export interface DispatchDeps {
  readonly database: Database
  readonly orchestrator: RunOrchestrator
  readonly now: () => Date
  readonly dshDistributionVersionFor: (deviceId: string) => Promise<string | undefined>
}

function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'dispatch intent not found')
}

function conflict(message: string): ApiError {
  return new ApiError(409, 'CONFLICT', message)
}

function assertIntentOwned(
  intent: DispatchIntentRow | undefined,
  work: WorkRow,
): DispatchIntentRow {
  if (intent === undefined || intent.workId !== work.id) throw notFound()
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
      const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work)
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
      const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work)
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
  deps: DispatchDeps,
  work: WorkRow,
  task: TaskRow,
  intent: DispatchIntentRow,
  request: DispatchIntentDispatchRequest,
  now: Date,
): Promise<Candidate> {
  if (work.mandateId === null || work.mandateId !== intent.mandateId) {
    throw conflict('work mandate changed; dispatch must be re-evaluated')
  }
  const mandate = await getWorkMandateForUpdate(tx, intent.mandateId)
  if (
    mandate === undefined ||
    mandate.workId !== work.id ||
    mandate.version !== intent.mandateVersion ||
    mandate.status !== 'active' ||
    mandate.expiresAt.getTime() <= now.getTime()
  ) {
    throw conflict('mandate is not active at the referenced version')
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
  const dshDistributionVersion = await deps.dshDistributionVersionFor(request.deviceId)
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

export async function dispatchIntent(
  deps: DispatchDeps,
  actor: { readonly userId: string; readonly role: 'owner' | 'admin' | 'member' },
  workKey: string,
  intentId: string,
  request: DispatchIntentDispatchRequest,
  idempotencyKey: string,
): Promise<DispatchIntentView> {
  const outcome = await transactCommandWithOrigin(
    deps.database,
    `work.dispatch.dispatch:${workKey}:${intentId}:${actor.userId}:${idempotencyKey}`,
    async (tx) => {
      const now = deps.now()
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actor.userId)
      assertActiveWork(work, task)
      const intent = assertIntentOwned(await getDispatchIntentForUpdate(tx, intentId), work)
      if (intent.status !== 'approved') {
        throw conflict(`dispatch intent is ${intent.status}; approve it first`)
      }
      assertIntentLive(intent, now)
      const candidate = await resolveCandidate(tx, deps, work, task, intent, request, now)
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
      return toDispatchIntentView(row, now)
    },
  )
  return outcome.executed
    ? outcome.value
    : refreshDispatchIntent(deps.database, intentId, deps.now())
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
