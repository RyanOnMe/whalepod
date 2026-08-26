import type { FastifyInstance } from 'fastify'
import type { Database } from '@project311/db'
import { asUserId } from '@project311/domain'
import { CreateAgentRequestSchema, CreateAgentRevisionRequestSchema } from '@project311/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { createAgent, createProfileRevision } from './commands.js'
import { getAgentDetailView, listAgentViews } from './queries.js'

export interface AgentRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

function actorFrom(session: { userId: string; role: 'owner' | 'admin' | 'member' }) {
  return { userId: asUserId(session.userId), role: session.role }
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  // GET /agents：Member 可见全部 Agent（03 §4）。
  app.get('/agents', async (request) => {
    await deps.requireActor(request)
    return { ok: true, data: await listAgentViews(deps.database.db) }
  })

  // POST /agents：Owner/Admin 创建 Agent（含首个 Revision）。
  app.post('/agents', async (request, reply) => {
    const session = await deps.requireActor(request)
    const body = CreateAgentRequestSchema.parse(request.body)
    try {
      const agent = await createAgent(deps.database, actorFrom(session), {
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        persona: body.persona,
        provider: body.provider,
        model: body.model,
        credentialSlot: body.credentialSlot,
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        pluginPackId: body.pluginPackId,
        createdBy: session.userId,
        idempotencyKey: readIdempotencyKey(request),
      })
      audit(request, 'agent.create', 'success', session.userId)
      return reply.code(201).send({ ok: true, data: agent })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FORBIDDEN') {
        audit(request, 'agent.create', 'denied', session.userId)
      }
      throw error
    }
  })

  // GET /agents/:agentId：Agent 详情（含当前 Revision 与全部历史）。
  app.get('/agents/:agentId', async (request) => {
    await deps.requireActor(request)
    const { agentId } = request.params as { agentId: string }
    const agent = await getAgentDetailView(deps.database.db, agentId)
    if (agent === undefined) throw new ApiError(404, 'NOT_FOUND', 'agent not found')
    return { ok: true, data: agent }
  })

  // POST /agents/:agentId/revisions：Owner/Admin 新建不可变 Revision。
  app.post('/agents/:agentId/revisions', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { agentId } = request.params as { agentId: string }
    const body = CreateAgentRevisionRequestSchema.parse(request.body)
    try {
      const revision = await createProfileRevision(deps.database, actorFrom(session), {
        agentId,
        persona: body.persona,
        provider: body.provider,
        model: body.model,
        credentialSlot: body.credentialSlot,
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        pluginPackId: body.pluginPackId,
        createdBy: session.userId,
        idempotencyKey: readIdempotencyKey(request),
      })
      audit(request, 'agent.revision', 'success', session.userId)
      return reply.code(201).send({ ok: true, data: revision })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FORBIDDEN') {
        audit(request, 'agent.revision', 'denied', session.userId)
      }
      throw error
    }
  })
}
