/**
 * ADR-0030 RD-04b（Issue #534）：按事实与槽位预授权，把发现候选立为一个已承接任务。
 *
 * 驱动全部走生产 HTTP / Node WS / 真 PostgreSQL；数据库只读用于独立核对。
 * 覆盖：预授权快照、目录核对、独立核实回执、并发只建一个、人工/机器两种顺序、
 * 撤权与更正、目录代次失效、covered 槽位、派生约定与零 Run/Mandate。
 */
import { randomUUID } from 'node:crypto'
import type { Database } from '@whalepod/db'
import { DISCOVERY_CAPABILITY, parseNodeFrame, type NodeDownstream } from '@whalepod/protocol'
import WebSocket from 'ws'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
import { ArtifactStore } from '../src/modules/artifact/store.js'
import { runDiscoveryTick } from '../src/modules/discovery/service.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

describe('RD-04b preauthorized creation', () => {
  let database: Database
  let ctx: TestApp
  let owner: Session
  let member: Session
  let verifier: Session
  let projectId: string
  let entryTaskId: string
  let venueTaskId: string
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
    verifier = (
      await driveInviteAndAccept(ctx, owner, {
        username: 'verifier',
        displayName: 'Verifier',
        password: 'verifier-test-password',
      })
    ).session
    const project = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: '活动筹备' },
    })
    expect(project.statusCode, project.body).toBe(201)
    projectId = project.json().data.id
    entryTaskId = await createTask('筹备讨论', owner.userId)
    venueTaskId = await createTask('场地座席', owner.userId)
    await acceptAndConfirmVenueAgreement()
  })
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await ctx.close()
  })
  afterAll(async () => database.close())

  async function createTask(title: string, assigneeUserId: string, extra: object = {}) {
    const response = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title, assigneeUserId, ...extra },
    })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().data.id as string
  }

  async function acceptAndConfirmVenueAgreement() {
    const accepted = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${venueTaskId}/accept`,
      payload: {},
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    const draft = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${venueTaskId}/agreement/draft`,
      payload: {
        content: {
          goal: '安排场地无障碍座席',
          constraints: '只使用项目内已确认材料',
          acceptance: '形成场地座席安排',
          openQuestions: '',
        },
      },
    })
    expect(draft.statusCode, draft.body).toBe(200)
    const confirmed = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${venueTaskId}/agreement/confirm`,
      payload: { draftVersion: draft.json().data.draftVersion },
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
  }

  async function connectPilot(deviceId: string, deviceToken: string) {
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
    return { client, send, messages }
  }

  async function setupPilot(
    options: {
      verify?: boolean
      verifierUserId?: string
      tier?: 'create' | 'execute'
      beforeConfig?: (pilot: {
        deviceId: string
        deviceToken: string
        workspaceId: string
      }) => Promise<{ evidenceArtifactIds?: string[] }>
    } = {},
  ) {
    const code = await apiInject(ctx, owner, {
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
        name: `rd04b-${sockets.length + 1}`,
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
    const workspaceId = randomUUID()
    const { send, messages } = await connectPilot(deviceId, deviceToken)
    send('node.hello', {
      deviceId,
      nodeVersion: '24.12.0',
      platform: 'darwin',
      architecture: 'arm64',
      supportedProtocolVersions: [1],
      dshDistributionVersion: '0.1.0-rc.8',
      pluginPackDigests: [],
      contextCapabilities: ['project-context.v1', 'context-state.v1'],
      coordinationCapabilities: ['coordination.v1', DISCOVERY_CAPABILITY],
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
      workspaces: [
        {
          workspaceId,
          name: 'rd04b',
          kind: 'directory',
          capabilities: { read: true, write: true, git: false },
          available: true,
          lastCheckedAt: new Date().toISOString(),
        },
      ],
      coordinationCredentialSlots: [credentials],
    })
    await waitForValue(async () => {
      const rows = await database.sql`select capabilities from device where id = ${deviceId}`
      return rows[0]?.capabilities?.coordinationCredentialSlots?.length === 1 ? true : undefined
    }, 'device coordination inventory missing')
    await waitForValue(async () => {
      const rows = await database.sql`select id from workspace where id = ${workspaceId}`
      return rows.length === 1 ? true : undefined
    }, 'device workspace missing')
    const router = await apiInject(ctx, owner, {
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
        model: credentials.model,
        teamDailyCallLimit: 20,
        teamDailyTokenLimit: 500_000,
        teamDailyCostMicrosLimit: 10_000,
        projectDailyCallLimit: 20,
        projectDailyTokenLimit: 500_000,
        projectDailyCostMicrosLimit: 10_000,
        maxInputTokens: 32_000,
        maxOutputTokens: 512,
        maxCostMicros: 100,
        inputPriceMicrosPerMillionTokens: 1,
        outputPriceMicrosPerMillionTokens: 1,
        timeoutSeconds: 30,
        maxRetries: 0,
      },
    })
    expect(router.statusCode, router.body).toBe(200)
    const prepared = options.beforeConfig
      ? await options.beforeConfig({ deviceId, deviceToken, workspaceId })
      : {}
    const route = `/api/v1/projects/${projectId}/discovery`
    const cfg = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${route}/config`,
      payload: {
        enabled: true,
        entryTaskId,
        principalUserId: owner.userId,
        activity: '活动',
        slot: '接驳草稿',
        templateVersion: 'v1',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        maxCalls: 6,
        maxTokens: 200_000,
        maxCostMicros: 1000,
        evidenceArtifactIds: prepared.evidenceArtifactIds ?? [],
        agreementTaskIds: [venueTaskId],
        tier: options.tier ?? 'create',
        template: {
          goal: '为{{activity}}准备{{slot}}',
          constraints: '只使用项目内已确认材料；来源 {{sourceId}}',
          acceptance: '形成可审阅的{{slot}}草稿',
          openQuestions: '',
        },
        verifierUserIds: [options.verifierUserId ?? verifier.userId, member.userId],
        maxCreations: 3,
      },
    })
    expect(cfg.statusCode, cfg.body).toBe(200)
    const { configVersion, slotId } = cfg.json().data as {
      configVersion: number
      slotId: string
    }
    const basis = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${route}/config`,
    })
    expect(basis.statusCode, basis.body).toBe(200)
    const templateDigest = basis.json().data.templateDigest as string
    const permit = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${route}/permit`,
      payload: { configVersion, tier: options.tier ?? 'create', templateDigest },
    })
    expect(permit.statusCode, permit.body).toBe(200)
    for (const session of [member, verifier]) {
      const participation = await apiInject(ctx, session, {
        method: 'POST',
        url: `${route}/participation`,
        payload: { configVersion },
      })
      expect(participation.statusCode, participation.body).toBe(200)
    }
    if (options.verify !== false) {
      const pilot = {
        send,
        messages,
        deviceId,
        deviceToken,
        workspaceId,
        slotId,
        route,
        configVersion,
      }
      await verifySlot(pilot)
      return pilot
    }
    return {
      send,
      messages,
      deviceId,
      deviceToken,
      workspaceId,
      slotId,
      route,
      configVersion,
    }
  }

  async function slotView(node: Awaited<ReturnType<typeof setupPilot>>) {
    const response = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${node.route}/slots/${node.slotId}`,
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().data as {
      catalog: {
        digest: string
        entries: { taskId: string; status: string }[]
      }
      verification: { eligibleEmpty: boolean } | null
      occupation: { taskId: string; source: string } | null
    }
  }

  async function verifySlot(
    node: Awaited<ReturnType<typeof setupPilot>>,
    coverage: (taskId: string) => 'covered' | 'not_covered' = () => 'not_covered',
  ) {
    const view = await slotView(node)
    const response = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/slots/${node.slotId}/verify`,
      payload: {
        catalogDigest: view.catalog.digest,
        complete: true,
        entries: view.catalog.entries.map((entry) => ({
          taskId: entry.taskId,
          coverage: coverage(entry.taskId),
        })),
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().data as { eligibleEmpty: boolean; coveredCount: number }
  }

  async function comment(body = '现场缺少通往接驳点的无障碍坡道。') {
    const response = await apiInject(ctx, member, {
      method: 'POST',
      url: `/api/v1/tasks/${entryTaskId}/comments`,
      payload: { body },
    })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().data.id as string
  }

  async function verifySource(node: Awaited<ReturnType<typeof setupPilot>>, sourceId: string) {
    const identityResponse = await apiInject(ctx, verifier, {
      method: 'GET',
      url: `${node.route}/sources/${sourceId}`,
    })
    expect(identityResponse.statusCode, identityResponse.body).toBe(200)
    const identityData = identityResponse.json().data as {
      sourceVersion: string
      sourceDigest: string
    }
    const identity = {
      sourceVersion: identityData.sourceVersion,
      sourceDigest: identityData.sourceDigest,
    }
    const response = await apiInject(ctx, verifier, {
      method: 'POST',
      url: `${node.route}/sources/${sourceId}/verify`,
      payload: identity,
    })
    expect(response.statusCode, response.body).toBe(200)
    return identity
  }

  async function getRequest(
    node: Awaited<ReturnType<typeof setupPilot>>,
    sourceId?: string,
  ): Promise<Extract<NodeDownstream, { type: 'discovery.request' }>['payload']> {
    await runDiscoveryTick({
      database,
      store: new ArtifactStore({ root: ctx.config.artifactStoreDir }),
    })
    let evaluationId: string | undefined
    if (sourceId !== undefined) {
      evaluationId = await waitForValue(async () => {
        const [row] = await database.sql`
          select evaluation_id from discovery_admission where source_id = ${sourceId}
        `
        return (row?.evaluation_id as string | null | undefined) ?? undefined
      }, 'source evaluation missing')
    }
    const message = await waitForValue(
      async () =>
        node.messages.find(
          (candidate) =>
            candidate.type === 'discovery.request' &&
            (evaluationId === undefined || candidate.payload.evaluationId === evaluationId),
        ) as Extract<NodeDownstream, { type: 'discovery.request' }> | undefined,
      'no discovery dispatch',
    )
    return message.payload
  }

  async function downloadAndStart(
    node: Awaited<ReturnType<typeof setupPilot>>,
    request: Awaited<ReturnType<typeof getRequest>>,
  ) {
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
    node.send('discovery.heartbeat', {
      purpose: request.purpose,
      evaluationId: request.evaluationId,
      attempt: request.attempt,
      leaseToken: request.leaseToken,
      readEntryIds: request.manifest.map((entry) => entry.id),
      modelStartedAt: new Date().toISOString(),
    })
    await waitForValue(
      async () =>
        node.messages.find(
          (message) =>
            message.type === 'discovery.model_start_ack' &&
            'evaluationId' in message.payload &&
            message.payload.evaluationId === request.evaluationId,
        ),
      'no discovery model start ack',
    )
  }

  async function sendIndependentGap(
    node: Awaited<ReturnType<typeof setupPilot>>,
    request: Awaited<ReturnType<typeof getRequest>>,
  ) {
    const source = request.manifest.find((entry) => entry.kind === 'source')!
    const slot = request.manifest.find((entry) => entry.kind === 'slot')!
    const citations = request.manifest
      .filter(
        (entry) => entry.kind === 'agreement' || entry.kind === 'evidence' || entry.kind === 'work',
      )
      .map((entry) => entry.id)
    const proposal = {
      classification: 'independent_gap' as const,
      source: source.id,
      slot: slot.id,
      citations,
      reason: '场地座席工作未涵盖接驳备选草稿。',
    }
    node.send('discovery.result', {
      purpose: request.purpose,
      evaluationId: request.evaluationId,
      attempt: request.attempt,
      leaseToken: request.leaseToken,
      evaluationDigest: request.evaluationDigest,
      status: 'completed',
      resultDigest: sha256Hex(canonicalJson(proposal)),
      proposal,
      readEntryIds: request.manifest.map((entry) => entry.id),
      usage: {
        provider: request.provider,
        model: request.model,
        inputTokens: 100,
        outputTokens: 10,
        costMicros: 1,
      },
    })
    const ack = await waitForValue(
      async () =>
        node.messages.find(
          (message) =>
            message.type === 'discovery.result_ack' &&
            'evaluationId' in message.payload &&
            message.payload.evaluationId === request.evaluationId,
        ),
      'no discovery result ack',
    )
    return ack.payload as { status: string }
  }

  async function waitForApplication(evaluationId: string) {
    return waitForValue(async () => {
      const [row] = await database.sql`
        select id, task_id, work_id, spec_revision_id, source_id, permit_id, slot_id, verification
        from discovery_application where evaluation_id = ${evaluationId}
      `
      return row
    }, 'discovery application missing')
  }

  async function waitForCreationReason(evaluationId: string, reason: string) {
    return waitForValue(async () => {
      const [row] = await database.sql`
        select id, creation_reason, creation_terminal
        from discovery_candidate where evaluation_id = ${evaluationId}
      `
      return row?.creation_reason === reason ? row : undefined
    }, `candidate did not settle on ${reason}`)
  }

  it('creates one accepted task, a derived agreement and an active work without dispatch', async () => {
    const node = await setupPilot()
    const sourceId = await comment()
    const identityResponse = await apiInject(ctx, member, {
      method: 'GET',
      url: `${node.route}/sources/${sourceId}`,
    })
    expect(identityResponse.statusCode, identityResponse.body).toBe(200)
    const identityData = identityResponse.json().data as {
      sourceVersion: string
      sourceDigest: string
    }
    const identity = {
      sourceVersion: identityData.sourceVersion,
      sourceDigest: identityData.sourceDigest,
    }
    const selfVerified = await apiInject(ctx, member, {
      method: 'POST',
      url: `${node.route}/sources/${sourceId}/verify`,
      payload: identity,
    })
    expect(selfVerified.statusCode, selfVerified.body).toBe(403)
    expect(selfVerified.json().error.message).toContain('author')
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    const ack = await sendIndependentGap(node, request)
    expect(ack.status).toBe('accepted')
    const application = await waitForApplication(request.evaluationId)

    const [permit] = await database.sql`
      select tier, template, template_digest, max_creations, verifier_user_ids, confirmed_at
      from discovery_permit where id = ${application.permit_id}
    `
    expect(permit).toMatchObject({
      tier: 'create',
      max_creations: 3,
      verifier_user_ids: [verifier.userId, member.userId],
      template: {
        goal: '为{{activity}}准备{{slot}}',
        acceptance: '形成可审阅的{{slot}}草稿',
      },
    })
    const [binding] = await database.sql`
      select source_id, source_version, source_digest, verification
      from discovery_source_binding where application_id = ${application.id}
    `
    expect(binding).toMatchObject({
      source_id: sourceId,
      source_version: identity.sourceVersion,
      source_digest: identity.sourceDigest,
      verification: { kind: 'receipt' },
    })

    const [task] = await database.sql`
      select assignee_user_id, assignment_status, agreement_enabled, title, accepted_at
      from task where id = ${application.task_id}
    `
    expect(task).toMatchObject({
      assignee_user_id: owner.userId,
      assignment_status: 'accepted',
      agreement_enabled: true,
      title: '活动 · 接驳草稿',
    })
    expect(task?.accepted_at).not.toBeNull()
    expect(new Date(task!.accepted_at).toISOString()).toBe(
      new Date(permit!.confirmed_at).toISOString(),
    )

    const [spec] = await database.sql`
      select status, origin, revision_number, confirmed_by, confirmed_at, content
      from task_spec_revision where id = ${application.spec_revision_id}
    `
    expect(spec).toMatchObject({
      status: 'derived',
      origin: 'preauthorized_template',
      revision_number: null,
      confirmed_by: null,
      confirmed_at: null,
    })
    expect(spec?.content.goal).toBe('为活动准备接驳草稿')
    expect(spec?.content.constraints).toContain(`来源 ${sourceId}`)
    expect(spec?.content.acceptance).toBe('形成可审阅的接驳草稿草稿')

    const [work] = await database.sql`
      select work_key, human_owner_user_id, state, goal from work where id = ${application.work_id}
    `
    expect(work).toMatchObject({
      human_owner_user_id: owner.userId,
      state: 'active',
      goal: '为活动准备接驳草稿',
    })
    expect(
      await database.sql`select id from work_mandate where work_id = ${application.work_id}`,
    ).toEqual([])
    expect(
      await database.sql`select id from dispatch_intent where work_id = ${application.work_id}`,
    ).toEqual([])
    expect(
      await database.sql`select id from run where task_id = ${application.task_id} or work_key = ${work!.work_key}`,
    ).toEqual([])
    expect(application.verification).toMatchObject({ kind: 'receipt' })
    expect((application.verification['receiptIds'] as string[]).length).toBe(1)

    const agreement = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${application.task_id}/agreement`,
    })
    expect(agreement.statusCode, agreement.body).toBe(200)
    expect(agreement.json().data).toMatchObject({
      enabled: true,
      confirmed: null,
      confirmedCount: 0,
    })

    const mandate = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/works/${work!.work_key}/mandates`,
      payload: { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    })
    expect(mandate.statusCode, mandate.body).toBe(409)

    const packs = await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/plugin-packs' })
    const pack = packs.json().data.find((item: { name: string }) => item.name === 'core-empty')
    const agent = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        name: 'rd04b-agent',
        persona: 'Draft the shuttle option.',
        provider: 'fixture',
        model: 'fixture',
        credentialSlot: 'default',
        pluginPackId: pack.id,
      },
    })
    expect(agent.statusCode, agent.body).toBe(201)
    const run = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${application.task_id}/runs`,
      payload: {
        agentId: agent.json().data.id,
        deviceId: node.deviceId,
        workspaceId: node.workspaceId,
        prompt: 'Draft the shuttle option.',
      },
    })
    expect(run.statusCode, run.body).toBe(409)
    expect(run.json().error.code).toBe('AGREEMENT_REQUIRED')

    const candidates = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${node.route}/candidates`,
    })
    expect(candidates.json().data[0]).toMatchObject({
      application: { taskId: application.task_id },
    })
    const view = await slotView(node)
    expect(view.occupation).toMatchObject({
      taskId: application.task_id,
      source: 'auto',
    })
    const manual = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: {
        title: '人工重复认领',
        assigneeUserId: owner.userId,
        discovery: { slotId: node.slotId },
      },
    })
    expect(manual.statusCode, manual.body).toBe(409)
    expect(manual.json().error.details).toMatchObject({
      code: 'DISCOVERY_SLOT_OCCUPIED',
      existingTaskId: application.task_id,
    })
    expect(candidates.json().data[0]).toMatchObject({
      creation: { reason: 'applied', terminal: true },
    })

    // A later tick must not delete the applied candidate through the application FK.
    await expect(
      runDiscoveryTick({
        database,
        store: new ArtifactStore({ root: ctx.config.artifactStoreDir }),
        now: () => new Date(Date.now() + 120_000),
      }),
    ).resolves.toBeUndefined()
    expect(
      await database.sql`select id from discovery_application where id = ${application.id}`,
    ).toHaveLength(1)

    // Source withdrawal rejects the candidate body but leaves the established Task alone.
    const withdraw = await apiInject(ctx, member, {
      method: 'POST',
      url: `${node.route}/sources/${sourceId}/withdraw`,
      payload: {},
    })
    expect(withdraw.statusCode, withdraw.body).toBe(200)
    const afterWithdraw = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${node.route}/candidates`,
    })
    expect(afterWithdraw.json().data).toEqual([])
    expect(await database.sql`select id from task where id = ${application.task_id}`).toHaveLength(
      1,
    )

    const reassigned = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${application.task_id}/reassign`,
      payload: { assigneeUserId: member.userId },
    })
    expect(reassigned.statusCode, reassigned.body).toBe(200)
    const acceptedByNewOwner = await apiInject(ctx, member, {
      method: 'POST',
      url: `/api/v1/tasks/${application.task_id}/accept`,
      payload: {},
    })
    expect(acceptedByNewOwner.statusCode, acceptedByNewOwner.body).toBe(200)
    const acceptWork = await apiInject(ctx, member, {
      method: 'POST',
      url: `/api/v1/works/${work!.work_key}/accept`,
      payload: { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    })
    expect(acceptWork.statusCode, acceptWork.body).toBe(409)
    expect(
      await database.sql`select id from work_mandate where work_id = ${application.work_id}`,
    ).toEqual([])
  })

  it('accepts independent support from a registered verifier published evidence', async () => {
    const evidence = '勘察记录：接驳点缺少无障碍坡道，备用路线需要现场确认。'
    let artifactId = ''
    const node = await setupPilot({
      tier: 'execute',
      verifierUserId: owner.userId,
      beforeConfig: async ({ deviceId, deviceToken, workspaceId }) => {
        const packs = await apiInject(ctx, owner, {
          method: 'GET',
          url: '/api/v1/plugin-packs',
        })
        const pack = packs.json().data.find((item: { name: string }) => item.name === 'core-empty')
        const agent = await apiInject(ctx, owner, {
          method: 'POST',
          url: '/api/v1/agents',
          payload: {
            name: 'rd04b-evidence',
            persona: 'Record site access findings.',
            provider: 'fixture',
            model: 'fixture',
            credentialSlot: 'default',
            pluginPackId: pack.id,
          },
        })
        expect(agent.statusCode, agent.body).toBe(201)
        const run = await apiInject(ctx, owner, {
          method: 'POST',
          url: `/api/v1/tasks/${venueTaskId}/runs`,
          payload: {
            agentId: agent.json().data.id,
            deviceId,
            workspaceId,
            prompt: 'Record site access findings.',
          },
        })
        expect(run.statusCode, run.body).toBe(201)
        const bytes = Buffer.from(evidence)
        const query = new URLSearchParams({
          title: '接驳勘察',
          mediaType: 'text/plain',
          byteSize: String(bytes.length),
          sha256: sha256Hex(evidence),
          sourceRelativePath: 'access.txt',
        })
        const uploaded = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/node/runs/${run.json().data.id}/artifacts?${query}`,
          headers: {
            authorization: `Device ${deviceToken}`,
            'content-type': 'application/octet-stream',
            'idempotency-key': randomUUID(),
          },
          payload: bytes,
        })
        expect(uploaded.statusCode, uploaded.body).toBe(201)
        artifactId = uploaded.json().data.id as string
        const published = await apiInject(ctx, owner, {
          method: 'POST',
          url: `/api/v1/artifacts/${artifactId}/publish`,
          payload: {},
        })
        expect(published.statusCode, published.body).toBe(200)
        return { evidenceArtifactIds: [artifactId] }
      },
    })
    const sourceId = await comment()
    const request = await getRequest(node)
    expect(request.manifest.map((entry) => entry.kind)).toEqual([
      'source',
      'slot',
      'agreement',
      'evidence',
      'work',
    ])
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    const application = await waitForApplication(request.evaluationId)
    expect(application.verification).toMatchObject({
      kind: 'published_evidence',
      receiptIds: [],
      evidence: [{ artifactId, verifierUserId: owner.userId }],
    })
    expect(
      await database.sql`select id from discovery_verification where source_id = ${sourceId}`,
    ).toEqual([])
    const basis = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${node.route}/applications/${application.id}/execution`,
    })
    expect(basis.statusCode, basis.body).toBe(200)
    expect(basis.json().data).toMatchObject({ eligible: true })
    expect(
      (basis.json().data.sources as { kind: string }[]).map((source) => source.kind).sort(),
    ).toEqual(['artifact', 'task_message'])
  })

  it('serializes concurrent applications into one task and one occupation', async () => {
    const node = await setupPilot({ verify: false })
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    await waitForCreationReason(request.evaluationId, 'slot_unverified')
    const [candidate] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${request.evaluationId}
    `
    const nonPrincipal = await apiInject(ctx, member, {
      method: 'POST',
      url: `${node.route}/candidates/${candidate!.id}/apply`,
      payload: {},
    })
    // Non-principals cannot distinguish an existing candidate from a missing one.
    expect(nonPrincipal.statusCode, nonPrincipal.body).toBe(404)
    await verifySlot(node)
    const apply = () =>
      apiInject(ctx, owner, {
        method: 'POST',
        url: `${node.route}/candidates/${candidate!.id}/apply`,
        payload: {},
      })
    const [a, b] = await Promise.all([apply(), apply()])
    expect(a.statusCode, a.body).toBe(200)
    expect(b.statusCode, b.body).toBe(200)
    expect([a.json().data.status, b.json().data.status].sort()).toEqual([
      'already_applied',
      'applied',
    ])
    expect(
      (
        await database.sql`select id from discovery_application where evaluation_id = ${request.evaluationId}`
      ).length,
    ).toBe(1)
    expect(
      (await database.sql`select id from discovery_slot_occupation where slot_id = ${node.slotId}`)
        .length,
    ).toBe(1)
    expect(
      (
        await database.sql`select id from task where id in (select task_id from discovery_slot_occupation where slot_id = ${node.slotId})`
      ).length,
    ).toBe(1)
  })

  it('lets only one of two independent reports occupy the slot', async () => {
    const node = await setupPilot({ verify: false })
    const firstSource = await comment('接驳点没有坡道。')
    await verifySource(node, firstSource)
    const firstRequest = await getRequest(node, firstSource)
    await downloadAndStart(node, firstRequest)
    expect((await sendIndependentGap(node, firstRequest)).status).toBe('accepted')
    await waitForCreationReason(firstRequest.evaluationId, 'slot_unverified')

    const secondSource = await comment('现场勘察确认，接驳点仍缺少无障碍坡道。')
    await verifySource(node, secondSource)
    const secondRequest = await getRequest(node, secondSource)
    await downloadAndStart(node, secondRequest)
    expect((await sendIndependentGap(node, secondRequest)).status).toBe('accepted')
    await waitForCreationReason(secondRequest.evaluationId, 'slot_unverified')

    const [first] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${firstRequest.evaluationId}
    `
    const [second] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${secondRequest.evaluationId}
    `
    await verifySlot(node)
    const apply = (candidateId: string) =>
      apiInject(ctx, owner, {
        method: 'POST',
        url: `${node.route}/candidates/${candidateId}/apply`,
        payload: {},
      })
    const [a, b] = await Promise.all([apply(first!.id), apply(second!.id)])
    expect(a.statusCode, a.body).toBe(200)
    expect(b.statusCode, b.body).toBe(200)
    expect([a.json().data.status, b.json().data.status].sort()).toEqual(['applied', 'rejected'])
    expect(
      (await database.sql`select id from discovery_application where project_id = ${projectId}`)
        .length,
    ).toBe(1)
    expect(
      (await database.sql`select id from discovery_slot_occupation where slot_id = ${node.slotId}`)
        .length,
    ).toBe(1)
    expect((await database.sql`select id from task where project_id = ${projectId}`).length).toBe(3)
  })

  it('serializes a manual claim against an automatic application', async () => {
    const node = await setupPilot({ verify: false })
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    await waitForCreationReason(request.evaluationId, 'slot_unverified')
    const [candidate] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${request.evaluationId}
    `
    await verifySlot(node)
    const [applied, claimed] = await Promise.all([
      apiInject(ctx, owner, {
        method: 'POST',
        url: `${node.route}/candidates/${candidate!.id}/apply`,
        payload: {},
      }),
      apiInject(ctx, owner, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: {
          title: '并发人工认领',
          assigneeUserId: owner.userId,
          discovery: { slotId: node.slotId },
        },
      }),
    ])
    expect([200, 409]).toContain(applied.statusCode)
    expect([201, 409]).toContain(claimed.statusCode)
    const [occupation] = await database.sql`
      select task_id, source from discovery_slot_occupation where slot_id = ${node.slotId}
    `
    if (!occupation) throw new Error('slot occupation missing after concurrent create')
    expect(
      (await database.sql`select id from discovery_slot_occupation where slot_id = ${node.slotId}`)
        .length,
    ).toBe(1)
    expect(
      (
        await database.sql`select id from discovery_application where evaluation_id = ${request.evaluationId}`
      ).length,
    ).toBe(occupation.source === 'auto' ? 1 : 0)
    if (occupation.source === 'auto') {
      expect(applied.json().data.status).toBe('applied')
      expect(claimed.statusCode).toBe(409)
      expect(claimed.json().error.details).toMatchObject({
        code: 'DISCOVERY_SLOT_OCCUPIED',
        existingTaskId: occupation.task_id,
      })
    } else {
      expect(claimed.statusCode).toBe(201)
      expect(applied.json().data).toMatchObject({ status: 'rejected', reason: 'slot_occupied' })
    }
    expect((await database.sql`select id from task where id = ${occupation.task_id}`).length).toBe(
      1,
    )
  })

  it('rejects unclassified manual creation and lets a manual claim win the only occupation', async () => {
    const node = await setupPilot({ verify: false })
    const unclassified = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '旧客户端新建', assigneeUserId: owner.userId },
    })
    expect(unclassified.statusCode, unclassified.body).toBe(409)
    expect(unclassified.json().error.details).toMatchObject({
      code: 'DISCOVERY_CLASSIFICATION_REQUIRED',
    })

    const sourceId = await comment()
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    await waitForCreationReason(request.evaluationId, 'slot_unverified')
    const [candidate] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${request.evaluationId}
    `

    const manualTaskId = await createTask('人工认领', owner.userId, {
      discovery: { slotId: node.slotId },
    })
    const duplicate = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: {
        title: '再次认领',
        assigneeUserId: owner.userId,
        discovery: { slotId: node.slotId },
      },
    })
    expect(duplicate.statusCode, duplicate.body).toBe(409)
    expect(duplicate.json().error.details).toMatchObject({
      code: 'DISCOVERY_SLOT_OCCUPIED',
      existingTaskId: manualTaskId,
    })
    // The slot occupation is checked before the catalog is re-read, so the manual claim
    // wins even though the candidate's evaluation is still current.
    const applied = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/candidates/${candidate!.id}/apply`,
      payload: {},
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json().data).toMatchObject({ status: 'rejected', reason: 'slot_occupied' })
    expect(
      await database.sql`select id from discovery_application where evaluation_id = ${request.evaluationId}`,
    ).toEqual([])
    expect((await database.sql`select id from task where project_id = ${projectId}`).length).toBe(3)
  })

  it('does not create anything after permit revocation or an author correction', async () => {
    const revoked = await setupPilot({ verify: false })
    const firstSource = await comment()
    const firstRequest = await getRequest(revoked)
    await downloadAndStart(revoked, firstRequest)
    expect((await sendIndependentGap(revoked, firstRequest)).status).toBe('accepted')
    await waitForCreationReason(firstRequest.evaluationId, 'slot_unverified')
    const [firstCandidate] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${firstRequest.evaluationId}
    `
    const revoke = await apiInject(ctx, owner, {
      method: 'DELETE',
      url: `${revoked.route}/permit`,
      payload: {},
    })
    expect(revoke.statusCode, revoke.body).toBe(200)
    expect(
      await database.sql`select id from discovery_candidate where id = ${firstCandidate!.id}`,
    ).toEqual([])
    const applyAfterRevoke = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${revoked.route}/candidates/${firstCandidate!.id}/apply`,
      payload: {},
    })
    expect(applyAfterRevoke.statusCode).toBe(404)

    const corrected = await setupPilot({ verify: false })
    const secondSource = await comment('接驳点没有坡道。')
    const secondRequest = await getRequest(corrected)
    await downloadAndStart(corrected, secondRequest)
    expect((await sendIndependentGap(corrected, secondRequest)).status).toBe('accepted')
    await waitForCreationReason(secondRequest.evaluationId, 'slot_unverified')
    const [secondCandidate] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${secondRequest.evaluationId}
    `
    const blankCorrection = await apiInject(ctx, member, {
      method: 'POST',
      url: `${corrected.route}/sources/${secondSource}/correct`,
      payload: { body: '   ' },
    })
    expect(blankCorrection.statusCode, blankCorrection.body).toBe(400)
    const correction = await apiInject(ctx, member, {
      method: 'POST',
      url: `${corrected.route}/sources/${secondSource}/correct`,
      payload: { body: '更正：接驳点坡道已临时铺设，缺口改为备用路线。' },
    })
    expect(correction.statusCode, correction.body).toBe(200)
    expect(
      await database.sql`select id from discovery_candidate where id = ${secondCandidate!.id}`,
    ).toEqual([])
    const applyAfterCorrection = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${corrected.route}/candidates/${secondCandidate!.id}/apply`,
      payload: {},
    })
    expect(applyAfterCorrection.statusCode).toBe(404)
    expect(
      await database.sql`select id from discovery_application where project_id = ${projectId}`,
    ).toEqual([])
    expect((await database.sql`select id from task where project_id = ${projectId}`).length).toBe(2)
  })

  it('invalidates a verified empty slot after a scope change and refuses a covered slot', async () => {
    const stale = await setupPilot()
    const initialView = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${stale.route}/slots/${stale.slotId}`,
    })
    expect(initialView.json().data.verification).toMatchObject({
      current: true,
      eligibleEmpty: true,
      coveredCount: 0,
    })
    const memberView = await apiInject(ctx, member, {
      method: 'GET',
      url: `${stale.route}/slots/${stale.slotId}`,
    })
    expect(memberView.statusCode, memberView.body).toBe(403)
    const rename = await apiInject(ctx, owner, {
      method: 'PATCH',
      url: `/api/v1/tasks/${entryTaskId}`,
      payload: { title: '筹备讨论（范围更新）' },
    })
    expect(rename.statusCode, rename.body).toBe(200)
    const staleView = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${stale.route}/slots/${stale.slotId}`,
    })
    expect(staleView.json().data.verification.current).toBe(false)
    expect(staleView.json().data.verification.eligibleEmpty).toBe(false)
    const firstSource = await comment()
    await verifySource(stale, firstSource)
    const firstRequest = await getRequest(stale)
    await downloadAndStart(stale, firstRequest)
    expect((await sendIndependentGap(stale, firstRequest)).status).toBe('accepted')
    await waitForCreationReason(firstRequest.evaluationId, 'slot_unverified')
    expect(
      await database.sql`select id from discovery_application where evaluation_id = ${firstRequest.evaluationId}`,
    ).toEqual([])

    const covered = await setupPilot({ verify: false })
    const coveredView = await verifySlot(covered, (taskId) =>
      taskId === venueTaskId ? 'covered' : 'not_covered',
    )
    expect(coveredView).toMatchObject({ eligibleEmpty: false, coveredCount: 1 })
    const manualCovered = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: {
        title: '认领已覆盖槽位',
        assigneeUserId: owner.userId,
        discovery: { slotId: covered.slotId },
      },
    })
    expect(manualCovered.statusCode, manualCovered.body).toBe(409)
    expect(manualCovered.json().error.details).toMatchObject({
      code: 'DISCOVERY_SLOT_COVERED',
      existingTaskId: venueTaskId,
    })
    const secondSource = await comment('接驳点没有坡道。')
    await verifySource(covered, secondSource)
    const secondRequest = await getRequest(covered)
    await downloadAndStart(covered, secondRequest)
    expect((await sendIndependentGap(covered, secondRequest)).status).toBe('accepted')
    await waitForCreationReason(secondRequest.evaluationId, 'slot_covered')
    expect(
      await database.sql`select id from discovery_application where evaluation_id = ${secondRequest.evaluationId}`,
    ).toEqual([])
  })

  it('applies a candidate after the independent receipt arrives following evaluation', async () => {
    const node = await setupPilot()
    const sourceId = await comment()
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    const pending = await waitForCreationReason(request.evaluationId, 'independent_support_missing')
    expect(pending.creation_terminal).toBe(false)
    expect(
      await database.sql`select id from discovery_application where evaluation_id = ${request.evaluationId}`,
    ).toEqual([])

    // The receipt is allowed to arrive after the candidate; the tick retries non-terminal facts.
    await verifySource(node, sourceId)
    await expect(
      runDiscoveryTick({
        database,
        store: new ArtifactStore({ root: ctx.config.artifactStoreDir }),
        now: () => new Date(Date.now() + 61_000),
      }),
    ).resolves.toBeUndefined()
    const application = await waitForApplication(request.evaluationId)
    expect(application.task_id).toBeTruthy()
    expect(
      await database.sql`select id from discovery_candidate where evaluation_id = ${request.evaluationId}`,
    ).toHaveLength(1)
    expect(await database.sql`select id from run where task_id = ${application.task_id}`).toEqual(
      [],
    )
  })

  it('requeues a stale evaluation without clobbering the next dispatch', async () => {
    const node = await setupPilot({ verify: false })
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    await waitForCreationReason(request.evaluationId, 'slot_unverified')
    const [candidate] = await database.sql`
      select id from discovery_candidate where evaluation_id = ${request.evaluationId}
    `
    // Add a Work to the covered venue task: the catalog and evaluation manifest move while
    // coverage stays complete. Re-verify the empty slot so only the digest can reject.
    const work = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${venueTaskId}/works`,
      payload: { goal: '整理场地座席备选' },
    })
    expect(work.statusCode, work.body).toBe(201)
    await verifySlot(node)

    const stale = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/candidates/${candidate!.id}/apply`,
      payload: {},
    })
    expect(stale.statusCode, stale.body).toBe(200)
    expect(stale.json().data).toMatchObject({ status: 'rejected', reason: 'stale_evaluation' })
    const [admission] = await database.sql`
      select processed_at, evaluation_id, processing_reason, requeued_at
      from discovery_admission where source_id = ${sourceId}
    `
    expect(admission).toMatchObject({
      processed_at: null,
      evaluation_id: null,
      processing_reason: 'stale_replan',
    })
    expect(admission?.requeued_at).not.toBeNull()
    expect(
      await database.sql`select id from discovery_application where evaluation_id = ${request.evaluationId}`,
    ).toEqual([])

    const next = await getRequest(node, sourceId)
    expect(next.evaluationId).not.toBe(request.evaluationId)
    const [moved] = await database.sql`
      select evaluation_id, processed_at, requeued_at from discovery_admission
      where source_id = ${sourceId}
    `
    expect(moved?.evaluation_id).toBe(next.evaluationId)

    // Re-applying the old candidate while E2 is in flight must not clear E2 (CAS no-ops).
    const late = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/candidates/${candidate!.id}/apply`,
      payload: {},
    })
    expect(late.statusCode, late.body).toBe(200)
    expect(late.json().data).toMatchObject({ status: 'rejected', reason: 'stale_evaluation' })
    const [after] = await database.sql`
      select evaluation_id, processed_at, requeued_at from discovery_admission
      where source_id = ${sourceId}
    `
    expect(after).toEqual(moved)
  })

  it('keeps an applied candidate as audit history but hides its body after correction', async () => {
    const node = await setupPilot()
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    const application = await waitForApplication(request.evaluationId)
    const before = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${node.route}/candidates`,
    })
    expect(before.json().data).toHaveLength(1)
    expect(before.json().data[0]).toMatchObject({
      application: { taskId: application.task_id },
    })

    const correction = await apiInject(ctx, member, {
      method: 'POST',
      url: `${node.route}/sources/${sourceId}/correct`,
      payload: { body: '更正：坡道已临时铺设，缺口改为备用路线。' },
    })
    expect(correction.statusCode, correction.body).toBe(200)
    const after = await apiInject(ctx, owner, {
      method: 'GET',
      url: `${node.route}/candidates`,
    })
    expect(after.json().data).toEqual([])
    expect(
      await database.sql`select id from discovery_candidate where evaluation_id = ${request.evaluationId}`,
    ).toHaveLength(1)
    expect(await database.sql`select id from task where id = ${application.task_id}`).toHaveLength(
      1,
    )
  })

  it('requires an explicit create tier and the current template digest', async () => {
    const node = await setupPilot()
    const discovered = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/permit`,
      payload: { configVersion: node.configVersion },
    })
    expect(discovered.statusCode, discovered.body).toBe(200)
    const [permit] = await database.sql`
      select tier from discovery_permit
      where project_id = ${projectId} and principal_user_id = ${owner.userId}
      order by version desc limit 1
    `
    expect(permit?.tier).toBe('discover')

    const missingDigest = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/permit`,
      payload: { configVersion: node.configVersion, tier: 'create' },
    })
    expect(missingDigest.statusCode, missingDigest.body).toBe(409)
    const overTier = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/permit`,
      payload: { configVersion: node.configVersion, tier: 'execute' },
    })
    expect(overTier.statusCode, overTier.body).toBe(409)

    // Discover tier still stores settings as jsonb; NUL must be a 400, not a database 500.
    const configBase = {
      enabled: true,
      entryTaskId,
      principalUserId: owner.userId,
      activity: '活动',
      slot: '接驳草稿',
      templateVersion: 'v1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      maxCalls: 6,
      maxTokens: 200_000,
      maxCostMicros: 1000,
      tier: 'discover',
      verifierUserIds: [verifier.userId],
    }
    const nulActivity = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/config`,
      payload: { ...configBase, activity: '活动\u0000' },
    })
    expect(nulActivity.statusCode, nulActivity.body).toBe(400)
    const nulTemplate = await apiInject(ctx, owner, {
      method: 'POST',
      url: `${node.route}/config`,
      payload: {
        ...configBase,
        template: { goal: 'a\u0000b', constraints: '', acceptance: '', openQuestions: '' },
      },
    })
    expect(nulTemplate.statusCode, nulTemplate.body).toBe(400)
  })

  it('authorizes one exact-source private-draft execution for the principal', async () => {
    const node = await setupPilot({ tier: 'execute' })
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    const application = await waitForApplication(request.evaluationId)
    const url = `${node.route}/applications/${application.id}/execution`

    const hidden = await apiInject(ctx, member, { method: 'GET', url })
    expect(hidden.statusCode, hidden.body).toBe(404)
    const basis = await apiInject(ctx, owner, { method: 'GET', url })
    expect(basis.statusCode, basis.body).toBe(200)
    const basisData = basis.json().data as {
      eligible: boolean
      sourceManifestDigest: string
      execution: null
      sources: { kind: string; sourceId: string }[]
    }
    expect(basisData, JSON.stringify(basisData)).toMatchObject({ eligible: true, execution: null })
    expect(basisData.sources.map((source) => source.kind).sort()).toEqual([
      'receipt',
      'task_message',
    ])

    const executor = {
      provider: 'managed-model-provider',
      model: 'test-model',
      endpoint: 'approved-endpoint',
      account: 'approved-account',
    }
    const payload = {
      sourceManifestDigest: basisData.sourceManifestDigest,
      executor,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      confirmsPrivateDraft: true,
    }
    const changed = await apiInject(ctx, owner, {
      method: 'POST',
      url,
      payload: { ...payload, sourceManifestDigest: '0'.repeat(64) },
    })
    expect(changed.statusCode, changed.body).toBe(409)
    expect(changed.json().error.details).toMatchObject({
      code: 'DISCOVERY_SOURCE_MANIFEST_CHANGED',
    })

    const first = await apiInject(ctx, owner, { method: 'POST', url, payload })
    expect(first.statusCode, first.body).toBe(200)
    const authorized = first.json().data as {
      sourceManifestDigest: string
      execution: {
        id: string
        status: string
        purpose: string
        executor: typeof executor
        sourceManifestDigest: string
      }
    }
    expect(authorized.execution).toMatchObject({
      status: 'authorized',
      purpose: 'private_draft',
      executor,
      sourceManifestDigest: basisData.sourceManifestDigest,
    })
    const again = await apiInject(ctx, owner, { method: 'POST', url, payload })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().data.execution.id).toBe(authorized.execution.id)
    const [row] = await database.sql`
      select executor_digest, source_manifest_digest, revoked_at
      from discovery_execution where application_id = ${application.id}
    `
    expect(row).toMatchObject({
      source_manifest_digest: basisData.sourceManifestDigest,
      revoked_at: null,
    })
    expect(row?.executor_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      await database.sql`
        select kind from discovery_execution_source
        where execution_id = ${authorized.execution.id}
      `,
    ).toHaveLength(2)

    // A source correction revokes the execution authorization; no Task/Run is created.
    const correction = await apiInject(ctx, member, {
      method: 'POST',
      url: `${node.route}/sources/${sourceId}/correct`,
      payload: { body: '更正：坡道已临时铺设，缺口改为备用路线。' },
    })
    expect(correction.statusCode, correction.body).toBe(200)
    const after = await apiInject(ctx, owner, { method: 'GET', url })
    expect(after.json().data.execution).toMatchObject({
      status: 'revoked',
      revokedReason: 'source_corrected',
    })
    expect(after.json().data.eligible).toBe(false)
    expect(await database.sql`select id from run where task_id = ${application.task_id}`).toEqual(
      [],
    )
  })

  it('refuses execution authorization below the execute tier', async () => {
    const node = await setupPilot()
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    const application = await waitForApplication(request.evaluationId)
    const url = `${node.route}/applications/${application.id}/execution`
    const basis = await apiInject(ctx, owner, { method: 'GET', url })
    expect(basis.statusCode, basis.body).toBe(200)
    expect(basis.json().data).toMatchObject({ eligible: false, reason: 'tier_required' })
    const denied = await apiInject(ctx, owner, {
      method: 'POST',
      url,
      payload: {
        sourceManifestDigest: '0'.repeat(64),
        executor: {
          provider: 'managed-model-provider',
          model: 'test-model',
          endpoint: 'approved-endpoint',
          account: 'approved-account',
        },
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        confirmsPrivateDraft: true,
      },
    })
    expect(denied.statusCode, denied.body).toBe(409)
    expect(denied.json().error.details).toMatchObject({
      code: 'DISCOVERY_EXECUTION_UNAVAILABLE',
      reason: 'tier_required',
    })
  })

  it('revokes the execution authorization when the parent permit is withdrawn', async () => {
    const node = await setupPilot({ tier: 'execute' })
    const sourceId = await comment()
    await verifySource(node, sourceId)
    const request = await getRequest(node)
    await downloadAndStart(node, request)
    expect((await sendIndependentGap(node, request)).status).toBe('accepted')
    const application = await waitForApplication(request.evaluationId)
    const url = `${node.route}/applications/${application.id}/execution`
    const basis = await apiInject(ctx, owner, { method: 'GET', url })
    const payload = {
      sourceManifestDigest: basis.json().data.sourceManifestDigest as string,
      executor: {
        provider: 'managed-model-provider',
        model: 'test-model',
        endpoint: 'approved-endpoint',
        account: 'approved-account',
      },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      confirmsPrivateDraft: true,
    }
    const authorized = await apiInject(ctx, owner, { method: 'POST', url, payload })
    expect(authorized.statusCode, authorized.body).toBe(200)
    const revoke = await apiInject(ctx, owner, {
      method: 'DELETE',
      url: `${node.route}/permit`,
    })
    expect(revoke.statusCode, revoke.body).toBe(200)
    const after = await apiInject(ctx, owner, { method: 'GET', url })
    expect(after.json().data.execution).toMatchObject({
      status: 'revoked',
      revokedReason: 'permit_revoked',
    })
    expect(after.json().data.eligible).toBe(false)
  })
})
