/**
 * #518 / RD-03d3：Run 终态复核与 wait 到期重评。
 *
 * 驱动全部走生产路径：机器 Run 由 Router 应用 + autoDispatch 端口创建，终态由
 * Node 上行 run.event 产生；边界调度走 runRouterTick 的受控后续事务；模型结果
 * 走真实 coordination.request/result WS 帧。本 spec 只断言工程行为，不评价模型
 * 语义质量（保持 not_run）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getEvaluation, Outbox, schema } from '@whalepod/db'
import {
  coordinationUsageCost,
  parseNodeFrame,
  type CoordinationRequest,
  type CoordinationResult,
  type NodeDownstream,
  type RouterProposal,
} from '@whalepod/protocol'
import { ArtifactStore } from '../src/modules/artifact/store.js'
import { applyRunStatus } from '../src/modules/run/run-status.js'
import { applyRouterEvaluation } from '../src/modules/router/application.js'
import { runRouterTick } from '../src/modules/router/service.js'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  resetDatabase,
  runEventFrame,
  seedRunChainForUser,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

const ACTION = 'analysis' as const

describe('RD-03d3 Run boundary and wait expiry scheduling', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let workKey: string
  let sourceA: string
  const sockets: WebSocket[] = []
  const schedulerLogs: Record<string, unknown>[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    schedulerLogs.splice(0)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: `rd03d3-${randomUUID()}` },
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
    // 来源先于工作创建：入口准入没有可投递工作，不会预置收件箱副本。
    sourceA = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        payload: { body: '客户确认高铁站到场地交通不方便，需要接驳方案。' },
      })
    ).json().data.id as string
    const work = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: '依据讨论安排接驳' },
      idempotencyKey: idemKey(),
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

  function store() {
    return new ArtifactStore({ root: ctx.config.artifactStoreDir })
  }

  async function createMandate(
    options: {
      autoDispatch?: 'off' | 'existing_task'
      allowedAgentIds?: string[]
      maxRunsPerWork?: number
      maxTokens?: number
      maxCostMicros?: number
    } = {},
  ) {
    const mandate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        allowedActionClasses: [ACTION],
        allowedSourceTypes: ['task_message'],
        allowedToolNames: ['read'],
        autoDispatch: options.autoDispatch ?? 'off',
        ...(options.allowedAgentIds === undefined
          ? {}
          : { allowedAgentIds: options.allowedAgentIds }),
        ...(options.maxRunsPerWork === undefined ? {} : { maxRunsPerWork: options.maxRunsPerWork }),
        maxTokens: options.maxTokens ?? 200_000,
        maxCostMicros: options.maxCostMicros ?? 2_000_000,
      },
      idempotencyKey: idemKey(),
    })
    expect(mandate.statusCode, mandate.body).toBe(201)
    return mandate.json().data as { id: string; version: number }
  }

  async function createAgent(): Promise<{ agentId: string; revisionId: string }> {
    // removeWhen: Agent 创建尚无 HTTP 面；只造 profile FK，不写运行时状态。
    const suffix = randomUUID().slice(0, 8)
    const packId = randomUUID()
    const agentId = randomUUID()
    const revisionId = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id: packId,
      name: `rd03d3-pack-${suffix}`,
      installations: [],
      packDigest: 'a'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db.insert(schema.agents).values({
      id: agentId,
      name: `rd03d3-agent-${suffix}`,
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
      inputPriceMicrosPerMillionTokens: 1000,
      outputPriceMicrosPerMillionTokens: 2000,
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

  function frame(type: string, payload: unknown) {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type,
      payload,
    })
  }

  /**
   * 配对一个真实的 Node 设备并建立 WS：它同时承担 Router 受限评估与业务 Run。
   * 工作区是设备侧事实；测试夹具只补 FK 行（与本文件其它 device/agent 夹具同型）。
   */
  async function onlineNode(options: { workspace?: boolean } = {}) {
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
        name: `rd03d3-node-${randomUUID()}`,
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
    let workspaceId: string | undefined
    if (options.workspace === true) workspaceId = randomUUID()
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
        contextCapabilities: ['project-context.v1', 'context-state.v1', 'work-input.v1'],
      }),
    )
    socket.send(
      frame('node.inventory', {
        deviceId,
        credentialSlots: [],
        workspaces:
          workspaceId === undefined
            ? []
            : [
                {
                  workspaceId,
                  name: `rd03d3-ws-${workspaceId.slice(0, 8)}`,
                  kind: 'directory',
                  capabilities: { read: true, write: true, git: false },
                  available: true,
                  lastCheckedAt: new Date().toISOString(),
                },
              ],
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
    if (workspaceId !== undefined) {
      await waitForValue(async () => {
        const rows = await database.db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.deviceId, deviceId))
        return rows.some((row) => row.id === workspaceId && row.available) ? true : undefined
      }, 'workspace inventory was not persisted')
    }
    const configure = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: routerConfigPayload(deviceId),
      idempotencyKey: idemKey(),
    })
    expect(configure.statusCode, configure.body).toBe(200)
    return { socket, received, deviceId, deviceToken, workspaceId }
  }

  function routerConfigPayload(deviceId: string) {
    return {
      enabled: true,
      deviceId,
      operatorUserId: alice.userId,
      billingUserId: alice.userId,
      credentialSlot: 'coordination',
      credentialConfigRevision: 'test.v1',
      provider: 'router-test',
      model: 'router-v1',
      teamDailyCallLimit: 30,
      teamDailyTokenLimit: 2_000_000,
      teamDailyCostMicrosLimit: 2_000_000,
      projectDailyCallLimit: 30,
      projectDailyTokenLimit: 2_000_000,
      projectDailyCostMicrosLimit: 2_000_000,
      maxInputTokens: 64_000,
      maxOutputTokens: 2048,
      maxCostMicros: 10_000,
      inputPriceMicrosPerMillionTokens: 1000,
      outputPriceMicrosPerMillionTokens: 1000,
      timeoutSeconds: 60,
      maxRetries: 1,
    }
  }

  async function tick() {
    await runRouterTick({
      database,
      store: store(),
      log: (event) => schedulerLogs.push(event),
    })
  }

  async function waitForRequest(
    node: Awaited<ReturnType<typeof onlineNode>>,
    evaluationId: string,
  ) {
    return waitForValue(async () => {
      const message = node.received.find(
        (m) => m.type === 'coordination.request' && m.payload.evaluationId === evaluationId,
      )
      return message?.type === 'coordination.request' ? message.payload : undefined
    }, 'router evaluation request was not dispatched')
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
    decision: RouterProposal['decision'],
    coverageFor: (entry: { id: string; kind: string; sourceId: string }) => {
      status: 'covered' | 'uncovered' | 'unknown'
      evidenceIds: string[]
    },
  ): Extract<CoordinationResult, { status: 'completed' }> {
    const sources = request.manifest.filter((entry) => entry.kind === 'source')
    const evidenceIds = request.manifest
      .filter((entry) => entry.kind === 'evidence')
      .map((entry) => entry.id)
    const coverage = sources.map((entry) => {
      const decided = coverageFor(entry)
      return {
        inputId: entry.id,
        status: decided.status,
        evidenceIds:
          decided.status === 'covered' ? decided.evidenceIds : decided.evidenceIds.slice(0, 0),
      }
    })
    const base = {
      summary: '根据当前来源与已发布成果作出的有界判断',
      citations: [...sources.map((entry) => entry.id), ...evidenceIds],
      coverage,
    }
    const proposal: RouterProposal =
      decision === 'dispatch'
        ? { ...base, decision, workKey, actionClass: ACTION }
        : decision === 'ignore'
          ? { ...base, decision, reason: 'already_covered' }
          : decision === 'wait'
            ? {
                ...base,
                decision,
                reason: 'upstream_pending',
                deadlineAt: new Date(Date.now() + 60_000).toISOString(),
              }
            : {
                ...base,
                decision: 'ask',
                questionType: 'choose_option',
                blockedDecision: 'dispatch',
                options: [{ id: 'review', label: '检查职责范围' }],
                recommendedOptionId: 'review',
              }
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

  async function application(evaluationId: string) {
    const [row] = await database.db
      .select()
      .from(schema.routerApplications)
      .where(eq(schema.routerApplications.evaluationId, evaluationId))
    return row
  }

  async function acceptEvaluation(
    node: Awaited<ReturnType<typeof onlineNode>>,
    decision: RouterProposal['decision'],
    source: string,
  ) {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId: source },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode, res.body).toBe(200)
    const evaluated = res.json().data as { id: string }
    await tick()
    const request = await waitForRequest(node, evaluated.id)
    await readAndStart(node, request)
    const submitted = result(request, decision, () => ({ status: 'uncovered', evidenceIds: [] }))
    expect((await submit(node, submitted)).status).toBe('accepted')
    return { evaluationId: evaluated.id, request }
  }

  async function publishEvidence(runId: string, token: string): Promise<string> {
    const content = Buffer.from(`接驳草案：${runId}\n`)
    const sha256 = createHash('sha256').update(content).digest('hex')
    const query = new URLSearchParams({
      title: '接驳草案',
      mediaType: 'text/plain',
      byteSize: String(content.byteLength),
      sha256,
      sourceRelativePath: 'drafts/rd03d3.md',
    })
    const upload = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/runs/${runId}/artifacts?${query.toString()}`,
      headers: {
        authorization: `Device ${token}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/octet-stream',
      },
      payload: content,
    })
    expect(upload.statusCode, upload.body).toBe(201)
    const artifactId = upload.json().data.id as string
    const publish = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(publish.statusCode, publish.body).toBe(200)
    return artifactId
  }

  async function completeRun(deviceId: string, runId: string) {
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `rd03d3-${runId}` }),
    )
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 2, { type: 'run.completed', finalText: '接驳草案已产出' }),
    )
  }

  async function boundaries() {
    return database.db.select().from(schema.workRunBoundaries)
  }

  async function routerEvaluations() {
    return database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.purpose, 'router'))
      .orderBy(schema.coordinationEvaluations.createdAt, schema.coordinationEvaluations.id)
  }

  /**
   * 创建第一台机器 Run，并停在 `queued`：调用方可以在 Run 活跃窗口内补输入，
   * 再显式驱动终态。这样新输入走入口的 wait 分支，而不是终态后的慢路径。
   */
  async function startFirstRun(
    node: Awaited<ReturnType<typeof onlineNode>>,
    agentId: string,
    options: { maxRunsPerWork?: number } = {},
  ): Promise<string> {
    await createMandate({
      autoDispatch: 'existing_task',
      allowedAgentIds: [agentId],
      maxRunsPerWork: options.maxRunsPerWork ?? 3,
    })
    const accepted = await acceptEvaluation(node, 'dispatch', sourceA)
    const applied = await waitForValue(async () => {
      const row = await application(accepted.evaluationId)
      return row?.runId === null ? undefined : row
    }, 'auto dispatch did not create the first machine run')
    return applied!.runId!
  }

  async function driveFirstRun(
    node: Awaited<ReturnType<typeof onlineNode>>,
    agentId: string,
    options: { maxRunsPerWork?: number } = {},
  ): Promise<string> {
    const runId = await startFirstRun(node, agentId, options)
    await completeRun(node.deviceId, runId)
    return runId
  }

  it('enqueues exactly one boundary review after a machine run terminal and dispatches the next Run only for a new uncovered input', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await startFirstRun(node, agent.agentId)

    // Run 活跃期间到达的新输入：走入口 wait 分支进入收件箱，终态复核必须看到它；
    // 旧输入仍不能因终态被重复派工。
    const secondSource = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        payload: { body: '补充：会场需要无障碍接驳，请一并核对。' },
      })
    ).json().data.id as string
    await completeRun(node.deviceId, runId)

    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({
      runId,
      status: 'pending',
      triggerKey: `run-terminal:${runId}`,
    })
    const [runBefore] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    const artifactId = await publishEvidence(runId, node.deviceToken)

    // 并发两次 tick：边界行锁保证只产生一份评估。
    await Promise.all([tick(), tick()])
    const evaluations = await routerEvaluations()
    const triggered = evaluations.filter(
      (row) =>
        (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
        `run-terminal:${runId}`,
    )
    expect(triggered).toHaveLength(1)
    const [enqueuedBoundary] = await boundaries()
    expect(enqueuedBoundary).toMatchObject({
      status: 'enqueued',
      evaluationId: triggered[0]!.id,
    })
    // 观测：只记不透明 id/代次与跳过原因，不记来源正文。
    const enqueuedLog = schedulerLogs.find((entry) => entry.action === 'work.run_boundary.enqueued')
    expect(enqueuedLog).toMatchObject({
      component: 'hub.dispatch',
      runId,
      workKey,
      evaluationId: triggered[0]!.id,
      triggerKey: `run-terminal:${runId}`,
    })
    expect(JSON.stringify(schedulerLogs)).not.toContain('无障碍接驳')

    const request = await waitForRequest(node, triggered[0]!.id)
    await readAndStart(node, request)
    expect(request.manifest.some((entry) => entry.kind === 'evidence')).toBe(true)
    const evidenceId = request.manifest.find((entry) => entry.kind === 'evidence')!.id
    const submitted = result(request, 'dispatch', (entry) =>
      entry.sourceId === `task_message:${sourceA}`
        ? { status: 'covered', evidenceIds: [evidenceId] }
        : { status: 'uncovered', evidenceIds: [] },
    )
    expect((await submit(node, submitted)).status).toBe('accepted')
    const applied = await waitForValue(async () => {
      const row = await application(triggered[0]!.id)
      return row?.runId === null ? undefined : row
    }, 'boundary decision did not dispatch the next run')

    const runs = await database.db.select().from(schema.runs).orderBy(schema.runs.id)
    expect(runs).toHaveLength(2)
    const firstRun = runs.find((row) => row.id === runId)
    const next = runs.find((row) => row.id !== runId)
    expect(next).toMatchObject({ origin: 'mandate', workKey })
    expect(applied!.runId).toBe(next!.id)
    expect(applied!).toMatchObject({ decision: 'dispatch', status: 'applied' })
    expect(artifactId).toBeTruthy()
    // 旧 Run 的输入快照不被改写；下一 Run 重新冻结输入，且只带它自己的触发条目。
    expect(firstRun?.workInputManifest).toEqual(runBefore?.workInputManifest)
    expect(firstRun?.workInputManifestDigest).toBe(runBefore?.workInputManifestDigest)
    expect(next?.workInputManifestDigest).not.toBeNull()
    const secondItem = (await database.db.select().from(schema.workInboxItems)).find(
      (item) => item.sourceId === secondSource,
    )
    expect(next?.workInputManifest?.entries.map((entry) => entry.inboxItemId)).toEqual([
      secondItem?.id,
    ])

    // 重复 tick 不再评估同一 Run，也不产生第三个 Run。
    await tick()
    expect(await routerEvaluations()).toHaveLength(2)
    expect(await database.db.select().from(schema.runs)).toHaveLength(2)
  })

  it('does not create a next Run when the boundary decision says the new input is already covered', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    await publishEvidence(runId, node.deviceToken)

    await tick()
    const triggered = (await routerEvaluations()).find(
      (row) =>
        (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
        `run-terminal:${runId}`,
    )
    expect(triggered).toBeDefined()
    const request = await waitForRequest(node, triggered!.id)
    await readAndStart(node, request)
    const evidenceId = request.manifest.find((entry) => entry.kind === 'evidence')!.id
    const submitted = result(request, 'ignore', () => ({
      status: 'covered',
      evidenceIds: [evidenceId],
    }))
    expect((await submit(node, submitted)).status).toBe('accepted')
    const applied = await waitForValue(
      async () => application(triggered!.id),
      'application missing',
    )
    expect(applied).toMatchObject({ decision: 'ignore', status: 'applied' })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(1)

    // 已覆盖的结论收口 work，重复 tick 不再产生评估。
    await tick()
    expect(await routerEvaluations()).toHaveLength(2)
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('leaves a boundary dispatch as a proposed intent when autoDispatch is off', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await startFirstRun(node, agent.agentId)
    const secondSource = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        payload: { body: '补充：接驳时间改为下午。' },
      })
    ).json().data.id as string
    await completeRun(node.deviceId, runId)
    await publishEvidence(runId, node.deviceToken)
    // 责任人把当前 Mandate 换成 off：边界复核仍可形成 proposed 意图，但不得自动派工。
    await createMandate({ autoDispatch: 'off', allowedAgentIds: [agent.agentId] })

    await tick()
    const triggered = (await routerEvaluations()).find(
      (row) =>
        (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
        `run-terminal:${runId}`,
    )
    expect(triggered).toBeDefined()
    const request = await waitForRequest(node, triggered!.id)
    await readAndStart(node, request)
    const evidenceId = request.manifest.find((entry) => entry.kind === 'evidence')!.id
    const submitted = result(request, 'dispatch', (entry) =>
      entry.sourceId === `task_message:${sourceA}`
        ? { status: 'covered', evidenceIds: [evidenceId] }
        : { status: 'uncovered', evidenceIds: [] },
    )
    expect((await submit(node, submitted)).status).toBe('accepted')
    const intents = await database.db
      .select()
      .from(schema.dispatchIntents)
      .orderBy(schema.dispatchIntents.createdAt)
    expect(intents.at(-1)).toMatchObject({ status: 'proposed', runId: null })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
    expect(secondSource).toBeTruthy()
  })

  it('skips the boundary review when the mandate is no longer active', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    const [mandate] = await database.db
      .select()
      .from(schema.workMandates)
      .where(eq(schema.workMandates.workKey, workKey))
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/mandates/${mandate!.id}/pause`,
          payload: { reason: 'boundary-test' },
          idempotencyKey: idemKey(),
        })
      ).statusCode,
    ).toBe(200)

    await tick()
    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({ runId, status: 'skipped', reason: 'mandate_inactive' })
    expect(
      schedulerLogs.find((entry) => entry.action === 'work.run_boundary.skipped'),
    ).toMatchObject({
      component: 'hub.dispatch',
      runId,
      workKey,
      reason: 'mandate_inactive',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('skips the boundary review when the task reaches a terminal state', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/tasks/${taskId}/cancel`,
          idempotencyKey: idemKey(),
        })
      ).statusCode,
    ).toBe(200)

    await tick()
    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({ runId, status: 'skipped' })
    expect(boundary?.reason).toBe('work_retired')
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('skips the boundary review when a terminal Task still has an active work', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    // removeWhen: 生产入口会在 Task 终态时退休 work；本夹具只构造「终态 Task +
    // 未退休 work」的防御窗口，验证边界复核仍会因 Task 终态 fail-closed。
    await database.db
      .update(schema.tasks)
      .set({ status: 'cancelled' })
      .where(eq(schema.tasks.id, taskId))

    await tick()
    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({ runId, status: 'skipped', reason: 'task_terminal' })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('skips the boundary review when the Router is disabled', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    const disabled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: { ...routerConfigPayload(node.deviceId), enabled: false },
      idempotencyKey: idemKey(),
    })
    expect(disabled.statusCode, disabled.body).toBe(200)

    await tick()
    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({ runId, status: 'skipped', reason: 'router_unavailable' })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('skips the boundary review while another Run is active', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    // removeWhen: Task 单活跃 Run 由生产入口保证；本夹具只构造并发窗口，让边界
    // 复核看到一条活跃 Run，验证它不会在已有执行时再派工。
    const chain = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    const first = chain[0]!
    expect(
      await insertRunRow(database.db, {
        taskId,
        ownerUserId: alice.userId,
        agentId: agent.agentId,
        profileRevisionId: first.profileRevisionId,
        deviceId: first.deviceId,
        workspaceId: first.workspaceId,
        status: 'running',
      }),
    ).toBeTruthy()

    await tick()
    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({ runId, status: 'skipped', reason: 'active_run' })
    expect(await database.db.select().from(schema.runs)).toHaveLength(2)
  })

  it('skips the boundary review when a reassignment has not been accepted', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await driveFirstRun(node, agent.agentId)
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/tasks/${taskId}/reassign`,
          payload: { assigneeUserId: bob.userId },
          idempotencyKey: idemKey(),
        })
      ).statusCode,
    ).toBe(200)

    await tick()
    const [boundary] = await boundaries()
    expect(boundary).toMatchObject({
      runId,
      status: 'skipped',
      reason: 'assignment_not_accepted',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('closes an expired router wait and re-evaluates it exactly once', async () => {
    const agent = await createAgent()
    await createMandate({ allowedAgentIds: [agent.agentId], autoDispatch: 'off' })
    const node = await onlineNode({ workspace: true })
    await acceptEvaluation(node, 'wait', sourceA)
    const [wait] = await database.db.select().from(schema.workWaits)
    expect(wait).toMatchObject({ status: 'open' })
    const [waitingWork] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(waitingWork).toMatchObject({
      state: 'waiting',
      resumeCondition: `router:${wait!.evaluationId}`,
    })
    // 时间前进用夹具改 deadline；到期本身由生产扫描判定。
    await database.db
      .update(schema.workWaits)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(schema.workWaits.id, wait!.id))

    await tick()
    const [closed] = await database.db.select().from(schema.workWaits)
    expect(closed).toMatchObject({ status: 'expired' })
    const [activeWork] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(activeWork).toMatchObject({ state: 'active', resumeMode: null, resumeCondition: null })
    const triggered = (await routerEvaluations()).filter(
      (row) =>
        (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
        `wait-expiry:${wait!.id}:1`,
    )
    expect(triggered).toHaveLength(1)

    // 重复扫描：wait 已不是 open，不会产生第二份到期评估。
    await tick()
    expect(
      (await routerEvaluations()).filter(
        (row) =>
          (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
          `wait-expiry:${wait!.id}:1`,
      ),
    ).toHaveLength(1)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('turns an unresolved expired wait into one question instead of a Run', async () => {
    const agent = await createAgent()
    await createMandate({ allowedAgentIds: [agent.agentId], autoDispatch: 'off' })
    const node = await onlineNode({ workspace: true })
    await acceptEvaluation(node, 'wait', sourceA)
    const [wait] = await database.db.select().from(schema.workWaits)
    await database.db
      .update(schema.workWaits)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(schema.workWaits.id, wait!.id))

    await tick()
    const triggered = (await routerEvaluations()).find(
      (row) =>
        (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
        `wait-expiry:${wait!.id}:1`,
    )
    expect(triggered).toBeDefined()
    const request = await waitForRequest(node, triggered!.id)
    await readAndStart(node, request)
    const submitted = result(request, 'ask', () => ({ status: 'uncovered', evidenceIds: [] }))
    expect((await submit(node, submitted)).status).toBe('accepted')
    const [question] = await database.db.select().from(schema.workQuestions)
    expect(question).toMatchObject({ status: 'open', principalUserId: alice.userId })
    expect(question?.decisionId).toMatch(/^[a-f0-9]{64}$/)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)

    // 重复 tick 不产生第二个问题或第二份评估。
    await tick()
    expect(await database.db.select().from(schema.workQuestions)).toHaveLength(1)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('does not touch a wait whose deadline has not arrived', async () => {
    const agent = await createAgent()
    await createMandate({ allowedAgentIds: [agent.agentId], autoDispatch: 'off' })
    const node = await onlineNode({ workspace: true })
    await acceptEvaluation(node, 'wait', sourceA)
    const [wait] = await database.db.select().from(schema.workWaits)
    const before = (await routerEvaluations()).length

    await tick()
    const [stillOpen] = await database.db.select().from(schema.workWaits)
    expect(stillOpen).toMatchObject({ status: 'open' })
    expect(await routerEvaluations()).toHaveLength(before)
    const [work] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(work).toMatchObject({
      state: 'waiting',
      resumeCondition: `router:${wait!.evaluationId}`,
    })
  })

  it('keeps an expired wait until the active Run ends', async () => {
    const agent = await createAgent()
    await createMandate({ allowedAgentIds: [agent.agentId], autoDispatch: 'off' })
    const node = await onlineNode({ workspace: true })
    await acceptEvaluation(node, 'wait', sourceA)
    const [wait] = await database.db.select().from(schema.workWaits)
    await database.db
      .update(schema.workWaits)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(schema.workWaits.id, wait!.id))
    // removeWhen: Task 单活跃 Run 由生产入口保证；本夹具只构造「到期 wait 与活跃
    // Run 同时存在」的窗口，验证到期扫描不会越过执行边界提前生产问题。
    const activeRunId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: agent.agentId,
      profileRevisionId: agent.revisionId,
      deviceId: node.deviceId,
      workspaceId: node.workspaceId!,
      status: 'running',
    })
    const before = (await routerEvaluations()).length

    await tick()
    const [stillOpen] = await database.db.select().from(schema.workWaits)
    expect(stillOpen).toMatchObject({ status: 'open' })
    expect(await routerEvaluations()).toHaveLength(before)

    await database.transaction((tx) =>
      applyRunStatus(tx, new Outbox(database), activeRunId, 'completed'),
    )
    await tick()
    const [expired] = await database.db.select().from(schema.workWaits)
    expect(expired).toMatchObject({ status: 'expired' })
    expect(await routerEvaluations()).toHaveLength(before + 1)
  })

  it('supersedes an open wait when a newer evaluation applies an ask', async () => {
    const agent = await createAgent()
    await createMandate({ allowedAgentIds: [agent.agentId], autoDispatch: 'off' })
    const node = await onlineNode({ workspace: true })
    await acceptEvaluation(node, 'wait', sourceA)
    const [wait] = await database.db.select().from(schema.workWaits)
    expect(wait).toMatchObject({ status: 'open' })

    // 新输入显式重评：ask 是新的有界结论，旧 wait 的恢复条件必须收口。
    const secondSource = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        payload: { body: '补充：客户改约到下午，需要重新判断。' },
      })
    ).json().data.id as string
    const evaluated = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId: secondSource },
      idempotencyKey: idemKey(),
    })
    expect(evaluated.statusCode, evaluated.body).toBe(200)
    await tick()
    const request = await waitForRequest(node, evaluated.json().data.id as string)
    await readAndStart(node, request)
    const submitted = result(request, 'ask', () => ({ status: 'uncovered', evidenceIds: [] }))
    expect((await submit(node, submitted)).status).toBe('accepted')

    const [closed] = await database.db.select().from(schema.workWaits)
    expect(closed).toMatchObject({ status: 'superseded' })
    const [work] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(work).toMatchObject({ state: 'active', resumeMode: null, resumeCondition: null })

    // 旧 wait 已收口：即使 deadline 过去，重复 tick 也不会再触发到期评估。
    await database.db
      .update(schema.workWaits)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(schema.workWaits.id, wait!.id))
    const before = (await routerEvaluations()).length
    await tick()
    expect(await routerEvaluations()).toHaveLength(before)
  })

  it('refuses to apply an older decision after a newer wait replaces the open wait', async () => {
    const agent = await createAgent()
    await createMandate({ allowedAgentIds: [agent.agentId], autoDispatch: 'off' })
    const node = await onlineNode({ workspace: true })

    // W1：先形成一次 wait，work 进入 waiting(auto, router:E0)。
    await acceptEvaluation(node, 'wait', sourceA)
    const [w1] = await database.db.select().from(schema.workWaits)
    expect(w1).toMatchObject({ status: 'open' })

    // 等待期间到达的新输入 B 先入箱；E1 的 manifest 同时包含 A（触发）与 B（pending）。
    const sourceB = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        payload: { body: '补充：客户要求下午到场。' },
      })
    ).json().data.id as string
    const e1 = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId: sourceA },
      idempotencyKey: idemKey(),
    })
    expect(e1.statusCode, e1.body).toBe(200)
    const e1id = e1.json().data.id as string
    await tick()
    await waitForRequest(node, e1id)

    // removeWhen: 模拟「结果已接受、应用提交前进程崩溃」的窗口：E1 已 queued→
    // dispatched 且预算已预留，这里直接写 completed，避免它长期 running 阻塞 E2。
    const [e1row] = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.id, e1id))
    const entries =
      (e1row?.inputManifest as { entries?: Array<{ id: string; kind: string; sourceId: string }> })
        ?.entries ?? []
    const sourceEntry = entries.find(
      (entry) => entry.kind === 'source' && entry.sourceId === `task_message:${sourceA}`,
    )
    expect(sourceEntry).toBeDefined()
    const proposal: RouterProposal = {
      decision: 'ignore',
      reason: 'already_covered',
      summary: '旧结论',
      citations: [sourceEntry!.id],
      coverage: [{ inputId: sourceEntry!.id, status: 'uncovered', evidenceIds: [] }],
    }
    await database.db
      .update(schema.coordinationEvaluations)
      .set({
        status: 'completed',
        routerProposal: proposal,
        resultDigest: sha256Hex(canonicalJson(proposal)),
        readEntryIds: entries.map((entry) => entry.id),
        modelStartedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(schema.coordinationEvaluations.id, e1id))
    // removeWhen: 占位应用行让 tick 的「未应用补做」不再碰 E1；模拟应用提交前崩溃。
    await database.db.insert(schema.routerApplications).values({
      evaluationId: e1id,
      projectId: e1row!.projectId,
      workId: e1row!.workId!,
      taskId: e1row!.taskId!,
      workKey: e1row!.workKey!,
      decision: 'ignore',
      status: 'stale',
      reason: 'simulated_deferred',
      evaluationDigest: e1row!.evaluationDigest!,
      mandateId: e1row!.mandateId!,
      mandateVersion: e1row!.mandateVersion!,
      refs: {},
      appliedAt: new Date(),
    })

    // E2：显式评估 B 并落 wait；W1 被 W2 替换，work 仍是 waiting(auto)。
    const e2 = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId: sourceB },
      idempotencyKey: idemKey(),
    })
    expect(e2.statusCode, e2.body).toBe(200)
    await tick()
    const e2request = await waitForRequest(node, e2.json().data.id as string)
    await readAndStart(node, e2request)
    expect(
      (
        await submit(
          node,
          result(e2request, 'wait', () => ({ status: 'uncovered', evidenceIds: [] })),
        )
      ).status,
    ).toBe('accepted')
    const w2 = (await database.db.select().from(schema.workWaits)).find(
      (row) => row.status === 'open',
    )
    expect(w2).toBeDefined()
    expect(w2?.id).not.toBe(w1?.id)

    // 旧结果重建 digest 只看到 waitEvaluationId 变化（workState 仍是 waiting），
    // 必须在应用层被拒绝，不能关闭新 wait。先移除占位行，模拟崩溃窗口后的补做。
    await database.db
      .delete(schema.routerApplications)
      .where(eq(schema.routerApplications.evaluationId, e1id))
    const reapplied = await applyRouterEvaluation({ database }, e1id)
    expect(reapplied).toMatchObject({ status: 'stale', reason: 'input_or_authority_changed' })
    const stillOpen = (await database.db.select().from(schema.workWaits)).find(
      (row) => row.status === 'open',
    )
    expect(stillOpen).toMatchObject({ status: 'open', evaluationId: w2!.evaluationId })
    const [work] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, workKey))
    expect(work).toMatchObject({ state: 'waiting', resumeCondition: `router:${w2!.evaluationId}` })
    expect(await database.db.select().from(schema.workQuestions)).toHaveLength(0)
  })

  it('does not create a next Run when the lifetime run budget is exhausted', async () => {
    const agent = await createAgent()
    const node = await onlineNode({ workspace: true })
    const runId = await startFirstRun(node, agent.agentId, { maxRunsPerWork: 1 })
    const secondSource = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        payload: { body: '补充：还需要核对接驳时间。' },
      })
    ).json().data.id as string
    await completeRun(node.deviceId, runId)
    await publishEvidence(runId, node.deviceToken)

    await tick()
    const triggered = (await routerEvaluations()).find(
      (row) =>
        (row.routerContext as { triggerKey?: string } | null)?.triggerKey ===
        `run-terminal:${runId}`,
    )
    expect(triggered).toBeDefined()
    const request = await waitForRequest(node, triggered!.id)
    await readAndStart(node, request)
    const evidenceId = request.manifest.find((entry) => entry.kind === 'evidence')!.id
    const submitted = result(request, 'dispatch', (entry) =>
      entry.sourceId === `task_message:${sourceA}`
        ? { status: 'covered', evidenceIds: [evidenceId] }
        : { status: 'uncovered', evidenceIds: [] },
    )
    await submit(node, submitted)
    const intents = await database.db
      .select()
      .from(schema.dispatchIntents)
      .orderBy(schema.dispatchIntents.createdAt)
    expect(intents.at(-1)).toMatchObject({
      status: 'rejected',
      resolutionReason: 'max_runs_exhausted',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
    expect(secondSource).toBeTruthy()
  })

  it('does not schedule a boundary for a human Run terminal', async () => {
    const chain = await seedRunChainForUser(database.db, alice.userId)
    const agent = await createAgent()
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: agent.agentId,
      profileRevisionId: agent.revisionId,
      deviceId: chain.deviceId,
      workspaceId: chain.workspaceId,
      status: 'running',
    })
    await database.transaction((tx) => applyRunStatus(tx, new Outbox(database), runId, 'completed'))
    expect(await boundaries()).toHaveLength(0)
  })
})
