/**
 * #520 / RD-03r2：已接受 Router 提案经 Hub 应用端口进入既有意图/问题/wait/收件箱，
 * 以及业务 Executor 的共享 token/cost 账本。驱动全部走生产 HTTP/WS/DB 路径；
 * 业务 Run 终态只由 Node 上行 run.event 产生。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getEvaluation, schema, settleExecutorUsage } from '@whalepod/db'
import {
  coordinationUsageCost,
  parseNodeFrame,
  type CoordinationRequest,
  type CoordinationResult,
  type NodeDownstream,
  type RouterProposal,
} from '@whalepod/protocol'
import { applyRouterEvaluation } from '../src/modules/router/application.js'
import { runRouterTick } from '../src/modules/router/service.js'
import { autoDispatchProposedIntent } from '../src/modules/dispatch/service.js'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  idemKey,
  resetDatabase,
  runEventFrame,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

const ACTION = 'analysis' as const

describe('RD-03r2 Router application and Executor ledger', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let projectId: string
  let taskId: string
  let workKey: string
  let sourceId: string
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
      payload: { name: `rd03r2-${randomUUID()}` },
    })
    expect(project.statusCode, project.body).toBe(201)
    projectId = project.json().data.id as string
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '接驳安排', assigneeUserId: alice.userId },
    })
    expect(task.statusCode, task.body).toBe(201)
    taskId = task.json().data.id as string
    expect(
      (await apiInject(ctx, alice, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` }))
        .statusCode,
    ).toBe(200)
    // 来源先于工作创建：入口准入没有可投递工作，不会预置收件箱副本；本切片
    // 只验证 Router 应用自身产生的收件箱条目。
    const message = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '客户确认高铁站到场地交通不方便，需要接驳方案。' },
    })
    expect(message.statusCode, message.body).toBe(201)
    sourceId = message.json().data.id as string
    const work = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: '依据讨论安排接驳' },
    })
    expect(work.statusCode, work.body).toBe(201)
    workKey = work.json().data.workKey as string
  })
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function createMandate(
    options: {
      autoDispatch?: 'off' | 'existing_task'
      allowedAgentIds?: string[]
      maxRunsPerWork?: number
      maxTokens?: number
      maxCostMicros?: number
      allowedActionClasses?: readonly ('research' | 'analysis' | 'draft' | 'revise')[]
    } = {},
  ) {
    const mandate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        allowedActionClasses: options.allowedActionClasses ?? [ACTION],
        allowedSourceTypes: ['task_message'],
        allowedToolNames: ['read'],
        autoDispatch: options.autoDispatch ?? 'off',
        ...(options.allowedAgentIds === undefined
          ? {}
          : { allowedAgentIds: options.allowedAgentIds }),
        ...(options.maxRunsPerWork === undefined ? {} : { maxRunsPerWork: options.maxRunsPerWork }),
        maxTokens: options.maxTokens ?? 100_000,
        maxCostMicros: options.maxCostMicros ?? 1_000_000,
      },
    })
    expect(mandate.statusCode, mandate.body).toBe(201)
    return mandate.json().data as { id: string; version: number }
  }

  async function createAgent(withPricing = true): Promise<{ agentId: string; revisionId: string }> {
    // removeWhen: Agent 创建尚无 HTTP 面；只造 profile FK，不写运行时状态。
    const suffix = randomUUID().slice(0, 8)
    const packId = randomUUID()
    const agentId = randomUUID()
    const revisionId = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id: packId,
      name: `rd03r2-pack-${suffix}`,
      installations: [],
      packDigest: 'a'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db.insert(schema.agents).values({
      id: agentId,
      name: `rd03r2-agent-${suffix}`,
      description: '',
      createdBy: alice.userId,
    })
    await database.db.insert(schema.agentProfileRevisions).values({
      id: revisionId,
      agentId,
      revision: 1,
      persona: '测试 Agent',
      provider: 'test',
      model: 'test',
      credentialSlot: 'test',
      maxTokens: 50_000,
      ...(withPricing
        ? {
            inputPriceMicrosPerMillionTokens: 1000,
            outputPriceMicrosPerMillionTokens: 2000,
          }
        : {}),
      pluginPackId: packId,
      profileDigest: 'b'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db
      .update(schema.agents)
      .set({ currentRevisionId: revisionId })
      .where(eq(schema.agents.id, agentId))
    return { agentId, revisionId }
  }

  async function createDevice(): Promise<{ deviceId: string; workspaceId: string }> {
    // removeWhen: Device 配对走既有 WS 握手；本夹具只造在线设备/工作区 FK。
    const suffix = randomUUID().slice(0, 8)
    const deviceId = randomUUID()
    const workspaceId = randomUUID()
    await database.db.insert(schema.devices).values({
      id: deviceId,
      ownerUserId: alice.userId,
      name: `rd03r2-dev-${suffix}`,
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: randomBytes(32),
      capabilities: {
        contextCapabilities: ['project-context.v1', 'context-state.v1', 'work-input.v1'],
      },
      dshDistributionVersion: '0.1.0-rc.8',
      lastSeenAt: new Date(),
    })
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId,
      ownerUserId: alice.userId,
      name: `rd03r2-ws-${suffix}`,
      kind: 'directory',
      capabilities: { read: true, write: true },
      available: true,
      lastCheckedAt: new Date(),
    })
    return { deviceId, workspaceId }
  }

  function frame(type: string, payload: unknown) {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type,
      payload,
    })
  }

  async function onlineRouterNode() {
    const code = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    expect(code.statusCode, code.body).toBe(201)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: code.json().data.code,
        name: `rd03r2-router-${randomUUID()}`,
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode, claim.body).toBe(201)
    const { deviceId, deviceToken } = claim.json().data as {
      deviceId: string
      deviceToken: string
    }
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
      const [row] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      const caps = row?.capabilities as { coordinationCredentialSlots?: unknown[] } | undefined
      return caps?.coordinationCredentialSlots?.length === 1 ? true : undefined
    }, 'coordination inventory was not persisted')
    const configure = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: {
        enabled: true,
        deviceId,
        operatorUserId: alice.userId,
        billingUserId: alice.userId,
        credentialSlot: 'coordination',
        credentialConfigRevision: 'test.v1',
        provider: 'router-test',
        model: 'router-v1',
        teamDailyCallLimit: 20,
        teamDailyTokenLimit: 1_000_000,
        teamDailyCostMicrosLimit: 1_000_000,
        projectDailyCallLimit: 20,
        projectDailyTokenLimit: 1_000_000,
        projectDailyCostMicrosLimit: 1_000_000,
        maxInputTokens: 64_000,
        maxOutputTokens: 2048,
        maxCostMicros: 10_000,
        inputPriceMicrosPerMillionTokens: 1000,
        outputPriceMicrosPerMillionTokens: 1000,
        timeoutSeconds: 60,
        maxRetries: 1,
      },
    })
    expect(configure.statusCode, configure.body).toBe(200)
    return { socket, received, deviceId, deviceToken }
  }

  async function evaluate(source = sourceId) {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId: source },
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as { id: string; evaluationDigest: string; status: string }
  }

  async function dispatchEvaluation(node: Awaited<ReturnType<typeof onlineRouterNode>>) {
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
    node: Awaited<ReturnType<typeof onlineRouterNode>>,
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
    decision: RouterProposal['decision'] = 'dispatch',
    questionType: 'choose_option' | 'authorize_scope' = 'choose_option',
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
        ? { ...base, decision, workKey, actionClass: ACTION }
        : decision === 'wait'
          ? {
              ...base,
              decision,
              reason: 'upstream_pending',
              deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            }
          : decision === 'ask'
            ? {
                ...base,
                decision,
                questionType,
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

  async function submit(
    node: Awaited<ReturnType<typeof onlineRouterNode>>,
    payload: CoordinationResult,
  ) {
    const previous = node.received.filter((m) => m.type === 'coordination.result_ack').length
    node.socket.send(frame('coordination.result', payload))
    return waitForValue(async () => {
      const acks = node.received.filter((m) => m.type === 'coordination.result_ack')
      const latest = acks[previous]
      return latest?.type === 'coordination.result_ack' ? latest.payload : undefined
    }, 'result was not acknowledged')
  }

  async function acceptProposal(
    node: Awaited<ReturnType<typeof onlineRouterNode>>,
    decision: RouterProposal['decision'],
    questionType: 'choose_option' | 'authorize_scope' = 'choose_option',
    source = sourceId,
  ) {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId: source },
    })
    expect(res.statusCode, res.body).toBe(200)
    const evaluated = res.json().data as { id: string }
    await runRouterTick({ database })
    const request = await waitForValue(async () => {
      const message = node.received.find(
        (m) => m.type === 'coordination.request' && m.payload.evaluationId === evaluated.id,
      )
      return message?.type === 'coordination.request' ? message.payload : undefined
    }, 'evaluation was not dispatched')
    await readAndStart(node, request)
    expect((await submit(node, result(request, decision, questionType))).status).toBe('accepted')
    return request
  }

  async function application(evaluationId: string) {
    const [row] = await database.db
      .select()
      .from(schema.routerApplications)
      .where(eq(schema.routerApplications.evaluationId, evaluationId))
    return row
  }

  async function workBudget() {
    const rows = await database.sql`select * from coordination_budget where scope='work'`
    const row = rows[0] as Record<string, string | number> | undefined
    if (row === undefined) return undefined
    return {
      calls: Number(row.calls),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cost_micros: Number(row.cost_micros),
      reserved_tokens: Number(row.reserved_tokens),
      reserved_cost_micros: Number(row.reserved_cost_micros),
    }
  }

  it('applies dispatch to a proposed intent and settles the machine Run usage', async () => {
    const agent = await createAgent()
    const device = await createDevice()
    await createMandate({ allowedAgentIds: [agent.agentId], maxRunsPerWork: 2 })
    const node = await onlineRouterNode()

    const request = await acceptProposal(node, 'dispatch')
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({ decision: 'dispatch', status: 'applied' })
    expect(applied?.intentId).toBeTruthy()
    expect(applied?.runId).toBeNull()

    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, applied!.intentId!))
    expect(intent).toMatchObject({ status: 'proposed', approvalBasis: null, actionClass: null })
    const items = await database.db.select().from(schema.workInboxItems)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'pending', autoAdmitted: true })
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)

    // 重复应用同一 evaluationId 不产生第二条意图。
    const again = await applyRouterEvaluation({ database }, request.evaluationId).catch(
      () => undefined,
    )
    expect(again?.evaluationId).toBe(request.evaluationId)
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(1)

    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/works/${workKey}/dispatch-intents/${intent!.id}/approve`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/dispatch-intents/${intent!.id}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: ACTION,
        workInputItemIds: [items[0]!.id],
      },
    })
    expect(dispatched.statusCode, dispatched.body).toBe(200)
    const runId = dispatched.json().data.runId as string
    expect(runId).toBeTruthy()

    const reserved = await database.db
      .select()
      .from(schema.executorUsageLedger)
      .where(eq(schema.executorUsageLedger.runId, runId))
    expect(reserved.filter((row) => row.phase === 'reserved')).toHaveLength(1)
    expect(reserved[0]?.reservedTokens).toBeGreaterThan(0)
    expect(reserved[0]?.reservedCostMicros).toBeGreaterThan(0)
    expect(await workBudget()).toMatchObject({
      calls: 2, // Router 评估派发 1 + Executor Run 派发 1，共享同一 work 账本
      reserved_tokens: reserved[0]!.reservedTokens,
    })

    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: 'rd03r2-business' }),
    )
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 2, {
        type: 'run.completed',
        finalText: '接驳草案',
        usage: { inputTokens: 300, outputTokens: 40 },
      }),
    )
    const settled = await database.db
      .select()
      .from(schema.executorUsageLedger)
      .where(eq(schema.executorUsageLedger.runId, runId))
    const settledRow = settled.find((row) => row.phase === 'settled')
    expect(settledRow).toMatchObject({
      chargeMode: 'actual',
      usage: {
        inputTokens: 300,
        outputTokens: 40,
        costMicros: Math.ceil((300 * 1000 + 40 * 2000) / 1_000_000),
      },
    })
    const budget = await workBudget()
    expect(budget).toMatchObject({
      // 共享 work lifetime：Router 100/20 + Executor 300/40。
      input_tokens: 400,
      output_tokens: 60,
      reserved_tokens: 0,
      reserved_cost_micros: 0,
    })
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.executorUsage).toEqual({ inputTokens: 300, outputTokens: 40 })
    expect(run?.executorCostMicros).toBe(settledRow?.usage?.costMicros)
    // 崩溃重试/重复终态：结算幂等，不重复记账。
    await database.transaction((tx) => settleExecutorUsage(tx, { runId }))
    expect(
      (
        await database.db
          .select()
          .from(schema.executorUsageLedger)
          .where(eq(schema.executorUsageLedger.runId, runId))
      ).filter((row) => row.phase === 'settled'),
    ).toHaveLength(1)
    expect(await workBudget()).toMatchObject({ input_tokens: 400, output_tokens: 60 })
  })

  it('falls back to the reservation when terminal usage is missing', async () => {
    const agent = await createAgent()
    const device = await createDevice()
    await createMandate({ allowedAgentIds: [agent.agentId] })
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'dispatch')
    const applied = await application(request.evaluationId)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, applied!.intentId!))
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/dispatch-intents/${intent!.id}/approve`,
      payload: {},
    })
    const [item] = await database.db.select().from(schema.workInboxItems)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/dispatch-intents/${intent!.id}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: ACTION,
        workInputItemIds: [item!.id],
      },
    })
    expect(dispatched.statusCode, dispatched.body).toBe(200)
    const runId = dispatched.json().data.runId as string
    const [reserved] = await database.db
      .select()
      .from(schema.executorUsageLedger)
      .where(eq(schema.executorUsageLedger.runId, runId))
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'run.completed', finalText: '无 usage 的完成' }),
    )
    const rows = await database.db
      .select()
      .from(schema.executorUsageLedger)
      .where(eq(schema.executorUsageLedger.runId, runId))
    const settled = rows.find((row) => row.phase === 'settled')
    expect(settled).toMatchObject({ chargeMode: 'reserved', usage: null })
    const budget = await workBudget()
    expect(budget?.input_tokens).toBeGreaterThanOrEqual(reserved!.reservedTokens)
    expect(budget?.reserved_tokens).toBe(0)
  })

  it('auto-dispatches existing_task exactly once after application', async () => {
    const agent = await createAgent()
    await createDevice()
    await createMandate({ autoDispatch: 'existing_task', allowedAgentIds: [agent.agentId] })
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'dispatch')
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({ decision: 'dispatch', status: 'applied' })
    expect(applied?.runId).toBeTruthy()
    const runs = await database.db.select().from(schema.runs)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ origin: 'mandate', workKey })
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, applied!.intentId!))
    expect(intent).toMatchObject({ status: 'dispatched', approvalBasis: 'mandate' })
    // 同 evaluation 再应用不产生第二个 Run。
    await applyRouterEvaluation({ database }, request.evaluationId)
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('persists wait and re-evaluates explicitly without treating it as execution', async () => {
    await createMandate()
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'wait')
    const [wait] = await database.db.select().from(schema.workWaits)
    expect(wait).toMatchObject({ status: 'open', evaluationId: request.evaluationId })
    const [work] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(work).toMatchObject({
      state: 'waiting',
      resumeMode: 'auto',
      resumeCondition: `router:${request.evaluationId}`,
    })
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(0)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)

    const reevaluated = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/re-evaluate`,
      payload: { waitId: wait!.id },
      idempotencyKey: idemKey(),
    })
    expect(reevaluated.statusCode, reevaluated.body).toBe(200)
    const nextId = reevaluated.json().data.id as string
    expect(nextId).not.toBe(request.evaluationId)
    const [closed] = await database.db.select().from(schema.workWaits)
    expect(closed?.status).toBe('resumed')
    const [resumed] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(resumed?.state).toBe('active')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('applies ask to the question ledger and keeps authorize_scope answers rejected', async () => {
    await createMandate()
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'ask', 'authorize_scope')
    const [question] = await database.db.select().from(schema.workQuestions)
    expect(question).toMatchObject({
      questionType: 'authorize_scope',
      principalUserId: alice.userId,
      status: 'open',
      dispatchIntentId: null,
    })
    expect(question?.decisionId).toMatch(/^[a-f0-9]{64}$/)
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({ decision: 'ask', status: 'applied', questionId: question!.id })

    const answer = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/questions/${question!.decisionId}/answers`,
      payload: { answerType: 'authorize_scope' },
      idempotencyKey: idemKey(),
    })
    expect(answer.statusCode, answer.body).toBe(400)
    expect(answer.json().error.code).toBe('UNSUPPORTED_ANSWER')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('refuses dispatch proposals whose action class is outside the mandate', async () => {
    await createMandate({ allowedActionClasses: ['draft'] })
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'dispatch')
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({
      decision: 'dispatch',
      status: 'stale',
      reason: 'action_class_forbidden',
    })
    expect(applied?.intentId).toBeNull()
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(0)
  })

  it('applies ignore without creating intent, question, wait or Run', async () => {
    await createMandate()
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'ignore')
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({ decision: 'ignore', status: 'applied' })
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(0)
    expect(await database.db.select().from(schema.workQuestions)).toHaveLength(0)
    expect(await database.db.select().from(schema.workWaits)).toHaveLength(0)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
    expect(await database.db.select().from(schema.workInboxItems)).toHaveLength(0)
  })

  it('refuses dispatch application while a machine Run is active', async () => {
    const agent = await createAgent()
    await createDevice()
    await createMandate({ autoDispatch: 'existing_task', allowedAgentIds: [agent.agentId] })
    const node = await onlineRouterNode()
    await acceptProposal(node, 'dispatch')
    const [first] = await database.db.select().from(schema.runs)
    expect(first?.status).toBe('queued')
    const secondSource = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '补充：接驳时间也需要确认。' },
    })
    expect(secondSource.statusCode, secondSource.body).toBe(201)
    const request = await acceptProposal(
      node,
      'dispatch',
      'choose_option',
      secondSource.json().data.id,
    )
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({ decision: 'dispatch', status: 'stale', reason: 'active_run' })
    expect(applied?.intentId).toBeNull()
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('shares work lifetime budget between Router and Executor and blocks unpriced dispatch', async () => {
    const unpriced = await createAgent(false)
    const device = await createDevice()
    await createMandate({ allowedAgentIds: [unpriced.agentId], autoDispatch: 'existing_task' })
    const node = await onlineRouterNode()
    const request = await acceptProposal(node, 'dispatch')
    const applied = await application(request.evaluationId)
    expect(applied).toMatchObject({ decision: 'dispatch', status: 'applied' })
    expect(applied?.runId).toBeNull()
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, applied!.intentId!))
    expect(intent).toMatchObject({
      status: 'rejected',
      resolutionReason: 'executor_usage_unavailable',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
    expect(await database.db.select().from(schema.executorUsageLedger)).toHaveLength(0)

    // 人工确认路径同闸：同一定价缺失的候选不能绕过。
    const human = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/dispatch-intents/${intent!.id}/dispatch`,
      payload: {
        agentId: unpriced.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: ACTION,
      },
    })
    expect(human.statusCode).toBe(409)
  })
})
