import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  claimDiscoveryExecutorAttempt,
  getDiscoveryExecutorAttempt,
  getOrdinaryRun,
  settleDiscoveryExecutorAttempt,
  type Database,
} from '@whalepod/db'
import {
  DiscoveryExecutorAttemptBeginSchema,
  DiscoveryExecutorAttemptSettleSchema,
} from '@whalepod/protocol'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import { ApiError } from '../shared/http-error.js'
import { executorDigest } from './execution.js'
import { verifyDiscoveryReplayRun, type DiscoveryLivePolicy } from './replay-binding.js'

const path = '/node/runs/:runId/discovery-model'
const params = z.object({ runId: z.uuid() })

function unavailable(): never {
  throw new ApiError(404, 'NOT_FOUND', 'discovery model attempt unavailable')
}

export function registerDiscoveryExecutorAttemptRoutes(
  app: FastifyInstance,
  deps: {
    database: Database
    route: DiscoveryLivePolicy | undefined
    deviceOnline: (deviceId: string) => boolean
  },
) {
  app.post(`${path}/begin`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const { deviceId } = await authenticateDevice(deps.database, request)
    const { runId } = params.parse(request.params)
    const input = DiscoveryExecutorAttemptBeginSchema.parse(request.body)
    const route = deps.route
    if (
      !route ||
      !deps.deviceOnline(deviceId) ||
      executorDigest(input.executor) !== executorDigest(route.route)
    )
      unavailable()
    const claim = await deps.database.transaction(async (tx) => {
      const run = await getOrdinaryRun(tx, runId)
      if (
        !run ||
        run.deviceId !== deviceId ||
        !['dispatching', 'running'].includes(run.status) ||
        !(
          await verifyDiscoveryReplayRun(tx, run, new Date(), {
            route,
            lock: true,
            lockRunBeforeWork: true,
          })
        ).ok
      )
        unavailable()
      // Reserve for the whole supported model context. Byte length alone is
      // not a guarantee about input tokens or provider prompt overhead.
      const claim = await claimDiscoveryExecutorAttempt(tx, {
        runId,
        attemptId: input.attemptId,
        requestDigest: input.requestDigest,
        requestBytes: input.requestBytes,
        inputUpperBound: route.maxInputTokens,
        outputUpperBound: input.maxOutputTokens,
        now: new Date(),
      })
      if (
        claim.ok &&
        (claim.attempt.utcDate !== new Date().toISOString().slice(0, 10) ||
          !deps.deviceOnline(deviceId) ||
          !(await verifyDiscoveryReplayRun(tx, run, new Date(), { route })).ok)
      )
        unavailable()
      return claim
    })
    if (!claim.ok) {
      request.log.info(
        {
          component: 'hub.discovery',
          action: 'discovery.executor.begin_denied',
          reason: claim.reason,
          runId,
        },
        'discovery model budget refused',
      )
      throw new ApiError(409, 'CONFLICT', 'discovery model attempt refused', {
        reason: claim.reason,
      })
    }
    return reply.code(204).send()
  })

  app.post(`${path}/settle`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const { deviceId } = await authenticateDevice(deps.database, request)
    const { runId } = params.parse(request.params)
    const input = DiscoveryExecutorAttemptSettleSchema.parse(request.body)
    return deps.database.transaction(async (tx) => {
      const run = await getOrdinaryRun(tx, runId)
      if (!run || run.deviceId !== deviceId || !run.discoveryExecutionId) unavailable()
      const attempt = await getDiscoveryExecutorAttempt(tx, runId, input.attemptId)
      if (!attempt || attempt.requestDigest !== input.requestDigest) unavailable()
      // A revoked or completed run still owes the ledger for an earlier request.
      // Take the authority locks before the ledger locks when the run can continue.
      const authorized =
        deps.route !== undefined &&
        input.outcome.kind === 'actual' &&
        deps.deviceOnline(deviceId) &&
        (
          await verifyDiscoveryReplayRun(tx, run, new Date(), {
            route: deps.route,
            lock: true,
            lockRunBeforeWork: true,
          })
        ).ok
      const result = await settleDiscoveryExecutorAttempt(tx, {
        runId,
        attemptId: input.attemptId,
        outcome:
          input.outcome.kind === 'actual'
            ? {
                kind: 'actual',
                inputTokens: input.outcome.inputTokens,
                outputTokens: input.outcome.outputTokens,
                ...(input.outcome.responseIdDigest
                  ? { responseIdDigest: input.outcome.responseIdDigest }
                  : {}),
              }
            : input.outcome,
        now: new Date(),
      })
      if (result.status === 'missing') unavailable()
      if (result.status === 'conflict')
        throw new ApiError(409, 'CONFLICT', 'discovery model settlement conflict')
      return {
        ok: true,
        data: {
          allowContinue:
            authorized &&
            deps.route !== undefined &&
            result.attempt?.state === 'actual' &&
            !result.attempt.overage &&
            deps.deviceOnline(deviceId) &&
            (await verifyDiscoveryReplayRun(tx, run, new Date(), { route: deps.route })).ok,
        },
      }
    })
  })
}
