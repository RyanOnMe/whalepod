/**
 * ADR-0028 §6（RD-03a）：工作派工意图的人工确认与受控派发 HTTP 面。
 *
 * 只允许 Task 当前 assignee 操作；approve 记录 human 批准，dispatch 由端口复核
 * 后创建机器 Run。路径挂在 /works/:workKey 下，但实现单独成模块——work 模块
 * 的静态边界禁止 import RunOrchestrator/Outbox。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  DispatchIntentApproveRequestSchema,
  DispatchIntentDispatchRequestSchema,
  DispatchIntentRejectRequestSchema,
} from '@whalepod/protocol'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import type { DispatchDeps } from './service.js'
import {
  approveDispatchIntent,
  dispatchIntent,
  mapDispatchErrors,
  rejectDispatchIntent,
} from './service.js'

export interface DispatchRouteDeps extends DispatchDeps {
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

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'private, no-store')
}

function params(request: { params: unknown }): {
  workKey: string
  intentId: string
} {
  const raw = request.params as { workKey?: string; intentId?: string }
  return {
    workKey: parseUuid(raw.workKey ?? '', 'work key'),
    intentId: parseUuid(raw.intentId ?? '', 'dispatch intent id'),
  }
}

export function registerDispatchRoutes(app: FastifyInstance, deps: DispatchRouteDeps): void {
  app.post('/works/:workKey/dispatch-intents/:intentId/approve', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey, intentId } = params(request)
    parseBody(DispatchIntentApproveRequestSchema, request.body ?? {})
    const intent = await mapDispatchErrors(() =>
      approveDispatchIntent(deps, session, workKey, intentId, readIdempotencyKey(request)),
    )
    audit(request, 'work.dispatch.approve', 'success', session.userId)
    request.log.info(
      {
        component: 'hub.dispatch',
        action: 'work.dispatch.approve',
        workKey,
        intentId,
        status: intent.status,
        approvalBasis: intent.approvalBasis,
        onBehalfOfUserId: intent.onBehalfOfUserId,
      },
      'dispatch intent approved',
    )
    return noStore(reply).send({ ok: true, data: intent })
  })

  app.post('/works/:workKey/dispatch-intents/:intentId/reject', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey, intentId } = params(request)
    const body = parseBody(DispatchIntentRejectRequestSchema, request.body ?? {})
    const reason = body.reason ?? 'rejected by assignee'
    const intent = await mapDispatchErrors(() =>
      rejectDispatchIntent(deps, session, workKey, intentId, reason, readIdempotencyKey(request)),
    )
    audit(request, 'work.dispatch.reject', 'success', session.userId)
    request.log.info(
      {
        component: 'hub.dispatch',
        action: 'work.dispatch.reject',
        workKey,
        intentId,
        status: intent.status,
      },
      'dispatch intent rejected',
    )
    return noStore(reply).send({ ok: true, data: intent })
  })

  app.post('/works/:workKey/dispatch-intents/:intentId/dispatch', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { workKey, intentId } = params(request)
    const body = parseBody(DispatchIntentDispatchRequestSchema, request.body)
    const outcome = await mapDispatchErrors(() =>
      dispatchIntent(deps, session, workKey, intentId, body, readIdempotencyKey(request)),
    )
    if (!outcome.ok) {
      throw new ApiError(outcome.status, outcome.code, outcome.message)
    }
    const intent = outcome.intent
    audit(request, 'work.dispatch.dispatch', 'success', session.userId)
    request.log.info(
      {
        component: 'hub.dispatch',
        action: 'work.dispatch.dispatch',
        workKey,
        intentId,
        runId: intent.runId,
        agentId: intent.agentId,
        deviceId: intent.deviceId,
        actionClass: intent.actionClass,
        status: intent.status,
        approvalBasis: intent.approvalBasis,
        onBehalfOfUserId: intent.onBehalfOfUserId,
      },
      'dispatch intent dispatched',
    )
    return noStore(reply).send({ ok: true, data: intent })
  })
}

// 保持 SessionActor 类型参与接口面，防止 requireActor 契约漂移成任意对象。
export type DispatchActor = SessionActor
