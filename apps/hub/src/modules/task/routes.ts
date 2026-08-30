import type { FastifyInstance } from 'fastify'
import type { Database, Outbox } from '@project311/db'
import { asUserId } from '@project311/domain'
import {
  CreateCommentRequestSchema,
  CreateTaskRequestSchema,
  ReassignTaskRequestSchema,
  UpdateTaskRequestSchema,
} from '@project311/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import {
  acceptAssignment,
  addComment,
  cancelTask,
  completeTask,
  createTask,
  reassignAssignment,
  rejectAssignment,
  submitTaskForReview,
  updateTask,
} from './commands.js'
import { getTaskRoom } from './view.js'

export interface TaskRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  readonly outbox: Outbox
}

function actorFrom(session: SessionActor) {
  return { userId: asUserId(session.userId), role: session.role }
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  // POST /projects/:projectId/tasks：Member 创建 Task（Assignment 始终 pending）。
  app.post('/projects/:projectId/tasks', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { projectId } = request.params as { projectId: string }
    const body = CreateTaskRequestSchema.parse(request.body)
    const task = await createTask(deps.database, actorFrom(session), projectId, {
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      assigneeUserId: body.assigneeUserId,
      idempotencyKey: readIdempotencyKey(request),
    })
    audit(request, 'task.create', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: task })
  })

  // GET /tasks/:taskId：Task Room 聚合（不暴露 runtime internals，03 §9/02 Step 1）。
  // viewer 传入会话用户：candidate Artifact 仅 owner 本人可见（P1-15，G6-01）。
  app.get('/tasks/:taskId', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const room = await getTaskRoom(deps.database.db, taskId, session.userId)
    if (room === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
    return { ok: true, data: room }
  })

  // PATCH /tasks/:taskId：只改非状态字段（03 §4）。
  app.patch('/tasks/:taskId', async (request) => {
    await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const body = UpdateTaskRequestSchema.parse(request.body)
    const task = await updateTask(
      deps.database,
      taskId,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
      readIdempotencyKey(request),
    )
    return { ok: true, data: task }
  })

  // POST /tasks/:taskId/accept：assignee 接受 Assignment。
  app.post('/tasks/:taskId/accept', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const task = await acceptAssignment(deps.database, actorFrom(session), taskId)
    audit(request, 'task.accept', 'success', session.userId)
    return { ok: true, data: task }
  })

  // POST /tasks/:taskId/reject：assignee 拒绝 Assignment。
  app.post('/tasks/:taskId/reject', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const task = await rejectAssignment(deps.database, actorFrom(session), taskId)
    audit(request, 'task.reject', 'success', session.userId)
    return { ok: true, data: task }
  })

  // POST /tasks/:taskId/reassign：Owner/Admin 重新指派（assignee 变化后重置 pending）。
  app.post('/tasks/:taskId/reassign', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const body = ReassignTaskRequestSchema.parse(request.body)
    try {
      const task = await reassignAssignment(
        deps.database,
        actorFrom(session),
        taskId,
        body.assigneeUserId,
      )
      audit(request, 'task.reassign', 'success', session.userId)
      return { ok: true, data: task }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FORBIDDEN') {
        audit(request, 'task.reassign', 'denied', session.userId)
      }
      throw error
    }
  })

  // POST /tasks/:taskId/submit-review：accepted assignee 提交验收。
  app.post('/tasks/:taskId/submit-review', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const task = await submitTaskForReview(deps.database, actorFrom(session), taskId)
    audit(request, 'task.submit_review', 'success', session.userId)
    return { ok: true, data: task }
  })

  // POST /tasks/:taskId/complete：accepted assignee 显式完成。
  app.post('/tasks/:taskId/complete', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const task = await completeTask(deps.database, actorFrom(session), taskId)
    audit(request, 'task.complete', 'success', session.userId)
    return { ok: true, data: task }
  })

  // POST /tasks/:taskId/cancel：accepted assignee 取消（带活跃 Run 时同步取消 Run）。
  app.post('/tasks/:taskId/cancel', async (request) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const task = await cancelTask(deps.database, deps.outbox, actorFrom(session), taskId)
    audit(request, 'task.cancel', 'success', session.userId)
    return { ok: true, data: task }
  })

  // POST /tasks/:taskId/comments：Member 添加 Comment。
  app.post('/tasks/:taskId/comments', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const body = CreateCommentRequestSchema.parse(request.body)
    const comment = await addComment(deps.database, actorFrom(session), taskId, {
      body: body.body,
      idempotencyKey: readIdempotencyKey(request),
    })
    audit(request, 'comment.create', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: comment })
  })
}
