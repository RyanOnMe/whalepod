import { randomUUID } from 'node:crypto'
import { getEvaluation, type Database } from '@whalepod/db'
import { parseNodeFrame, type NodeDownstream } from '@whalepod/protocol'
import WebSocket from 'ws'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
import { runDiscoveryTick } from '../src/modules/discovery/service.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

const membershipRead = vi.hoisted(() => ({
  afterRead: undefined as ((userId: string) => Promise<void>) | undefined,
}))
vi.mock('@whalepod/db', async (importOriginal) => {
  const db = await importOriginal<typeof import('@whalepod/db')>()
  return {
    ...db,
    async getEnabledMember(...args: Parameters<typeof db.getEnabledMember>) {
      const member = await db.getEnabledMember(...args)
      if (member) await membershipRead.afterRead?.(args[2])
      return member
    },
  }
})
describe('RD-04a shadow discovery from ordinary comments', () => {
  let database: Database
  let ctx: TestApp
  let owner: Session
  let member: Session
  let projectId: string
  let taskId: string
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    owner = await driveSetup(ctx, 'owner')
    member = (
      await driveInviteAndAccept(ctx, owner, {
        username: 'member',
        displayName: 'Member',
        password: 'member-test-password',
      })
    ).session
    const project = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: '活动筹备' },
    })
    expect(project.statusCode).toBe(201)
    projectId = project.json().data.id
    const task = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '筹备讨论', assigneeUserId: owner.userId },
    })
    expect(task.statusCode).toBe(201)
    taskId = task.json().data.id
  })
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await ctx.close()
  })
  afterAll(async () => database.close())

  it('records the closed route for an ordinary comment and never creates a candidate', async () => {
    const key = randomUUID()
    const comment = () =>
      apiInject(ctx, member, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/comments`,
        idempotencyKey: key,
        payload: { body: '今天到现场，接驳点没有无障碍坡道。' },
      })
    const [a, b] = await Promise.all([comment(), comment()])
    expect(a.statusCode, a.body).toBe(201)
    expect(b.statusCode, b.body).toBe(201)
    const sourceId = a.json().data.id as string
    expect(b.json().data.id).toBe(sourceId)
    const rows = await database.sql`
      select route, reason from discovery_admission where source_id = ${sourceId}
    `
    expect(rows).toEqual([{ route: 'closed', reason: 'discovery_disabled' }])
    const candidates = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/discovery/candidates`,
    })
    expect(candidates.statusCode).toBe(404)
    expect(candidates.headers['cache-control']).toBe('private, no-store')
    const evals = await database.sql`
      select id from coordination_evaluation where project_id = ${projectId}
        and purpose = 'discovery'
    `
    expect(evals).toHaveLength(0)
  })
  async function ordinaryComment() {
    const response = await apiInject(ctx, member, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '现场缺少通往接驳点的无障碍坡道。' },
    })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().data.id as string
  }

  async function setupPilot(
    supportDiscovery = true,
    fixture?: { workspaceId: string; agreementTaskIds: string[] },
  ) {
    const code = await apiInject(ctx, owner, {
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
        name: `discovery-test-${sockets.length + 1}`,
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode, claim.body).toBe(201)
    const { deviceId, deviceToken } = claim.json().data as { deviceId: string; deviceToken: string }
    if (!ctx.app.server.listening) await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const addr = ctx.app.server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing listen address')
    const client = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/v1/node`, {
      headers: { authorization: `Device ${deviceToken}` },
    })
    sockets.push(client)
    const messages: NodeDownstream[] = []
    client.on('message', (raw) =>
      messages.push(parseNodeFrame(JSON.parse(String(raw)), 'downstream')),
    )
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    const send = (type: string, payload: unknown) =>
      client.send(
        JSON.stringify({
          type,
          payload,
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
        }),
      )
    send('node.hello', {
      deviceId,
      nodeVersion: '24.12.0',
      platform: 'darwin',
      architecture: 'arm64',
      supportedProtocolVersions: [1],
      dshDistributionVersion: '0.1.0-rc.8',
      pluginPackDigests: [],
      ...(fixture ? { contextCapabilities: ['project-context.v1', 'context-state.v1'] } : {}),
      coordinationCapabilities: supportDiscovery
        ? ['coordination.v1', 'discovery.v1']
        : ['coordination.v1'],
    })
    const credentials = {
      scope: 'coordination',
      provider: 'replay',
      model: 'discovery-test',
      slot: 'acceptance',
      ownerUserId: owner.userId,
      billingUserId: owner.userId,
      configRevision: 'test.v1',
    }
    send('node.inventory', {
      deviceId,
      credentialSlots: [],
      workspaces: fixture
        ? [
            {
              workspaceId: fixture.workspaceId,
              name: 'discovery-coverage',
              kind: 'directory',
              capabilities: { read: true, write: true, git: false },
              available: true,
              lastCheckedAt: new Date().toISOString(),
            },
          ]
        : [],
      coordinationCredentialSlots: [credentials],
    })
    await waitForValue(async () => {
      const rows = await database.sql`select capabilities from device where id = ${deviceId}`
      return rows[0]?.capabilities?.coordinationCredentialSlots?.length === 1 ? true : undefined
    }, 'device coordination inventory missing')
    const configure = async (model = credentials.model) => {
      const response = await apiInject(ctx, owner, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/router/config`,
        payload: {
          enabled: true,
          deviceId,
          operatorUserId: owner.userId,
          billingUserId: owner.userId,
          credentialSlot: credentials.slot,
          credentialConfigRevision: credentials.configRevision,
          provider: credentials.provider,
          model,
          teamDailyCallLimit: 10,
          teamDailyTokenLimit: 200_000,
          teamDailyCostMicrosLimit: 1000,
          projectDailyCallLimit: 10,
          projectDailyTokenLimit: 200_000,
          projectDailyCostMicrosLimit: 1000,
          maxInputTokens: 32_000,
          maxOutputTokens: 512,
          maxCostMicros: 100,
          inputPriceMicrosPerMillionTokens: 1,
          outputPriceMicrosPerMillionTokens: 1,
          timeoutSeconds: 30,
          maxRetries: 0,
        },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    await configure()
    const route = `/api/v1/projects/${projectId}/discovery`
    const settings = {
      enabled: true,
      entryTaskId: taskId,
      principalUserId: owner.userId,
      activity: '活动',
      slot: '接驳草稿',
      templateVersion: 'v1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      maxCalls: 1,
      maxTokens: 100_000,
      maxCostMicros: 100,
      ...(fixture ? { agreementTaskIds: fixture.agreementTaskIds } : {}),
    }
    const cfg = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${route}/config`,
      payload: settings,
    })
    expect(cfg.statusCode, cfg.body).toBe(200)
    const { configVersion } = cfg.json().data as { configVersion: number }
    const forbidden = await apiInject(ctx, member, {
      method: 'POST',
      url: `${route}/permit`,
      payload: { configVersion },
    })
    expect(forbidden.statusCode).toBe(404)
    const permit = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${route}/permit`,
      payload: { configVersion },
    })
    expect(permit.statusCode, permit.body).toBe(200)
    const participation = await apiInject(ctx, member, {
      method: 'POST',
      url: `${route}/participation`,
      payload: { configVersion },
    })
    expect(participation.statusCode, participation.body).toBe(200)
    return { send, messages, deviceId, deviceToken, configure, route, settings }
  }

  async function getRequest(node: Awaited<ReturnType<typeof setupPilot>>) {
    await runDiscoveryTick({ database })
    const message = await waitForValue(
      async () => node.messages.find((message) => message.type === 'discovery.request'),
      'no discovery dispatch',
    )
    return message.payload
  }

  it('marks coverage incomplete when a published outcome is outside the selected evidence', async () => {
    const post = async (path: string, payload: object, status = 200) => {
      const result = await apiInject(ctx, owner, { method: 'POST', url: `/api/v1${path}`, payload })
      expect(result.statusCode, result.body).toBe(status)
      return result.json().data
    }
    const venue = await post(
      `/projects/${projectId}/tasks`,
      { title: '场地座席', assigneeUserId: owner.userId },
      201,
    )
    await post(`/tasks/${venue.id}/accept`, {})
    const draft = await post(`/tasks/${venue.id}/agreement/draft`, {
      content: {
        goal: '安排无障碍座席',
        constraints: '',
        acceptance: '完成场地图',
        openQuestions: '',
      },
    })
    await post(`/tasks/${venue.id}/agreement/confirm`, { draftVersion: draft.draftVersion })
    const packs = await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/plugin-packs' })
    const pack = packs.json().data.find((p: { name: string }) => p.name === 'core-empty')
    expect(pack).toBeDefined()
    const agent = await post(
      '/agents',
      {
        name: 'coverage-agent',
        persona: 'Arrange event access.',
        provider: 'fixture',
        model: 'fixture',
        credentialSlot: 'default',
        pluginPackId: pack.id,
      },
      201,
    )
    const workspaceId = randomUUID()
    const node = await setupPilot(true, { workspaceId, agreementTaskIds: [venue.id] })
    const run = await post(
      `/tasks/${venue.id}/runs`,
      { agentId: agent.id, deviceId: node.deviceId, workspaceId, prompt: 'Compile access plans.' },
      201,
    )
    const evidence = '已安排无障碍接驳备选方案。'
    const bytes = Buffer.from(evidence)
    const query = new URLSearchParams({
      title: '接驳方案',
      mediaType: 'text/plain',
      byteSize: String(bytes.length),
      sha256: sha256Hex(evidence),
      sourceRelativePath: 'shuttle.txt',
    })
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/runs/${run.id}/artifacts?${query}`,
      headers: {
        authorization: `Device ${node.deviceToken}`,
        'content-type': 'application/octet-stream',
        'idempotency-key': randomUUID(),
      },
      payload: bytes,
    })
    expect(uploaded.statusCode, uploaded.body).toBe(201)
    const artifactId = uploaded.json().data.id as string
    await post(`/artifacts/${artifactId}/publish`, {})
    await ordinaryComment()
    const request = await getRequest(node)
    expect(request.manifest.map((entry) => entry.kind)).toEqual([
      'source',
      'slot',
      'agreement',
      'work',
    ])
    expect(request.coverageComplete).toBe(false)
    const evaluation = await getEvaluation(database.db, request.evaluationId)
    expect(evaluation?.inputManifest['omissions']).toEqual(['published_evidence_unselected'])
    expect(JSON.stringify(request)).not.toContain(artifactId)

    for (const entry of request.manifest) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/discovery/evaluations/${request.evaluationId}/inputs/${entry.id}`,
        headers: {
          authorization: `Device ${node.deviceToken}`,
          'x-coordination-attempt': String(request.attempt),
          'x-coordination-lease': request.leaseToken,
        },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const result = resultFor(request)
    const { purpose, evaluationId, attempt, leaseToken, readEntryIds } = result
    node.send('discovery.heartbeat', {
      purpose,
      evaluationId,
      attempt,
      leaseToken,
      readEntryIds,
      modelStartedAt: new Date().toISOString(),
    })
    await waitForValue(
      async () => node.messages.find((message) => message.type === 'discovery.model_start_ack'),
      'no authenticated start ack',
    )
    const proposal = {
      ...result.proposal,
      classification: 'independent_gap',
      slot: request.manifest.find((entry) => entry.kind === 'slot')!.id,
      citations: request.manifest
        .filter((entry) => entry.kind === 'agreement' || entry.kind === 'work')
        .map((entry) => entry.id),
      reason: '现有场地座席工作未涵盖接驳方案。',
    }
    node.send('discovery.result', {
      ...result,
      proposal,
      resultDigest: sha256Hex(canonicalJson(proposal)),
      usage: {
        provider: request.provider,
        model: request.model,
        inputTokens: 100,
        outputTokens: 10,
        costMicros: 1,
      },
    })
    const ack = await waitForValue(
      async () => node.messages.find((message) => message.type === 'discovery.result_ack'),
      'no discovery result ack',
    )
    expect(ack.payload.status).toBe('rejected')
    expect((await getEvaluation(database.db, evaluationId))?.failureCode).toBe('invalid_citation')
    expect(await database.sql`select id from discovery_candidate`).toHaveLength(0)
  })

  it('does not let another admin authorize the operator or billing owner for discovery', async () => {
    const node = await setupPilot()
    const { session: admin } = await driveInviteAndAccept(
      ctx,
      owner,
      {
        username: 'discovery-admin',
        displayName: 'Discovery Admin',
        password: 'test-admin-password',
      },
      'admin',
    )
    const reconfigure = await apiInject(ctx, admin, {
      method: 'POST',
      url: `${node.route}/config`,
      payload: { ...node.settings, principalUserId: admin.userId },
    })
    expect(reconfigure.statusCode, reconfigure.body).toBe(403)
    await ordinaryComment()
    expect((await getRequest(node)).principalUserId).toBe(owner.userId)
  })

  it('keeps discovery moving in an online project behind a full offline-project batch', async () => {
    await setupPilot(false)
    const legacyProject = projectId
    for (let index = 0; index < 20; index++) await ordinaryComment()

    const project = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: '另一项目' },
    })
    expect(project.statusCode, project.body).toBe(201)
    projectId = project.json().data.id
    const task = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '另一项目的筹备讨论', assigneeUserId: owner.userId },
    })
    expect(task.statusCode, task.body).toBe(201)
    taskId = task.json().data.id
    const online = await setupPilot()
    await ordinaryComment()
    const request = await getRequest(online)
    expect(request.projectId).toBe(projectId)
    const [pending] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from discovery_admission
      where project_id = ${legacyProject} and processed_at is null
    `
    expect(pending?.count).toBe(20)
  })

  function resultFor(request: Awaited<ReturnType<typeof getRequest>>) {
    const source = request.manifest.find((entry) => entry.kind === 'source')
    if (!source) throw new Error('source missing')
    const proposal = {
      classification: 'insufficient',
      source: source.id,
      slot: null,
      citations: [],
      reason: '缺少可独立复核的佐证',
    }
    return {
      purpose: request.purpose,
      evaluationId: request.evaluationId,
      attempt: request.attempt,
      leaseToken: request.leaseToken,
      evaluationDigest: request.evaluationDigest,
      status: 'completed',
      resultDigest: sha256Hex(canonicalJson(proposal)),
      proposal,
      readEntryIds: request.manifest.map((entry) => entry.id),
    }
  }

  it('never stores or logs a device supplied discovery failure string', async () => {
    const node = await setupPilot()
    await ordinaryComment()
    const request = await getRequest(node)
    const log = vi.spyOn(ctx.app.log, 'info')
    const privateMarker = 'private_material_marker_04a'
    try {
      node.send('discovery.result', {
        purpose: request.purpose,
        evaluationId: request.evaluationId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
        evaluationDigest: request.evaluationDigest,
        status: 'failed',
        failureCode: privateMarker,
        readEntryIds: [],
      })
      await waitForValue(
        async () => node.messages.find((message) => message.type === 'discovery.result_ack'),
        'no discovery result ack',
      )
      const row = await getEvaluation(database.db, request.evaluationId)
      expect(row?.failureCode).toBe('invalid_result')
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'hub.discovery', reason: 'invalid_result' }),
        'discovery event',
      )
      expect(JSON.stringify(log.mock.calls).includes(privateMarker)).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  it('does not give a discovery lease to a legacy node and does not carry permission across a model change', async () => {
    const node = await setupPilot(false)
    const waiting = await ordinaryComment()
    await runDiscoveryTick({ database })
    const [unclaimed] = await database.sql`
      select evaluation_id from discovery_admission where source_id = ${waiting}
    `
    expect(unclaimed?.evaluation_id).toBeNull()
    expect(node.messages.some((message) => message.type === 'discovery.request')).toBe(false)
    await node.configure('unapproved-replacement')
    const source = await ordinaryComment()
    await runDiscoveryTick({ database })
    const [rejected] = await database.sql`
      select route, reason from discovery_admission where source_id = ${source}
    `
    expect(rejected).toEqual({ route: 'rejected', reason: 'coordination_config_changed' })
    expect(await database.sql`select id from coordination_usage_ledger`).toHaveLength(0)
  })

  it.each([false, true])(
    'rejects model start and a late result with no eligible source (download first: %s)',
    async (downloadFirst) => {
      const node = await setupPilot()
      const sourceId = await ordinaryComment()
      const request = await getRequest(node)
      const result = resultFor(request)
      const download = (entryId: string) =>
        ctx.app.inject({
          method: 'GET',
          url: `/api/v1/discovery/evaluations/${request.evaluationId}/inputs/${entryId}`,
          headers: {
            authorization: `Device ${node.deviceToken}`,
            'x-coordination-attempt': String(request.attempt),
            'x-coordination-lease': request.leaseToken,
          },
        })
      if (downloadFirst) {
        for (const entry of request.manifest)
          expect((await download(entry.id)).statusCode).toBe(200)
        const revoke = await apiInject(ctx, member, {
          method: 'POST',
          url: `${node.route}/sources/${sourceId}/withdraw`,
          payload: {},
        })
        expect(revoke.statusCode, revoke.body).toBe(200)
        expect((await download(request.manifest[0]!.id)).statusCode).toBe(404)
      }
      const receipt = {
        evaluationId: request.evaluationId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
        readEntryIds: result.readEntryIds,
        modelStartedAt: new Date().toISOString(),
      }
      node.send('coordination.heartbeat', receipt)
      node.send('discovery.heartbeat', { ...receipt, purpose: 'discovery' })
      node.send('discovery.result', result)
      const ack = await waitForValue(
        async () => node.messages.find((message) => message.type === 'discovery.result_ack'),
        'no discovery result ack',
      )
      expect(ack.payload.status).toBe('rejected')
      expect(node.messages.some((message) => message.type === 'discovery.model_start_ack')).toBe(
        false,
      )
      const row = await getEvaluation(database.db, request.evaluationId)
      expect(row?.modelStartedAt).toBeNull()
      expect(row?.readEntryIds).toEqual([])
      expect(row?.discoveryDownloadedIds).toEqual(downloadFirst ? result.readEntryIds : [])
      expect(row?.failureCode).toBe(
        downloadFirst ? 'input_or_authority_changed' : 'read_receipt_missing',
      )
      expect(await database.sql`select id from discovery_candidate`).toHaveLength(0)
      expect(
        await database.sql`select phase, charge_mode from coordination_usage_ledger order by phase`,
      ).toEqual([
        { phase: 'reserved', charge_mode: null },
        { phase: 'settled', charge_mode: 'reserved' },
      ])
    },
  )
  it('rejects model start if the source author is disabled during the authorization rebuild', async () => {
    const node = await setupPilot()
    await ordinaryComment()
    const request = await getRequest(node)
    for (const entry of request.manifest) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/discovery/evaluations/${request.evaluationId}/inputs/${entry.id}`,
        headers: {
          authorization: `Device ${node.deviceToken}`,
          'x-coordination-attempt': String(request.attempt),
          'x-coordination-lease': request.leaseToken,
        },
      })
      expect(response.statusCode, response.body).toBe(200)
    }

    // Pause after a real database read has returned the enabled author. Only timing is injected.
    let readAuthor = false
    const barrier = Promise.withResolvers<void>()
    membershipRead.afterRead = async (userId) => {
      if (userId !== member.userId) return
      membershipRead.afterRead = undefined
      readAuthor = true
      await barrier.promise
    }
    const result = resultFor(request)
    const { purpose, evaluationId, attempt, leaseToken, readEntryIds } = result
    try {
      node.send('discovery.heartbeat', {
        purpose,
        evaluationId,
        attempt,
        leaseToken,
        readEntryIds,
        modelStartedAt: new Date().toISOString(),
      })
      await waitForValue(async () => (readAuthor ? true : undefined), 'author read did not pause')
      const disable = await apiInject(ctx, owner, {
        method: 'POST',
        url: `/api/v1/team/members/${member.userId}/disable`,
        payload: {},
      })
      expect(disable.statusCode, disable.body).toBe(200)
    } finally {
      membershipRead.afterRead = undefined
      barrier.resolve()
    }

    // The same socket processes the result after the pending heartbeat, without a timing guess.
    node.send('discovery.result', result)
    const ack = await waitForValue(
      async () => node.messages.find((message) => message.type === 'discovery.result_ack'),
      'no discovery result ack',
    )
    expect(ack.payload.status).toBe('rejected')
    expect(node.messages.some((message) => message.type === 'discovery.model_start_ack')).toBe(
      false,
    )
    const row = await getEvaluation(database.db, evaluationId)
    expect(row?.modelStartedAt).toBeNull()
    expect(row?.failureCode).toBe('input_or_authority_changed')
  })

  it('grants model start once, settles one accepted attempt once, and hides withdrawn candidates', async () => {
    const node = await setupPilot()
    const sourceId = await ordinaryComment()
    const request = await getRequest(node)
    for (const entry of request.manifest) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/discovery/evaluations/${request.evaluationId}/inputs/${entry.id}`,
        headers: {
          authorization: `Device ${node.deviceToken}`,
          'x-coordination-attempt': String(request.attempt),
          'x-coordination-lease': request.leaseToken,
        },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const result = resultFor(request)
    const { purpose, evaluationId, attempt, leaseToken, readEntryIds } = result
    const start = {
      purpose,
      evaluationId,
      attempt,
      leaseToken,
      readEntryIds,
      modelStartedAt: new Date().toISOString(),
    }
    node.send('discovery.heartbeat', start)
    await waitForValue(
      async () => node.messages.find((message) => message.type === 'discovery.model_start_ack'),
      'no authenticated start ack',
    )
    node.send('discovery.heartbeat', start)
    const accepted = {
      ...result,
      usage: {
        provider: request.provider,
        model: request.model,
        inputTokens: 100,
        outputTokens: 10,
        costMicros: 1,
      },
    }
    node.send('discovery.result', accepted)
    node.send('discovery.result', accepted)
    const acks = await waitForValue(async () => {
      const found = node.messages.filter((message) => message.type === 'discovery.result_ack')
      return found.length === 2 ? found : undefined
    }, 'missing both result acknowledgements')
    expect(acks.map(({ payload }) => payload.status)).toEqual(['accepted', 'duplicate'])
    expect(
      node.messages.filter((message) => message.type === 'discovery.model_start_ack'),
    ).toHaveLength(1)
    const list = (actor: Session) =>
      apiInject(ctx, actor, {
        method: 'GET',
        url: `${node.route}/candidates`,
      })
    expect((await list(owner)).json().data).toMatchObject([
      { sourceId, classification: 'insufficient', reason: result.proposal.reason },
    ])
    expect((await list(member)).statusCode).toBe(404)

    const blockedSource = await ordinaryComment()
    await runDiscoveryTick({ database })
    const skipped = await database.sql`
      select status, failure_code from coordination_evaluation where discovery_source_id = ${blockedSource}
    `
    expect(skipped).toEqual([{ status: 'skipped', failure_code: 'budget_exhausted' }])
    expect(
      await database.sql`
      select phase, charge_mode, work_key from coordination_usage_ledger order by phase
    `,
    ).toEqual([
      { phase: 'reserved', charge_mode: null, work_key: null },
      { phase: 'settled', charge_mode: 'actual', work_key: null },
    ])
    const withdrawal = await apiInject(ctx, member, {
      method: 'POST',
      url: `${node.route}/sources/${sourceId}/withdraw`,
      payload: {},
    })
    expect(withdrawal.statusCode, withdrawal.body).toBe(200)
    expect((await list(owner)).json().data).toEqual([])
    expect(await database.sql`select id from discovery_candidate`).toHaveLength(0)
  })
})
