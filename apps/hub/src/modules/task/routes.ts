import type { FastifyInstance } from 'fastify'
import { getProject, type Database, type Outbox } from '@whalepod/db'
import { asUserId } from '@whalepod/domain'
import {
  CreateCommentRequestSchema,
  CreateTaskRequestSchema,
  ReassignTaskRequestSchema,
  UpdateTaskRequestSchema,
  SendInstructionRequestSchema,
} from '@whalepod/protocol'
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
import { sendInstruction } from '../run/instruction.js'
import type { RunOrchestrator } from '../run/orchestrator.js'
import { ERROR_HTTP_STATUS, errorCodeOf } from '../run/routes.js'
import { listTaskViewsByProject } from './queries.js'
import { getTaskRoom } from './view.js'

export interface TaskRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  readonly outbox: Outbox
  /** 执行区指令要建 Run（#196）：复用既有的建 Run 路径，不另造一套。 */
  readonly orchestrator: RunOrchestrator
  readonly dshDistributionVersionFor: (deviceId: string) => Promise<string | undefined>
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

  // GET /projects/:projectId/tasks：项目任务列表（#137）。
  // 动线缺口：Task 建好后一旦离开 Task Room，真人没有任何入口能再找回它（URL 里的
  // UUID 没人记得住）。列表形态与 GET /projects、/agents、/devices 一致：data 即数组；
  // 排序由仓储保证（updatedAt DESC + id tiebreak），UI 不重排。
  app.get('/projects/:projectId/tasks', async (request) => {
    await deps.requireActor(request)
    const { projectId } = request.params as { projectId: string }
    const project = await getProject(deps.database.db, projectId)
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    return { ok: true, data: await listTaskViewsByProject(deps.database.db, projectId) }
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

  /**
   * POST /tasks/:taskId/instructions（#196）：**执行区**发一条指令驱动 Agent。
   *
   * 与 `/comments` 的分工是 ADR-0010 的核心：评论区只承载人际交流，指令走执行区。
   * 有活跃 Run → 降级为追问（③c-1 的排队/下发语义）；没有 → 建 Run（设备/工作区三段式解析）。
   * 解析不到目标时**明确拒绝**（409 `DEVICE_OFFLINE`，不猜、不落指令）。
   */
  app.post('/tasks/:taskId/instructions', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const parsed = SendInstructionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      // `.parse()` 抛的 ZodError 会被全局处理吞成 500（#187 评审 B1 的教训），这里显式回 400。
      return reply
        .code(400)
        .send({ ok: false, error: { code: 'VALIDATION_FAILED', message: parsed.error.message } })
    }
    let outcome: Awaited<ReturnType<typeof sendInstruction>>
    try {
      outcome = await sendInstruction(
        {
          database: deps.database,
          outbox: deps.outbox,
          orchestrator: deps.orchestrator,
          dshDistributionVersionFor: deps.dshDistributionVersionFor,
        },
        actorFrom(session),
        taskId,
        {
          text: parsed.data.text,
          idempotencyKey: readIdempotencyKey(request),
          ...(parsed.data.deviceId !== undefined ? { deviceId: parsed.data.deviceId } : {}),
          ...(parsed.data.workspaceId !== undefined
            ? { workspaceId: parsed.data.workspaceId }
            : {}),
          ...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
        },
      )
    } catch (error) {
      // 运行面的错误映射在本模块不生效（它是 run 插件的 `setErrorHandler`）：不显式映射，
      // `DEVICE_OFFLINE` 这类语义化拒绝会变成 500。复用 run 模块导出的同一份映射表（单一真相）。
      const { code, message } = errorCodeOf(error)
      if (code === 'INTERNAL_ERROR') throw error
      return reply
        .code(ERROR_HTTP_STATUS[code] ?? 500)
        .send({ ok: false, error: { code, message, requestId: String(request.id) } })
    }
    audit(request, 'instruction.send', 'success', session.userId)
    // 201：受理与否是**消息的命运**（可能已 rejected），不是请求的失败——与追问路由同一口径。
    return reply.code(201).send({
      ok: true,
      data: { ...outcome.message, outcome: outcome.kind, runId: outcome.runId },
    })
  })
}
