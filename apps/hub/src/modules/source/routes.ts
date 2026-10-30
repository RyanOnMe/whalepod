import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '@whalepod/db'
import { getProject, getProjectSource } from '@whalepod/db'
import {
  CreateProjectSourceRequestSchema,
  RevokeProjectSourceRequestSchema,
} from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import {
  bindProjectSource,
  pauseProjectSource,
  resumeProjectSource,
  revokeProjectSource,
} from './commands.js'
import { nodeSourceCollector, type SourceCollector } from './collector.js'
import { listSourceViews, toSourceView } from './queries.js'

export interface SourceRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  /** 集成测试可注入；生产默认进程级 Node 连接注册表。 */
  readonly collector?: SourceCollector
}

function toActor(actor: { userId: string; role: 'owner' | 'admin' | 'member' }) {
  return { userId: actor.userId, role: actor.role }
}

/** 畸形 id 不落 PostgreSQL：直接 400，避免驱动层 500。 */
function parseIdParam(value: string, label: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', `invalid ${label}`)
  return parsed.data
}

/** 观测面只含不透明 id/状态/代次；不含资源身份、凭据、平台名称或正文。 */
function logContext(
  request: Parameters<typeof audit>[0],
  action: string,
  view: {
    id: string
    projectId: string
    platform: string
    kind: string
    status: string
    permissionState: string
    authorizationGeneration: number
  },
): void {
  request.log.info(
    {
      component: 'hub.context',
      action,
      sourceId: view.id,
      projectId: view.projectId,
      platform: view.platform,
      kind: view.kind,
      status: view.status,
      permissionState: view.permissionState,
      authorizationGeneration: view.authorizationGeneration,
    },
    'source context changed',
  )
}

export function registerSourceRoutes(app: FastifyInstance, deps: SourceRouteDeps): void {
  const collector = deps.collector ?? nodeSourceCollector

  // GET /projects/:projectId/sources：Team 可见的来源清单（ADR-0024 §10）。
  app.get('/projects/:projectId/sources', async (request) => {
    await deps.requireActor(request)
    const { projectId: rawProjectId } = request.params as { projectId: string }
    const projectId = parseIdParam(rawProjectId, 'project id')
    const project = await getProject(deps.database.db, projectId)
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    return { ok: true, data: await listSourceViews(deps.database.db, projectId) }
  })

  // POST /projects/:projectId/sources：成员绑定，必须显式确认团队共享。
  app.post('/projects/:projectId/sources', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const { projectId: rawProjectId } = request.params as { projectId: string }
    const projectId = parseIdParam(rawProjectId, 'project id')
    const body = CreateProjectSourceRequestSchema.parse(request.body)
    const view = await bindProjectSource(deps.database, collector, {
      projectId,
      actor: toActor(actor),
      request: body,
      idempotencyKey: readIdempotencyKey(request),
    })
    audit(request, 'source.bind', 'success', actor.userId)
    logContext(request, 'source.bound', view)
    return reply.code(201).send({ ok: true, data: view })
  })

  // GET /sources/:sourceId：来源详情（权限水位、代次、最近成功读取）。
  app.get('/sources/:sourceId', async (request) => {
    await deps.requireActor(request)
    const { sourceId: rawSourceId } = request.params as { sourceId: string }
    const sourceId = parseIdParam(rawSourceId, 'source id')
    const row = await getProjectSource(deps.database.db, sourceId)
    if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
    return { ok: true, data: toSourceView(row) }
  })

  app.post('/sources/:sourceId/pause', async (request) => {
    const actor = await deps.requireActor(request)
    const { sourceId: rawSourceId } = request.params as { sourceId: string }
    const sourceId = parseIdParam(rawSourceId, 'source id')
    const view = await pauseProjectSource(deps.database, {
      sourceId,
      actor: toActor(actor),
      idempotencyKey: readIdempotencyKey(request),
    })
    audit(request, 'source.pause', 'success', actor.userId)
    logContext(request, 'source.paused', view)
    return { ok: true, data: view }
  })

  app.post('/sources/:sourceId/resume', async (request) => {
    const actor = await deps.requireActor(request)
    const { sourceId: rawSourceId } = request.params as { sourceId: string }
    const sourceId = parseIdParam(rawSourceId, 'source id')
    const view = await resumeProjectSource(deps.database, collector, {
      sourceId,
      actor: toActor(actor),
      idempotencyKey: readIdempotencyKey(request),
    })
    audit(request, 'source.resume', 'success', actor.userId)
    logContext(request, 'source.resumed', view)
    return { ok: true, data: view }
  })

  app.post('/sources/:sourceId/revoke', async (request) => {
    const actor = await deps.requireActor(request)
    const { sourceId: rawSourceId } = request.params as { sourceId: string }
    const sourceId = parseIdParam(rawSourceId, 'source id')
    const body = RevokeProjectSourceRequestSchema.parse(request.body)
    const view = await revokeProjectSource(deps.database, {
      sourceId,
      actor: toActor(actor),
      idempotencyKey: readIdempotencyKey(request),
      reason: body.reason,
    })
    audit(request, 'source.revoke', 'success', actor.userId)
    logContext(request, 'source.revoked', view)
    return { ok: true, data: view }
  })
}
