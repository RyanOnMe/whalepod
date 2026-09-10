import type { FastifyInstance } from 'fastify'
import type { Database } from '@whalepod/db'
import { CreateProjectRequestSchema } from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { createProject } from './commands.js'
import { getProjectView, listProjectViews } from './queries.js'

export interface ProjectRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  // GET /projects：Member 可见全部 Project（单 Team；03 §2.2/§4）。
  app.get('/projects', async (request) => {
    await deps.requireActor(request)
    return { ok: true, data: await listProjectViews(deps.database.db) }
  })

  // POST /projects：Member 创建 Project。
  app.post('/projects', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const body = CreateProjectRequestSchema.parse(request.body)
    const project = await createProject(deps.database, {
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      createdBy: actor.userId,
      idempotencyKey: readIdempotencyKey(request),
    })
    audit(request, 'project.create', 'success', actor.userId)
    return reply.code(201).send({ ok: true, data: project })
  })

  // GET /projects/:projectId：Project 概览（03 §4）。
  app.get('/projects/:projectId', async (request) => {
    await deps.requireActor(request)
    const { projectId } = request.params as { projectId: string }
    const project = await getProjectView(deps.database.db, projectId)
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    return { ok: true, data: project }
  })
}
