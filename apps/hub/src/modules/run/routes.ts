/**
 * Run HTTP 路由（02-第一阶段实施计划.md Task 10 Interfaces）：
 *   POST /tasks/:taskId/runs
 *   GET  /runs/:runId
 *
 * 路径不含 `/api/v1` 前缀——由组合根（app.ts，P1-05）按 #38 先例以
 * `{ prefix: '/api/v1' }` 挂载；接线时与其他模块一致。本模块只管路由与
 * 错误映射；组合根负责装配：
 * - resolveActor：Session Cookie → Actor（P1-05 auth 模块提供）；
 * - dshDistributionVersionFor：Device 连接投影（P1-09）给出目标设备的 DSH
 *   发行版版本；查不到说明设备不在线，按 DEVICE_OFFLINE 拒绝。
 * Origin 校验与 Cookie 解析是中间件职责（03 §4），不在本文件。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DomainError } from '@project311/domain'
import type { Database } from '@project311/db'
import type { ErrorCode } from '@project311/protocol'
import { CreateRunRequestSchema } from '@project311/protocol'
import type { ActorContext } from './commands.js'
import { RunCommandError } from './errors.js'
import type { RunOrchestrator } from './orchestrator.js'
import { getRunView } from './queries.js'
import { getRun, listRunEvents } from '@project311/db'

export interface RunRoutesDeps {
  orchestrator: RunOrchestrator
  database: Database
  resolveActor: (request: FastifyRequest) => Promise<ActorContext>
  dshDistributionVersionFor: (deviceId: string) => Promise<string | undefined>
}

const ERROR_HTTP_STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RUN_ALREADY_ACTIVE: 409,
  TASK_TERMINAL: 409,
  ASSIGNMENT_NOT_ACCEPTED: 409,
  INVALID_RUN_TRANSITION: 409,
  DEVICE_OFFLINE: 409,
  DEVICE_REVOKED: 409,
  WORKSPACE_UNAVAILABLE: 409,
}

function sendError(reply: FastifyReply, code: ErrorCode, message: string): FastifyReply {
  // requestId 与 #38 的统一 envelope 一致：取 Fastify 的 request.id（非随机 uuid）。
  return reply.status(ERROR_HTTP_STATUS[code] ?? 500).send({
    ok: false,
    error: { code, message, requestId: String(reply.request.id) },
  })
}

function errorCodeOf(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof DomainError || error instanceof RunCommandError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'INTERNAL_ERROR', message: 'internal error' }
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRoutesDeps): void {
  app.post('/tasks/:taskId/runs', async (request, reply) => {
    try {
      const actor = await deps.resolveActor(request)
      const taskId = (request.params as { taskId?: string }).taskId ?? ''
      const keyHeader = request.headers['idempotency-key']
      const idempotencyKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader
      if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
        return sendError(reply, 'VALIDATION_FAILED', 'Idempotency-Key header is required')
      }
      const body = CreateRunRequestSchema.safeParse(request.body)
      if (!body.success) {
        return sendError(
          reply,
          'VALIDATION_FAILED',
          body.error.issues[0]?.message ?? 'invalid request body',
        )
      }
      const dshDistributionVersion = await deps.dshDistributionVersionFor(body.data.deviceId)
      if (dshDistributionVersion === undefined) {
        return sendError(reply, 'DEVICE_OFFLINE', 'device is not connected')
      }
      const run = await deps.orchestrator.create(actor, taskId, {
        agentId: body.data.agentId,
        ...(body.data.profileRevisionId !== undefined
          ? { profileRevisionId: body.data.profileRevisionId }
          : {}),
        deviceId: body.data.deviceId,
        workspaceId: body.data.workspaceId,
        prompt: body.data.prompt,
        idempotencyKey,
        dshDistributionVersion,
      })
      return reply.status(201).send({ ok: true, data: run })
    } catch (error) {
      const { code, message } = errorCodeOf(error)
      return sendError(reply, code, message)
    }
  })

  app.get('/runs/:runId', async (request, reply) => {
    try {
      await deps.resolveActor(request)
      const runId = (request.params as { runId?: string }).runId ?? ''
      const run = await getRunView(deps.database.db, runId)
      if (run === undefined) return sendError(reply, 'NOT_FOUND', 'run not found')
      return reply.status(200).send({ ok: true, data: run })
    } catch (error) {
      const { code, message } = errorCodeOf(error)
      return sendError(reply, code, message)
    }
  })

  /**
   * GET /runs/:runId/events?after=<seq>&limit=<n>（P1-13；03 §5/§8）。
   * 受众过滤与 Browser WS 扇出同一判据：project 全员可见；owner 行仅 Run
   * owner；admin 行仅 owner/admin 角色。payload 出 Node 时已脱敏（§9），
   * Hub 只做受众裁剪、不做内容改写。
   */
  app.get('/runs/:runId/events', async (request, reply) => {
    try {
      const actor = await deps.resolveActor(request)
      const runId = (request.params as { runId?: string }).runId ?? ''
      const run = await getRun(deps.database.db, runId)
      if (run === undefined) return sendError(reply, 'NOT_FOUND', 'run not found')
      const query = request.query as { after?: unknown; limit?: unknown }
      const afterSeq = typeof query.after === 'string' ? Number(query.after) : undefined
      if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
        return sendError(reply, 'VALIDATION_FAILED', 'invalid after cursor')
      }
      const limitRaw = typeof query.limit === 'string' ? Number(query.limit) : undefined
      if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
        return sendError(reply, 'VALIDATION_FAILED', 'invalid limit')
      }
      const audiences: Array<'owner' | 'project' | 'admin'> = ['project']
      if (actor.userId === run.ownerUserId) audiences.push('owner')
      if (actor.role === 'owner' || actor.role === 'admin') audiences.push('admin')
      const rows = await listRunEvents(deps.database.db, runId, {
        audiences,
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        limit: Math.min(limitRaw ?? 200, 500),
      })
      return reply.status(200).send({
        ok: true,
        data: {
          events: rows.map((row) => ({
            runId: row.runId,
            seq: row.seq,
            type: row.type,
            audience: row.audience,
            event: row.payload,
            occurredAt: row.occurredAt.toISOString(),
            receivedAt: row.receivedAt.toISOString(),
          })),
        },
      })
    } catch (error) {
      const { code, message } = errorCodeOf(error)
      return sendError(reply, code, message)
    }
  })
}
