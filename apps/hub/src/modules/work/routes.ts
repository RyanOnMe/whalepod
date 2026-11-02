import type { FastifyInstance } from 'fastify'
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
  CreateWorkMandateRequestSchema,
  CreateWorkRequestSchema,
  WorkAdmissionCheckRequestSchema,
  WorkMandateStatusChangeRequestSchema,
  type WorkMandateView,
} from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import {
  changeWorkMandateStatus,
  createWork,
  createWorkMandate,
  listWorkMandateViews,
  mapWorkConstraint,
  retireWork,
} from './commands.js'
import { checkWorkAdmission } from './admission.js'
import { loadWorkDetail, toWorkView } from './queries.js'

export interface WorkRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
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
    const view = await mapWorkErrors(() =>
      createWorkMandate(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        body,
        readIdempotencyKey(request),
      ),
    )
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
      const view = await mapWorkErrors(() =>
        changeWorkMandateStatus(
          { database: deps.database, now: () => new Date() },
          session.userId,
          mandateId,
          mutation,
          body.reason,
          readIdempotencyKey(request),
        ),
      )
      audit(request, `work.mandate.${mutation}`, 'success', session.userId)
      return { ok: true, data: view }
    })
  }

  // POST /works/:workKey/admission-checks：成员显式触发影子准入；不建 Run、不调模型。
  app.post('/works/:workKey/admission-checks', async (request) => {
    const session = await deps.requireActor(request)
    const { workKey: rawWorkKey } = request.params as { workKey: string }
    const workKey = parseUuid(rawWorkKey, 'work key')
    const body = parseBody(WorkAdmissionCheckRequestSchema, request.body)
    const outcome = await mapWorkErrors(() =>
      checkWorkAdmission(
        { database: deps.database, now: () => new Date() },
        session.userId,
        workKey,
        body,
        readIdempotencyKey(request),
      ),
    )
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
}
