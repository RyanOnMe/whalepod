import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  getEnabledMember,
  getLatestWorkMandate,
  getTask,
  getTeam,
  getWorkByKey,
  listWorksByTask,
  type Database,
  type TaskRow,
  type WorkRow,
} from '@whalepod/db'
import {
  AssociateWorkInboxItemRequestSchema,
  CreateWorkMandateRequestSchema,
  CreateWorkRequestSchema,
  CreateWorkSubscriptionRequestSchema,
  EndWorkSubscriptionRequestSchema,
  WorkAdmissionCheckRequestSchema,
  WorkEntryAdmissionListQuerySchema,
  WorkInboxItemActionRequestSchema,
  WorkInboxItemReturnRequestSchema,
  WorkInboxListQuerySchema,
  WorkMandateStatusChangeRequestSchema,
  type WorkMandateView,
} from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import { ERROR_HTTP_STATUS, errorCodeOf } from '../run/routes.js'
import {
  changeWorkMandateStatus,
  createWork,
  createWorkMandate,
  listWorkMandateViews,
  mapWorkConstraint,
  retireWork,
} from './commands.js'
import { checkWorkAdmission, refreshAdmissionResult } from './admission.js'
import {
  createWorkSubscription,
  listWorkEntryAdmissionsForActor,
  listWorkSubscriptionsForActor,
  refreshWorkSubscriptionForActor,
  revokeWorkSubscription,
} from './subscriptions.js'
import {
  associateWorkInboxItem,
  expireWorkInboxItem,
  loadWorkInboxForActor,
  refreshWorkInboxItemForActor,
  retractWorkInboxItem,
  returnWorkInboxItem,
} from './inbox.js'
import { loadWorkDetail, toWorkView } from './queries.js'
import { buildRunWorkInputBundle } from './run-dispatch.js'

export interface WorkRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  /**
   * ADR-0028 §9（RD-03a）：新 Mandate/暂停/恢复/撤销提交后，在**独立事务**取消
   * 已派发但仍 queued 的机器 Run。回调由组合根注入，work 模块不直接 import
   * Run 编排器（保持既有静态边界）。
   */
  readonly onMandateChanged?: (
    actor: SessionActor,
    workKey: string,
  ) => Promise<{ cancelled: number; failed: number }>
}

function parseUuid(value: string, label: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', `invalid ${label}`)
  return parsed.data
}

function parseBody<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false; error: { message: string } }
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', parsed.error.message)
  return parsed.data
}

async function mapWorkErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    const mapped = mapWorkConstraint(error)
    if (mapped !== undefined) throw mapped
    throw error
  }
}

async function requireAssignee(
  database: Database,
  task: TaskRow,
  actor: SessionActor,
): Promise<void> {
  if (task.assigneeUserId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the task assignee can manage this work')
  }
  const team = await getTeam(database.db)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  const member = await getEnabledMember(database.db, team.id, actor.userId)
  if (member === undefined) throw new ApiError(403, 'FORBIDDEN', 'actor is not an active member')
}

async function loadAuthorizedWork(
  deps: WorkRouteDeps,
  actor: SessionActor,
  workKey: string,
): Promise<{ readonly work: WorkRow; readonly task: TaskRow }> {
  const work = await getWorkByKey(deps.database.db, workKey)
  if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  const task = await getTask(deps.database.db, work.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  await requireAssignee(deps.database, task, actor)
  return { work, task }
}

export function registerWorkRoutes(app: FastifyInstance, deps: WorkRouteDeps): void {
  // POST /tasks/:taskId/works：只有当前 assignee 能占用该 Task 的工作槽。
  app.post('/tasks/:taskId/works', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { taskId: rawTaskId } = request.params as { taskId: string }
    const taskId = parseUuid(rawTaskId, 'task id')
    const body = parseBody(CreateWorkRequestSchema, request.body)
    const view = await mapWorkErrors(() =>
      createWork(
        { database: deps.database, now: () => new Date() },
        session.userId,
        taskId,
        body,
        readIdempotencyKey(request),
      ),
    )
    audit(request, 'work.create', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: view })
  })

  // GET /tasks/:taskId/works：当前 assignee 读该 Task 的全部工作（含已退休历史）。
  app.get('/tasks/:taskId/works', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId: rawTaskId } = request.params as { taskId: string }
    const taskId = parseUuid(rawTaskId, 'task id')
    const task = await getTask(deps.database.db, taskId)
    if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
    await requireAssignee(deps.database, task, session)
    const rows = await listWorksByTask(deps.database.db, taskId)
    return { ok: true, data: rows.map(toWorkView) }
  })

  // POST /works/:workKey/retire：显式结束工作；已退休重复调用是幂等的。
  app.post('/works/:workKey/retire', async (request) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const view = await mapWorkErrors(() =>
      retireWork(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        readIdempotencyKey(request),
      ),
    )
    audit(request, 'work.retire', 'success', session.userId)
    return { ok: true, data: view }
  })

  // GET /works/:workKey：工作、当前 Mandate、最近影子决定与处理水位。
  app.get('/works/:workKey', async (request) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const { work } = await loadAuthorizedWork(deps, session, workKey)
    const now = new Date()
    const latest = await getLatestWorkMandate(deps.database.db, work.id)
    const view = await loadWorkDetail(deps.database, work, latest, now)
    return { ok: true, data: view }
  })

  // POST /works/:workKey/mandates：追加新版本；旧版本保留为历史。
  app.post('/works/:workKey/mandates', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const body = parseBody(CreateWorkMandateRequestSchema, request.body)
    const outcome = await mapWorkErrors(() =>
      createWorkMandate(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        body,
        readIdempotencyKey(request),
      ),
    )
    const view = outcome.view
    if (deps.onMandateChanged !== undefined && outcome.changed) {
      await deps.onMandateChanged(session, view.workKey)
    }
    audit(request, 'work.mandate.create', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: view })
  })

  // GET /works/:workKey/mandates：版本历史（新到旧）。
  app.get('/works/:workKey/mandates', async (request) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    await loadAuthorizedWork(deps, session, workKey)
    const views: WorkMandateView[] = await listWorkMandateViews(deps.database, workKey, new Date())
    return { ok: true, data: views }
  })

  // POST /mandates/:id/pause|resume|revoke：版本递增，只有当前 assignee 能操作。
  for (const mutation of ['pause', 'resume', 'revoke'] as const) {
    app.post(`/mandates/:mandateId/${mutation}`, async (request) => {
      const session = await deps.requireActor(request)
      const { mandateId: rawMandateId } = request.params as { mandateId: string }
      const mandateId = parseUuid(rawMandateId, 'mandate id')
      const body = parseBody(WorkMandateStatusChangeRequestSchema, request.body ?? {})
      const outcome = await mapWorkErrors(() =>
        changeWorkMandateStatus(
          { database: deps.database, now: () => new Date() },
          session.userId,
          mandateId,
          mutation,
          body.reason,
          readIdempotencyKey(request),
        ),
      )
      const view = outcome.view
      if (deps.onMandateChanged !== undefined && outcome.changed) {
        await deps.onMandateChanged(session, view.workKey)
      }
      audit(request, `work.mandate.${mutation}`, 'success', session.userId)
      return { ok: true, data: view }
    })
  }

  // POST /works/:workKey/subscriptions：显式订阅 Task/业务引用；绑定当前 Mandate 版本。
  app.post('/works/:workKey/subscriptions', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const body = parseBody(CreateWorkSubscriptionRequestSchema, request.body)
    const command = await mapWorkErrors(() =>
      createWorkSubscription(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        body,
        readIdempotencyKey(request),
      ),
    )
    const value = command.executed
      ? command.value
      : await refreshWorkSubscriptionForActor(
          deps.database,
          session.userId,
          workKey,
          command.value.id,
        )
    request.log.info(
      {
        component: 'hub.work_subscription',
        action: 'work.subscription.create',
        workKey,
        subscriptionId: value.id,
        targetType: value.targetType,
        status: value.status,
        duplicate: !command.executed,
      },
      'work subscription created',
    )
    audit(request, 'work.subscription.create', 'success', session.userId)
    reply.header('cache-control', 'private, no-store')
    return reply.code(201).send({ ok: true, data: value })
  })

  // GET /works/:workKey/subscriptions：assignee 读全部订阅（含已结束历史）。
  app.get('/works/:workKey/subscriptions', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const views = await listWorkSubscriptionsForActor(deps.database, session.userId, workKey)
    reply.header('cache-control', 'private, no-store')
    return { ok: true, data: views }
  })

  // POST /works/:workKey/subscriptions/:subscriptionId/revoke：撤权并清理未读副本。
  app.post('/works/:workKey/subscriptions/:subscriptionId/revoke', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey, subscriptionId: rawSubscriptionId } = request.params as {
      workKey: string
      subscriptionId: string
    }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const subscriptionId = parseUuid(rawSubscriptionId, 'subscription id')
    const body = parseBody(EndWorkSubscriptionRequestSchema, request.body ?? {})
    const command = await mapWorkErrors(() =>
      revokeWorkSubscription(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        subscriptionId,
        body.reason,
        readIdempotencyKey(request),
      ),
    )
    const value = command.executed
      ? command.value
      : await refreshWorkSubscriptionForActor(
          deps.database,
          session.userId,
          workKey,
          subscriptionId,
        )
    request.log.info(
      {
        component: 'hub.work_subscription',
        action: 'work.subscription.revoke',
        workKey,
        subscriptionId: value.id,
        status: value.status,
        duplicate: !command.executed,
      },
      'work subscription revoked',
    )
    audit(request, 'work.subscription.revoke', 'success', session.userId)
    reply.header('cache-control', 'private, no-store')
    return { ok: true, data: value }
  })

  // GET /works/:workKey/entry-admissions：快/慢路径证据（含 routerInvoked，不含正文）。
  app.get('/works/:workKey/entry-admissions', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const query = parseBody(WorkEntryAdmissionListQuerySchema, request.query)
    const views = await listWorkEntryAdmissionsForActor(
      deps.database,
      session.userId,
      workKey,
      query.limit,
    )
    reply.header('cache-control', 'private, no-store')
    return { ok: true, data: views }
  })

  // POST /works/:workKey/inbox-items：显式关联来源；同一版本幂等，新版本替换 pending。
  app.post('/works/:workKey/inbox-items', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const body = parseBody(AssociateWorkInboxItemRequestSchema, request.body)
    const result = await mapWorkErrors(() =>
      associateWorkInboxItem(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        body.sourceType,
        body.sourceId,
        readIdempotencyKey(request),
      ),
    )
    const value = result.executed
      ? result.value
      : await refreshWorkInboxItemForActor(deps.database, session.userId, workKey, result.value.id)
    request.log.info(
      {
        component: 'hub.work_inbox',
        action: 'work.inbox.associate',
        workKey,
        itemId: value.id,
        status: value.status,
        duplicate: !result.executed,
      },
      'work inbox item associated',
    )
    audit(request, 'work.inbox.associate', 'success', session.userId)
    reply.header('cache-control', 'private, no-store')
    return reply.code(201).send({ ok: true, data: value })
  })

  // GET /works/:workKey/inbox：assignee 读收件箱（可过滤状态）。
  app.get('/works/:workKey/inbox', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const query = parseBody(WorkInboxListQuerySchema, request.query)
    const view = await loadWorkInboxForActor(deps.database, session.userId, workKey, query)
    // 正文快照是私有数据，禁止共享缓存/中间层缓存。
    reply.header('cache-control', 'private, no-store')
    return { ok: true, data: view }
  })

  // POST /works/:workKey/inbox-items/:itemId/return|retract|expire：显式生命周期迁移。
  app.post('/works/:workKey/inbox-items/:itemId/return', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey, itemId: rawItemId } = request.params as {
      workKey: string
      itemId: string
    }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const itemId = parseUuid(rawItemId, 'inbox item id')
    const body = parseBody(WorkInboxItemReturnRequestSchema, request.body)
    const result = await mapWorkErrors(() =>
      returnWorkInboxItem(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        itemId,
        body,
        readIdempotencyKey(request),
      ),
    )
    const value = result.executed
      ? result.value
      : await refreshWorkInboxItemForActor(deps.database, session.userId, workKey, itemId)
    request.log.info(
      {
        component: 'hub.work_inbox',
        action: 'work.inbox.return',
        workKey,
        itemId: value.id,
        status: value.status,
        returnReason: value.returnReason,
        duplicate: !result.executed,
      },
      'work inbox item returned',
    )
    audit(request, 'work.inbox.return', 'success', session.userId)
    reply.header('cache-control', 'private, no-store')
    return { ok: true, data: value }
  })

  for (const mutation of ['retract', 'expire'] as const) {
    app.post(`/works/:workKey/inbox-items/:itemId/${mutation}`, async (request, reply) => {
      const session = await deps.requireActor(request)
      const { workKey: rawWorkKey, itemId: rawItemId } = request.params as {
        workKey: string
        itemId: string
      }
      const workKey = parseUuid(rawWorkKey, 'work key')
      const itemId = parseUuid(rawItemId, 'inbox item id')
      const body = parseBody(WorkInboxItemActionRequestSchema, request.body ?? {})
      const command = mutation === 'retract' ? retractWorkInboxItem : expireWorkInboxItem
      const result = await mapWorkErrors(() =>
        command(
          { database: deps.database, now: () => new Date() },
          session.userId,
          workKey,
          itemId,
          body.reason,
          readIdempotencyKey(request),
        ),
      )
      const value = result.executed
        ? result.value
        : await refreshWorkInboxItemForActor(deps.database, session.userId, workKey, itemId)
      request.log.info(
        {
          component: 'hub.work_inbox',
          action: `work.inbox.${mutation}`,
          workKey,
          itemId: value.id,
          status: value.status,
          duplicate: !result.executed,
        },
        `work inbox item ${mutation}`,
      )
      audit(request, `work.inbox.${mutation}`, 'success', session.userId)
      reply.header('cache-control', 'private, no-store')
      return { ok: true, data: value }
    })
  }

  // POST /works/:workKey/admission-checks：成员显式触发影子准入；不建 Run、不调模型。
  app.post('/works/:workKey/admission-checks', async (request) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const body = parseBody(WorkAdmissionCheckRequestSchema, request.body)
    const command = await mapWorkErrors(() =>
      checkWorkAdmission(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        body,
        readIdempotencyKey(request),
      ),
    )
    const outcome = command.executed
      ? command
      : {
          executed: false,
          value: await refreshAdmissionResult(deps.database, command.value),
        }
    if (outcome.executed) {
      request.log.info(
        {
          component: 'hub.work',
          action: 'work.admission_decided',
          workKey,
          decision: outcome.value.decision.decision,
          reason: outcome.value.decision.reason,
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          mandateVersion: outcome.value.decision.mandateVersion,
          duplicate: outcome.value.duplicate,
        },
        'work admission decided',
      )
    }
    audit(request, 'work.admission.check', 'success', session.userId)
    return { ok: true, data: outcome.value }
  })

  // ADR-0028 §3：Node 受控下载工作输入正文——Device Token + Run 归属；
  // 不在本 Run 清单内/已撤权/已消费的条目整包拒绝（不可枚举折叠为 404）。
  app.get('/node/runs/:runId/work-input/bundle', async (request, reply) => {
    const identity = await authenticateDevice(deps.database, request)
    const { runId: rawRunId } = request.params as { runId: string }
    const runId = parseUuid(rawRunId, 'run id')
    let bundle: Awaited<ReturnType<typeof buildRunWorkInputBundle>>
    try {
      bundle = await buildRunWorkInputBundle(deps.database, runId, identity.deviceId)
    } catch (error) {
      const { code, message } = errorCodeOf(error)
      if (code === 'INTERNAL_ERROR') throw error
      return noStore(reply)
        .code(ERROR_HTTP_STATUS[code] ?? 500)
        .send({ ok: false, error: { code, message, requestId: String(request.id) } })
    }
    if (bundle === undefined) {
      throw new ApiError(404, 'NOT_FOUND', 'run has no work input manifest')
    }
    return noStore(reply).send({ ok: true, data: bundle })
  })
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store')
}
