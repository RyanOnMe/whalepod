import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Database } from '@whalepod/db'
import { getEnabledMember, getProject, getOrdinaryRun, getTeam } from '@whalepod/db'
import { CorrectContextEntryRequestSchema } from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import { correctContextEntry } from './commands.js'
import { loadProjectContext, parseContextCursor } from './queries.js'
import { buildRunProjectContextBundle, buildRunProjectContextView } from './run-snapshot.js'
import { ERROR_HTTP_STATUS, errorCodeOf } from '../run/routes.js'

export interface ContextRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

const ContextQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(1000).optional(),
})

function parseUuid(value: string, label: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', `invalid ${label}`)
  return parsed.data
}

export function registerContextRoutes(app: FastifyInstance, deps: ContextRouteDeps): void {
  // GET /projects/:projectId/context：当前有效集（Observation/Decision/Inference/Correction）。
  app.get('/projects/:projectId/context', async (request) => {
    await deps.requireActor(request)
    const { projectId: rawProjectId } = request.params as { projectId: string }
    const projectId = parseUuid(rawProjectId, 'project id')
    const query = ContextQuerySchema.parse(request.query)
    const cursor = query.cursor !== undefined ? parseContextCursor(query.cursor) : undefined
    if (query.cursor !== undefined && cursor === undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'invalid context cursor')
    }
    const project = await getProject(deps.database.db, projectId)
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    const page = await loadProjectContext(
      deps.database.db,
      projectId,
      cursor !== undefined ? { limit: query.limit, beforeId: cursor.id } : { limit: query.limit },
    )
    if (page.omittedEntryIds.length > 0) {
      // fail-closed 的代价必须可观测：缺引用的条目不进读面，但要让归因看得到。
      request.log.warn(
        {
          component: 'hub.context',
          action: 'context.entry_withheld',
          projectId,
          entryIds: page.omittedEntryIds,
        },
        'context entries without usable citations withheld from read face',
      )
    }
    return { ok: true, data: page.view }
  })

  // POST /projects/:projectId/context/:entryId/correction：成员追加纠正。
  app.post('/projects/:projectId/context/:entryId/correction', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const { projectId: rawProjectId, entryId: rawEntryId } = request.params as {
      projectId: string
      entryId: string
    }
    const projectId = parseUuid(rawProjectId, 'project id')
    const entryId = parseUuid(rawEntryId, 'context entry id')
    const body = CorrectContextEntryRequestSchema.parse(request.body)
    const result = await correctContextEntry(
      deps.database,
      { userId: actor.userId, role: actor.role },
      projectId,
      entryId,
      body,
      readIdempotencyKey(request),
    )
    audit(request, 'context.correct', 'success', actor.userId)
    if (result.created) {
      // 与 #457 同口径：只有真的追加了 Correction 才写观测；同 key 重放/重复纠正
      // 不是状态迁移，不能发一条服务端日志。字段取存储值，不取本次请求参数。
      request.log.info(
        {
          component: 'hub.context',
          action: 'context.entry_corrected',
          projectId,
          entryId: result.view.id,
          targetEntryId: result.view.targetEntryId,
          actorKind: result.view.actorKind,
          correctionKind: result.view.payload.correctionKind,
        },
        'context entry corrected',
      )
    }
    return reply.code(201).send({ ok: true, data: result.view })
  })

  // ADR-0027 §3：成员读面——只返回快照内条目；正文仅在 frozen 时返回。
  app.get('/runs/:runId/project-context', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const { runId: rawRunId } = request.params as { runId: string }
    const runId = parseUuid(rawRunId, 'run id')
    const run = await getOrdinaryRun(deps.database.db, runId)
    if (run === undefined) throw new ApiError(404, 'NOT_FOUND', 'run not found')
    const team = await getTeam(deps.database.db)
    if (
      team === undefined ||
      (await getEnabledMember(deps.database.db, team.id, actor.userId)) === undefined
    ) {
      throw new ApiError(403, 'FORBIDDEN', 'only team members can read run project context')
    }
    const view = await buildRunProjectContextView(deps.database, runId)
    if (view === undefined) {
      throw new ApiError(404, 'NOT_FOUND', 'run has no project context snapshot')
    }
    return noStore(reply).send({ ok: true, data: view })
  })

  // ADR-0027 §3：Node 受控下载——只对承载该 Run 的设备开放（不可枚举折叠为 404）。
  app.get('/node/runs/:runId/project-context/bundle', async (request, reply) => {
    const identity = await authenticateDevice(deps.database, request)
    const { runId: rawRunId } = request.params as { runId: string }
    const runId = parseUuid(rawRunId, 'run id')
    const run = await getOrdinaryRun(deps.database.db, runId)
    if (run === undefined || run.deviceId !== identity.deviceId) {
      throw new ApiError(404, 'NOT_FOUND', 'run not found')
    }
    let bundle: Awaited<ReturnType<typeof buildRunProjectContextBundle>>
    try {
      bundle = await buildRunProjectContextBundle(deps.database, runId)
    } catch (error) {
      // 非 frozen 条目（PC-05b 撤权/墓碑）在这里抛 RunCommandError；不映射会变成
      // 500 INTERNAL_ERROR，Node 只能把它当服务端故障。
      const { code, message } = errorCodeOf(error)
      if (code === 'INTERNAL_ERROR') throw error
      return reply
        .code(ERROR_HTTP_STATUS[code] ?? 500)
        .send({ ok: false, error: { code, message, requestId: String(request.id) } })
    }
    if (bundle === undefined) {
      throw new ApiError(404, 'NOT_FOUND', 'run has no project context snapshot')
    }
    return noStore(reply).send({ ok: true, data: bundle })
  })
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store')
}
