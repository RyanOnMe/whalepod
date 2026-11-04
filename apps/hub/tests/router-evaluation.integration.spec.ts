/** #519: HTTP 驱动既有工作的模型评估；运行状态只由生产入口/协议帧产生。 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getEvaluation, schema } from '@whalepod/db'
import {
  parseNodeFrame,
  coordinationUsageCost,
  type CoordinationRequest,
  type CoordinationResult,
  type NodeDownstream,
  type RouterProposal,
} from '@whalepod/protocol'
import { downloadRouterInput, runRouterTick } from '../src/modules/router/service.js'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  driveInviteAndAccept,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

describe('RD-03r1 restricted Router evaluation', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let projectId: string
  let workKey: string
  let sourceId: string
  let taskId: string
  let mandateId: string
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: `router-${randomUUID()}` },
    })
    expect(project.statusCode).toBe(201)
    projectId = project.json().data.id as string
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '预算变化', assigneeUserId: alice.userId },
    })
    expect(task.statusCode).toBe(201)
    taskId = task.json().data.id as string
    expect(
      (await apiInject(ctx, alice, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` }))
        .statusCode,
    ).toBe(200)
    const work = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: '依据已确认预算研究场地' },
    })
    expect(work.statusCode).toBe(201)
    workKey = work.json().data.workKey as string
    const mandate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        allowedActionClasses: ['analysis'],
        allowedSourceTypes: ['task_message'],
        allowedToolNames: ['read'],
        maxTokens: 100000,
        maxCostMicros: 1000000,
      },
    })
    expect(mandate.statusCode).toBe(201)
    mandateId = mandate.json().data.id as string
    const message = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '已确认预算降为八万元，请核对现有方案依据。' },
    })
    expect(message.statusCode).toBe(201)
    sourceId = message.json().data.id as string
  })
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('rejects incomplete explicit model configuration instead of enabling defaults', async () => {
    const response = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: {},
    })
    expect(response.statusCode).toBe(400)
  })

  it('does not evaluate without explicit model, billing and credential configuration', async () => {
    const response = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId },
    })
    expect(response.statusCode).toBe(409)
    const rows =
      await database.sql`select count(*)::int as n from coordination_evaluation where purpose = 'router'`
    expect(rows[0]?.n).toBe(0)
  })

  it('exposes an empty owner-only evaluation history before a model is configured', async () => {
    const response = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/router/evaluations`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json().data).toEqual([])
  })

  function frame(type: string, payload: unknown) {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type,
      payload,
    })
  }
  async function onlineNode() {
    const code = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    expect(code.statusCode).toBe(201)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: code.json().data.code,
        name: `router-${randomUUID()}`,
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    const { deviceId, deviceToken } = claim.json().data as { deviceId: string; deviceToken: string }
    await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const address = ctx.app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing listen address')
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/v1/node`, {
      headers: { authorization: `Device ${deviceToken}` },
    })
    sockets.push(socket)
    const received: NodeDownstream[] = []
    socket.on('message', (raw) =>
      received.push(parseNodeFrame(JSON.parse(String(raw)), 'downstream')),
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(
      frame('node.hello', {
        deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: [],
        coordinationCapabilities: ['coordination.v1'],
      }),
    )
    socket.send(
      frame('node.inventory', {
        deviceId,
        credentialSlots: [],
        workspaces: [],
        coordinationCredentialSlots: [
          {
            scope: 'coordination',
            provider: 'router-test',
            model: 'router-v1',
            slot: 'coordination',
            ownerUserId: alice.userId,
            billingUserId: alice.userId,
            configRevision: 'test.v1',
          },
        ],
      }),
    )
    await waitForValue(async () => {
      const [d] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      const caps = d?.capabilities as { coordinationCredentialSlots?: unknown[] } | undefined
      return caps?.coordinationCredentialSlots?.length === 1 ? true : undefined
    }, 'coordination inventory was not persisted')
    const configuration = {
      enabled: true,
      deviceId,
      operatorUserId: alice.userId,
      billingUserId: alice.userId,
      credentialSlot: 'coordination',
      credentialConfigRevision: 'test.v1',
      provider: 'router-test',
      model: 'router-v1',
      teamDailyCallLimit: 20,
      teamDailyTokenLimit: 1000000,
      teamDailyCostMicrosLimit: 1000000,
      projectDailyCallLimit: 20,
      projectDailyTokenLimit: 1000000,
      projectDailyCostMicrosLimit: 1000000,
      maxInputTokens: 64000,
      maxOutputTokens: 2048,
      maxCostMicros: 10000,
      inputPriceMicrosPerMillionTokens: 1000,
      outputPriceMicrosPerMillionTokens: 1000,
      timeoutSeconds: 60,
      maxRetries: 1,
    }
    const configure = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: configuration,
    })
    expect(configure.statusCode, configure.body).toBe(200)
    return { socket, received, configuration, deviceId, deviceToken }
  }
  async function evaluate() {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    return res.json().data as { id: string; evaluationDigest: string; status: string }
  }
  async function dispatch(node: Awaited<ReturnType<typeof onlineNode>>) {
    const evaluated = await evaluate()
    await runRouterTick({ database })
    const request = await waitForValue(async () => {
      const message = node.received.find(
        (m) => m.type === 'coordination.request' && m.payload.evaluationId === evaluated.id,
      )
      return message?.type === 'coordination.request' ? message.payload : undefined
    }, 'evaluation was not dispatched')
    return request
  }
  async function readAndStart(
    node: Awaited<ReturnType<typeof onlineNode>>,
    request: CoordinationRequest,
  ) {
    for (const entry of request.manifest) {
      const download = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/coordination/evaluations/${request.evaluationId}/inputs/${entry.id}`,
        headers: {
          authorization: `Device ${node.deviceToken}`,
          'x-coordination-attempt': String(request.attempt),
          'x-coordination-lease': request.leaseToken,
        },
      })
      expect(download.statusCode, download.body).toBe(200)
      expect(download.headers['cache-control']).toBe('private, no-store')
      expect(
        sha256Hex(Buffer.from(download.json().data.bodyBase64 as string, 'base64').toString()),
      ).toBe(entry.digest)
    }
    node.socket.send(
      frame('coordination.heartbeat', {
        evaluationId: request.evaluationId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
        readEntryIds: request.manifest.map((e) => e.id),
        modelStartedAt: new Date().toISOString(),
      }),
    )
    await waitForValue(async () => {
      const row = await getEvaluation(database.db, request.evaluationId)
      return row?.modelStartedAt ? row : undefined
    }, 'model start/read receipt was not persisted')
  }
  function result(
    request: CoordinationRequest,
    decision: RouterProposal['decision'] = 'ignore',
  ): Extract<CoordinationResult, { status: 'completed' }> {
    const sources = request.manifest.filter((e) => e.kind === 'source')
    const base = {
      summary: '根据当前来源作出的有界判断',
      citations: sources.map((e) => e.id),
      coverage: sources.map((e) => ({
        inputId: e.id,
        status: 'uncovered' as const,
        evidenceIds: [],
      })),
    }
    const proposal: RouterProposal =
      decision === 'dispatch'
        ? { ...base, decision, workKey, actionClass: 'analysis' }
        : decision === 'wait'
          ? {
              ...base,
              decision,
              reason: 'upstream_pending',
              deadlineAt: new Date(Date.now() + 60000).toISOString(),
            }
          : decision === 'ask'
            ? {
                ...base,
                decision,
                questionType: 'authorize_scope',
                blockedDecision: 'dispatch',
                options: [{ id: 'review', label: '检查职责范围' }],
                recommendedOptionId: 'review',
              }
            : { ...base, decision: 'ignore', reason: 'no_action_required' }
    return {
      evaluationId: request.evaluationId,
      attempt: request.attempt,
      leaseToken: request.leaseToken,
      evaluationDigest: request.evaluationDigest,
      status: 'completed',
      resultDigest: sha256Hex(canonicalJson(proposal)),
      proposal,
      usage: {
        provider: request.provider,
        model: request.model,
        inputTokens: 100,
        outputTokens: 20,
        costMicros: coordinationUsageCost({ inputTokens: 100, outputTokens: 20, ...request }),
      },
      readEntryIds: request.manifest.map((e) => e.id),
    }
  }
  async function submit(node: Awaited<ReturnType<typeof onlineNode>>, payload: CoordinationResult) {
    const previous = node.received.filter((m) => m.type === 'coordination.result_ack').length
    node.socket.send(frame('coordination.result', payload))
    return waitForValue(async () => {
      const acks = node.received.filter((m) => m.type === 'coordination.result_ack')
      const latest = acks[previous]
      return latest?.type === 'coordination.result_ack' ? latest.payload : undefined
    }, 'result was not acknowledged')
  }

  it.each(['dispatch', 'wait', 'ask', 'ignore'] as const)(
    'accepts %s as a proposal with zero business side effects',
    async (decision) => {
      const node = await onlineNode()
      const request = await dispatch(node)
      await readAndStart(node, request)
      expect((await submit(node, result(request, decision))).status).toBe('accepted')
      const row = await getEvaluation(database.db, request.evaluationId)
      expect(row?.routerProposal?.decision).toBe(decision)
      expect(row?.inferenceEntryId).toBeNull()
      const counts = await database.sql`select (select count(*)::int from run) as runs,
      (select count(*)::int from dispatch_intent) as intents,(select count(*)::int from work_question) as questions,
      (select count(*)::int from coordination_usage_ledger where phase='settled') as settlements`
      expect(counts[0]).toMatchObject({ runs: 0, intents: 0, questions: 0, settlements: 1 })
      expect((await submit(node, result(request, decision))).status).toBe('duplicate')
      expect(await evaluate()).toMatchObject({ id: request.evaluationId, status: 'completed' })
    },
  )

  it('deduplicates concurrent requests and redelivery without another reservation', async () => {
    const node = await onlineNode()
    const evaluations = await Promise.all([evaluate(), evaluate()])
    expect(evaluations[0]?.id).toBe(evaluations[1]?.id)
    await Promise.all([runRouterTick({ database }), runRouterTick({ database })])
    const rows =
      await database.sql`select phase,count(*)::int as n from coordination_usage_ledger group by phase`
    expect(rows).toEqual([{ phase: 'reserved', n: 1 }])
    expect(node.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('refuses a completed result without persisted reads or model-start evidence', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    expect((await submit(node, result(request))).status).toBe('rejected')
    const row = await getEvaluation(database.db, request.evaluationId)
    expect(row?.status).toBe('stale')
    const ledger =
      await database.sql`select charge_mode from coordination_usage_ledger where phase='settled'`
    expect(ledger[0]?.charge_mode).toBe('actual')
  })

  it('does not acknowledge model start until every manifest input has a read receipt', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    node.socket.send(
      frame('coordination.heartbeat', {
        evaluationId: request.evaluationId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
        readEntryIds: [request.manifest[0]!.id],
        modelStartedAt: new Date().toISOString(),
      }),
    )
    // The invalid receipt is followed by a result on the same production WS connection.
    expect((await submit(node, result(request))).status).toBe('rejected')
    expect((await getEvaluation(database.db, request.evaluationId))?.modelStartedAt).toBeNull()
  })

  it('requires persisted model-start evidence even after complete read receipts', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    node.socket.send(
      frame('coordination.heartbeat', {
        evaluationId: request.evaluationId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
        readEntryIds: request.manifest.map((e) => e.id),
      }),
    )
    await waitForValue(async () => {
      const row = await getEvaluation(database.db, request.evaluationId)
      return row?.readEntryIds.length === request.manifest.length ? true : undefined
    }, 'read receipts not persisted')
    expect((await submit(node, result(request))).status).toBe('rejected')
    expect((await getEvaluation(database.db, request.evaluationId))?.failureCode).toBe(
      'model_start_missing',
    )
  })

  it('rechecks a lease that expires while rebuilding authorized input', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    let observations = 0
    const late = new Date(Date.parse(request.deadlineAt) + 1000)
    await expect(
      downloadRouterInput(
        { database, now: () => (++observations === 1 ? new Date() : late) },
        node.deviceId,
        request.evaluationId,
        request.manifest[0]!.id,
        request.attempt,
        request.leaseToken,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects duplicate source coverage even when all unique sources are present', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    const payload = result(request)
    payload.proposal.coverage.push({ ...payload.proposal.coverage[0]! })
    payload.resultDigest = sha256Hex(canonicalJson(payload.proposal))
    expect((await submit(node, payload)).status).toBe('rejected')
    expect((await getEvaluation(database.db, request.evaluationId))?.failureCode).toBe(
      'coverage_missing',
    )
  })

  it('rejects caller-generated trigger generations', async () => {
    await onlineNode()
    const response = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId, triggerKey: 'invented-new-attempt' },
    })
    expect(response.statusCode).toBe(400)
    expect(await database.db.select().from(schema.coordinationUsageLedger)).toHaveLength(0)
  })

  it('keeps charged failures across new Mandate versions instead of resetting attempts', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    expect(
      (
        await submit(node, {
          evaluationId: request.evaluationId,
          attempt: request.attempt,
          leaseToken: request.leaseToken,
          evaluationDigest: request.evaluationDigest,
          status: 'failed',
          failureCode: 'worker_failed',
          usage: result(request).usage,
          readEntryIds: request.manifest.map((e) => e.id),
        })
      ).status,
    ).toBe('rejected')
    const renewed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        allowedActionClasses: ['analysis'],
        allowedSourceTypes: ['task_message'],
        allowedToolNames: ['read'],
        maxTokens: 100000,
        maxCostMicros: 1000000,
        maxAttempts: 1,
      },
    })
    expect(renewed.statusCode, renewed.body).toBe(201)
    const next = await evaluate()
    expect(next.evaluationDigest).not.toBe(request.evaluationDigest)
    await runRouterTick({ database })
    expect(await getEvaluation(database.db, next.id)).toMatchObject({
      status: 'skipped',
      failureCode: 'max_attempts_exhausted',
    })
    expect(
      (await database.db.select().from(schema.coordinationUsageLedger)).filter(
        (row) => row.phase === 'reserved',
      ),
    ).toHaveLength(1)
  })

  it('blocks unmetered Executor spending while a Router reservation exists', async () => {
    const node = await onlineNode()
    await dispatch(node)
    const associated = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items`,
      payload: { sourceType: 'task_message', sourceId },
    })
    expect(associated.statusCode, associated.body).toBe(201)
    const admission = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId },
    })
    expect(admission.statusCode, admission.body).toBe(200)
    const intentId = admission.json().data.proposedIntent.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/works/${workKey}/dispatch-intents/${intentId}/approve`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    const executed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: randomUUID(),
        deviceId: node.deviceId,
        workspaceId: randomUUID(),
        actionClass: 'analysis',
        workInputItemIds: [associated.json().data.id],
      },
    })
    expect(executed.statusCode, executed.body).toBe(409)
    expect(executed.json().error.message).toBe('executor_usage_unavailable')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it.each([
    'missing_usage',
    'forged_citation',
    'wrong_digest',
    'unknown_coverage',
    'over_usage',
    'wrong_model',
    'underreported_cost',
    'unknown_ignore',
    'missing_coverage',
    'wrong_result_digest',
  ] as const)('rejects %s and settles without a proposal', async (defect) => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    const payload = result(request, defect === 'unknown_coverage' ? 'dispatch' : 'ignore')
    if (defect === 'missing_usage') delete payload.usage
    if (defect === 'forged_citation') payload.proposal.citations = [randomUUID()]
    if (defect === 'wrong_digest') payload.evaluationDigest = 'a'.repeat(64)
    if (defect === 'unknown_coverage') payload.proposal.coverage[0]!.status = 'unknown'
    if (defect === 'unknown_ignore') payload.proposal.coverage[0]!.status = 'unknown'
    if (defect === 'missing_coverage')
      payload.proposal.coverage[0]!.inputId = request.manifest.find(
        (entry) => entry.kind === 'work',
      )!.id
    if (defect === 'over_usage') {
      payload.usage!.inputTokens = request.maxInputTokens + 1
      payload.usage!.costMicros = coordinationUsageCost({ ...request, ...payload.usage! })
    }
    if (defect === 'wrong_model') payload.usage!.model = 'unconfigured-model'
    if (defect === 'underreported_cost') payload.usage!.costMicros = 0
    payload.resultDigest = sha256Hex(canonicalJson(payload.proposal))
    if (defect === 'wrong_result_digest') payload.resultDigest = 'b'.repeat(64)
    expect((await submit(node, payload)).status).toBe('rejected')
    const row = await getEvaluation(database.db, request.evaluationId)
    expect(row?.routerProposal).toBeNull()
    expect(
      (
        await database.sql`select count(*)::int as n from coordination_usage_ledger where phase='settled'`
      )[0]?.n,
    ).toBe(1)
  })

  it('revocation invalidates downloads and late output without reviving the evaluation', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/mandates/${mandateId}/revoke`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    const entry = request.manifest[0]!
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/coordination/evaluations/${request.evaluationId}/inputs/${entry.id}`,
          headers: {
            authorization: `Device ${node.deviceToken}`,
            'x-coordination-attempt': String(request.attempt),
            'x-coordination-lease': request.leaseToken,
          },
        })
      ).statusCode,
    ).toBe(409)
    await runRouterTick({ database })
    expect((await submit(node, result(request))).status).toBe('late')
    expect((await getEvaluation(database.db, request.evaluationId))?.status).toBe('cancelled')
  })

  it('times out a lost model and conservatively charges its reservation once', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    await runRouterTick({
      database,
      now: () => new Date(new Date(request.deadlineAt).getTime() + 1000),
    })
    expect((await getEvaluation(database.db, request.evaluationId))?.failureCode).toBe('timeout')
    expect((await submit(node, result(request))).status).toBe('late')
    const ledger =
      await database.sql`select charge_mode from coordination_usage_ledger where phase='settled'`
    expect(ledger).toEqual([{ charge_mode: 'reserved' }])
  })

  it.each([false, true])(
    'only a confirmed pre-model failure can settle zero (reported usage: %s)',
    async (spent) => {
      const node = await onlineNode()
      const request = await dispatch(node)
      const failure: CoordinationResult = {
        evaluationId: request.evaluationId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
        evaluationDigest: request.evaluationDigest,
        status: 'failed',
        failureCode: 'credential_unavailable',
        readEntryIds: [],
        ...(spent ? { usage: result(request).usage! } : {}),
      }
      expect((await submit(node, failure)).status).toBe('rejected')
      const ledger =
        await database.sql`select charge_mode from coordination_usage_ledger where phase='settled'`
      expect(ledger).toEqual([{ charge_mode: spent ? 'actual' : 'zero' }])
    },
  )

  it('a source cancellation without model-start acknowledgement never proves a free model call', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/mandates/${mandateId}/revoke`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    await runRouterTick({ database })
    const row = await getEvaluation(database.db, request.evaluationId)
    expect(row?.status).toBe('cancelled')
    const ledger =
      await database.sql`select charge_mode from coordination_usage_ledger where phase='settled'`
    expect(ledger).toEqual([{ charge_mode: 'reserved' }])
  })

  it('rejects wrong lease and attempt without consuming the valid attempt', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    const original = result(request)
    expect((await submit(node, { ...original, leaseToken: 'b'.repeat(64) })).status).toBe(
      'rejected',
    )
    expect((await submit(node, { ...original, attempt: request.attempt + 1 })).status).toBe(
      'rejected',
    )
    expect((await getEvaluation(database.db, request.evaluationId))?.status).toBe('running')
    expect((await submit(node, original)).status).toBe('accepted')
  })

  it('rechecks withdrawn coordination capability before accepting a model output', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    node.socket.send(
      frame('node.inventory', {
        deviceId: node.deviceId,
        credentialSlots: [],
        workspaces: [],
        coordinationCredentialSlots: [],
      }),
    )
    await waitForValue(async () => {
      const [d] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, node.deviceId))
      const capabilities = d?.capabilities as
        | { coordinationCredentialSlots?: unknown[] }
        | undefined
      return capabilities?.coordinationCredentialSlots?.length === 0 ? true : undefined
    }, 'credential withdrawal not observed')
    expect((await submit(node, result(request))).status).toBe('rejected')
    expect((await getEvaluation(database.db, request.evaluationId))?.failureCode).toBe(
      'input_or_authority_changed',
    )
  })

  it('enforces the current Mandate wait deadline instead of allowing an arbitrary day', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    const payload = result(request, 'wait')
    if (payload.proposal.decision !== 'wait') throw new Error('wrong fixture')
    payload.proposal.deadlineAt = new Date(Date.now() + 3600000).toISOString()
    payload.resultDigest = sha256Hex(canonicalJson(payload.proposal))
    expect((await submit(node, payload)).status).toBe('rejected')
    expect((await getEvaluation(database.db, request.evaluationId))?.failureCode).toBe(
      'invalid_wait_deadline',
    )
  })

  it('ignores a stale result after explicit model configuration changes', async () => {
    const node = await onlineNode()
    const request = await dispatch(node)
    await readAndStart(node, request)
    const configured = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: { ...node.configuration, model: 'router-v2' },
    })
    expect(configured.statusCode).toBe(200)
    expect((await submit(node, result(request))).status).toBe('rejected')
    expect((await getEvaluation(database.db, request.evaluationId))?.routerProposal).toBeNull()
  })

  it('keeps private evaluation history and triggering authority with the current assignee', async () => {
    await onlineNode()
    const bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    expect(
      (
        await apiInject(ctx, bob, {
          method: 'GET',
          url: `/api/v1/works/${workKey}/router/evaluations`,
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await apiInject(ctx, bob, {
          method: 'POST',
          url: `/api/v1/works/${workKey}/router/evaluate`,
          payload: { sourceType: 'task_message', sourceId },
        })
      ).statusCode,
    ).toBe(403)
  })

  it('reauthorizes cached evaluation receipts after reassignment and hides old principal history', async () => {
    await onlineNode()
    const key = randomUUID()
    const command = {
      method: 'POST' as const,
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId },
      idempotencyKey: key,
    }
    const first = await apiInject(ctx, alice, command)
    expect(first.statusCode, first.body).toBe(200)
    expect((await apiInject(ctx, alice, command)).json().data.id).toBe(first.json().data.id)
    const bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    const reassign = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: bob.userId },
    })
    expect(reassign.statusCode, reassign.body).toBe(200)
    expect((await apiInject(ctx, alice, command)).statusCode).toBe(403)
    const oldHistory = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/router/evaluations`,
    })
    expect(oldHistory.statusCode).toBe(403)
    const newHistory = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/router/evaluations`,
    })
    expect(newHistory.statusCode, newHistory.body).toBe(200)
    expect(newHistory.json().data).toEqual([])
  })
})
