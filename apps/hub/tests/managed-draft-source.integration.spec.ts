import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import {
  Outbox,
  countFailedMachineRunsForWork,
  countMachineRunsForWork,
  schema,
  type Database,
} from '@whalepod/db'
import { ManagedDraftStartSchema } from '@whalepod/protocol'
import { nodeConnections } from '../src/modules/device/connection-registry.js'
import { WsDeviceGateway } from '../src/modules/device/gateway.js'
import { OutboxWorker } from '../src/modules/run/outbox-worker.js'
import { prepareManagedDraftSourceManifest } from '../src/modules/draft-share/source-manifest.js'
import {
  loadRegisteredDraftSource,
  managedDraftModelBindingDigest,
  registerManagedDraftSource,
  revokeManagedDraftSource,
} from '../src/modules/draft-share/source-registry.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

const MODEL_ROUTE = {
  provider: 'managed-model-provider',
  model: 'test-model',
  endpointId: 'approved-endpoint',
  accountId: 'approved-account',
  policyGeneration: 1,
  expiresAt: new Date('2026-11-09T14:00:00Z'),
}
const NOW = new Date('2026-11-09T12:00:00Z')
const EXPIRY = new Date('2026-11-09T13:00:00Z')
const SOURCE_MARKER = 'registered-source-policy-probe'

describe('managed draft source registration over a real Task agreement', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let taskId: string
  let projectId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
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
      payload: { name: 'Managed draft source probe' },
    })
    expect(project.statusCode).toBe(201)
    projectId = project.json().data.id as string
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Managed draft source probe', assigneeUserId: alice.userId },
    })
    expect(task.statusCode).toBe(201)
    taskId = task.json().data.id as string
    const accepted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accepted.statusCode).toBe(200)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function confirmAgreement(author = alice, goal = SOURCE_MARKER): Promise<string> {
    const draft = await apiInject(ctx, author, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: { goal, constraints: '', acceptance: '', openQuestions: '' } },
    })
    expect(draft.statusCode).toBe(200)
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: draft.json().data.draftVersion },
    })
    expect(confirmed.statusCode).toBe(200)
    return confirmed.json().data.id as string
  }

  function registration(revisionId: string) {
    return {
      projectId,
      taskId,
      revisionId,
      recipientUserId: bob.userId,
      permitsPublishedAudience: false,
      confirmsOwnershipAndUses: true as const,
      confirmedModelBindingDigest: managedDraftModelBindingDigest(MODEL_ROUTE, NOW)!,
      expiresAt: EXPIRY,
      idempotencyKey: idemKey(),
    }
  }

  it('requires A to confirm the current deployment model binding through production HTTP', async () => {
    const revisionId = await confirmAgreement()
    const url = `/api/v1/tasks/${taskId}/managed-draft-sources`
    expect((await apiInject(ctx, alice, { method: 'GET', url })).statusCode).toBe(404)
    await ctx.close()
    const modelRoute = { ...MODEL_ROUTE, expiresAt: new Date(Date.now() + 30 * 60_000) }
    const host = {
      ownerUserId: alice.userId,
      deviceId: randomUUID(),
      workspaceId: randomUUID(),
      profileRevisionId: randomUUID(),
      managedHostGeneration: 1,
      proofSha256: createHash('sha256').update(randomBytes(32)).digest('hex'),
    }
    ctx = await createTestApp(database, {
      managedDraftHost: host,
      managedDraftModelRoute: modelRoute,
    })
    const policy = await apiInject(ctx, alice, { method: 'GET', url })
    expect(policy.statusCode).toBe(200)
    expect(policy.headers['cache-control']).toContain('no-store')
    expect(policy.json().data).toMatchObject({
      provider: modelRoute.provider,
      model: modelRoute.model,
      endpointId: modelRoute.endpointId,
      accountId: modelRoute.accountId,
      bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const input = {
      ...registration(revisionId),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      modelBindingDigest: policy.json().data.bindingDigest as string,
    }
    const { taskId: _, idempotencyKey, confirmedModelBindingDigest: _component, ...payload } = input
    expect((await apiInject(ctx, bob, { method: 'GET', url })).statusCode).toBe(404)
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url,
          idempotencyKey,
          payload: { ...payload, modelBindingDigest: '0'.repeat(64) },
        })
      ).statusCode,
    ).toBe(409)
    const registered = await apiInject(ctx, alice, { method: 'POST', url, idempotencyKey, payload })
    expect(registered.statusCode).toBe(201)
    expect(registered.headers['cache-control']).toContain('no-store')
    expect(registered.body).not.toContain(SOURCE_MARKER)
    const id = registered.json().data.id as string
    expect(
      (
        await apiInject(ctx, bob, {
          method: 'DELETE',
          url: `${url}/${id}`,
          idempotencyKey: idemKey(),
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'DELETE',
          url: `${url}/${id}`,
          idempotencyKey: idemKey(),
        })
      ).statusCode,
    ).toBe(204)
    expect(await loadRegisteredDraftSource(database, id, modelRoute, new Date())).toBeUndefined()
  })

  it.each(['delivered', 'revoked', 'expired'] as const)(
    'production HTTP and WS: a sealed preparation is %s',
    async (scenario) => {
      const post = (url: string, payload: object) =>
        apiInject(ctx, alice, {
          method: 'POST',
          url,
          payload,
          idempotencyKey: idemKey(),
        })
      const get = (url: string) => apiInject(ctx, alice, { method: 'GET', url })
      const revisionId = await confirmAgreement()
      const packs = await get('/api/v1/plugin-packs')
      expect(packs.statusCode).toBe(200)
      const packId = packs.json().data[0].id as string
      const modelRoute = { ...MODEL_ROUTE, expiresAt: new Date(Date.now() + 30 * 60_000) }
      const createdAgent = await post('/api/v1/agents', {
        name: 'Managed preparation agent',
        persona: 'ordinary agent persona never transmitted',
        provider: modelRoute.provider,
        model: modelRoute.model,
        credentialSlot: 'unused',
        pluginPackId: packId,
      })
      expect(createdAgent.statusCode).toBe(201)
      const agent = createdAgent.json().data as { id: string; currentRevisionId: string }
      async function pair(name: string) {
        const code = await post('/api/v1/devices/pairing-codes', {})
        expect(code.statusCode).toBe(201)
        const claim = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/devices/pairing-claims',
          headers: { 'idempotency-key': idemKey() },
          payload: {
            code: code.json().data.code,
            name,
            platform: 'darwin',
            architecture: 'arm64',
            nodeVersion: '24.12.0',
            nodeAppVersion: '0.1.0',
          },
        })
        expect(claim.statusCode).toBe(201)
        return claim.json().data as { deviceId: string; deviceToken: string }
      }
      const device = await pair('preparation-host')
      const other = await pair('ordinary-host')
      const workspaceId = randomUUID()
      const frame = (type: string, payload: unknown) =>
        JSON.stringify({
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type,
          payload,
        })
      const listen = async () =>
        (await ctx.app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:') +
        '/ws/v1/node'
      const sockets: WebSocket[] = []
      let child: ChildProcess | undefined
      let childHome: string | undefined
      const connect = async (url: string, token: string, proof?: string) => {
        const socket = new WebSocket(url, {
          headers: {
            authorization: `Device ${token}`,
            ...(proof === undefined ? {} : { 'x-whalepod-managed-host': proof }),
          },
        })
        sockets.push(socket)
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        return socket
      }
      try {
        const enrollment = await connect(await listen(), device.deviceToken)
        enrollment.send(
          frame('node.hello', {
            deviceId: device.deviceId,
            platform: 'darwin',
            architecture: 'arm64',
            nodeVersion: '24.12.0',
            supportedProtocolVersions: [1],
            dshDistributionVersion: 'ordinary-before-cutover',
            pluginPackDigests: [],
            contextCapabilities: ['project-context.v1', 'context-state.v1', 'work-input.v1'],
          }),
        )
        enrollment.send(
          frame('node.inventory', {
            deviceId: device.deviceId,
            workspaces: [
              {
                workspaceId,
                name: 'Preparation placement',
                kind: 'directory',
                capabilities: { read: true, write: true, git: false },
                available: true,
                lastCheckedAt: new Date().toISOString(),
              },
            ],
            credentialSlots: [],
          }),
        )
        await waitForValue(
          async () =>
            (await get('/api/v1/workspaces'))
              .json()
              .data.find(
                (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
              ),
          'registered placement',
        )
        enrollment.terminate()
        await ctx.close()
        const proof = randomBytes(32).toString('hex')
        const host = {
          ownerUserId: alice.userId,
          deviceId: device.deviceId,
          workspaceId,
          profileRevisionId: agent.currentRevisionId,
          managedHostGeneration: 1,
          proofSha256: createHash('sha256').update(proof).digest('hex'),
        }
        ctx = await createTestApp(database, {
          managedDraftHost: host,
          managedDraftModelRoute: modelRoute,
        })
        const wsUrl = await listen()
        const ordinaryRun = await post(`/api/v1/tasks/${taskId}/runs`, {
          agentId: agent.id,
          deviceId: device.deviceId,
          workspaceId,
          specRevisionId: revisionId,
          prompt: 'ordinary after cutover',
        })
        expect(ordinaryRun.statusCode, ordinaryRun.body).toBe(409)
        expect(ordinaryRun.json().error.code).toBe('DEVICE_OFFLINE')
        const sourceUrl = `/api/v1/tasks/${taskId}/managed-draft-sources`
        const model = await get(sourceUrl)
        expect(model.statusCode).toBe(200)
        const source = await post(sourceUrl, {
          projectId,
          revisionId,
          recipientUserId: bob.userId,
          confirmsOwnershipAndUses: true,
          permitsPublishedAudience: false,
          modelBindingDigest: model.json().data.bindingDigest,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        })
        expect(source.statusCode).toBe(201)
        const sourceId = source.json().data.id as string
        const work = await post(`/api/v1/tasks/${taskId}/works`, {
          goal: 'ordinary work goal never transmitted',
        })
        expect(work.statusCode).toBe(201)
        const workUrl = `/api/v1/works/${work.json().data.workKey as string}`
        const mandate = await post(`${workUrl}/mandates`, {
          allowedActionClasses: ['draft'],
          allowedAgentIds: [agent.id],
          allowedSourceTypes: ['task_message'],
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
        expect(mandate.statusCode).toBe(201)
        const comment = await post(`/api/v1/tasks/${taskId}/comments`, {
          body: 'ordinary trigger never transmitted',
        })
        expect(comment.statusCode).toBe(201)
        const trigger = { sourceType: 'task_message', sourceId: comment.json().data.id as string }
        expect((await post(`${workUrl}/inbox-items`, trigger)).statusCode).toBe(201)
        const admission = await post(`${workUrl}/admission-checks`, trigger)
        expect(admission.statusCode).toBe(200)
        const intent = `${workUrl}/dispatch-intents/${admission.json().data.proposedIntent.id as string}`
        expect((await post(`${intent}/approve`, {})).statusCode).toBe(200)
        const request = {
          agentId: agent.id,
          deviceId: device.deviceId,
          workspaceId,
          profileRevisionId: agent.currentRevisionId,
          executionProfile: 'managed_draft_source_preparation',
          managedDraftSourceId: sourceId,
        }
        expect((await post(`${intent}/dispatch`, request)).statusCode).toBe(409)
        const ordinarySocket = await connect(wsUrl, other.deviceToken)
        const ordinaryFrames: unknown[] = []
        ordinarySocket.on('message', (raw) => ordinaryFrames.push(String(raw)))
        let dedicated: WebSocket | undefined
        if (scenario === 'delivered') {
          const nodeBin = createRequire(
            new URL('../../node/package.json', import.meta.url),
          ).resolve('@whalepod/node/bin')
          childHome = await mkdtemp(join(tmpdir(), 'wp-managed-transport-'))
          const configPath = join(childHome, 'managed-host.json')
          const { proofSha256: _proofHash, ...placement } = host
          await writeFile(
            configPath,
            JSON.stringify({
              ...placement,
              hubUrl: new URL(wsUrl.replace('ws:', 'http:')).origin,
              deviceToken: device.deviceToken,
              managedHostToken: proof,
            }),
            { mode: 0o600 },
          )
          child = spawn(
            process.execPath,
            [nodeBin, 'start', '--managed-draft-config', configPath],
            {
              env: { ...process.env, HOME: childHome },
              stdio: 'ignore',
            },
          )
        } else {
          dedicated = await connect(wsUrl, device.deviceToken, proof)
          dedicated.send(
            frame('node.hello', {
              deviceId: device.deviceId,
              platform: 'darwin',
              architecture: 'arm64',
              nodeVersion: '24.12.0',
              supportedProtocolVersions: [1],
              dshDistributionVersion: 'managed-draft-control.v1',
              pluginPackDigests: [],
            }),
          )
        }
        await waitForValue(
          async () => (nodeConnections.isManagedDraftOnline(host) ? true : undefined),
          'dedicated host is ready',
        )
        const dispatched = await post(`${intent}/dispatch`, request)
        expect(dispatched.statusCode, dispatched.body).toBe(200)
        const runId = dispatched.json().data.runId as string
        const rows = await database.db.select().from(schema.dispatchOutbox)
        expect(rows).toHaveLength(1)
        const offer = rows[0]!
        expect(offer.type).toBe('managed_draft.start')
        const payload = ManagedDraftStartSchema.shape.payload.parse(offer.payload)
        expect(payload.manifest).toMatchObject({
          runId,
          source: { policyId: sourceId, revisionId },
        })
        expect(JSON.stringify(payload)).not.toMatch(
          /never transmitted|registered-source-policy-probe/,
        )
        const run = async () =>
          (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]
        expect(await run()).toMatchObject({
          status: 'queued',
          managedDraftSourceDigest: payload.manifestDigest,
          resumeContext: 'blocked',
          workInputManifest: null,
          artifactInputManifest: { taskId, artifacts: [] },
        })
        expect(await ctx.app.runOrchestrator.reconcileLeases(new Date())).toBe(0)
        expect((await run())?.status).toBe('queued')
        const bytes = Buffer.from('ordinary upload must stay blocked')
        const legacy = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/node/runs/${runId}/artifacts?title=ordinary&mediaType=text%2Fplain&sha256=${createHash('sha256').update(bytes).digest('hex')}`,
          headers: {
            authorization: `Device ${device.deviceToken}`,
            'idempotency-key': idemKey(),
            'content-type': 'application/octet-stream',
          },
          payload: bytes,
        })
        expect(legacy.statusCode).toBe(404)
        expect((await get(`/api/v1/runs/${runId}/input-manifest`)).statusCode).toBe(404)
        const outbox = new Outbox(database)
        const worker = new OutboxWorker({
          outbox,
          gateway: new WsDeviceGateway(),
          managedDraftTransport: ctx.app.managedDraftTransport,
        })
        const received: unknown[] = []
        dedicated?.on('message', (raw) => {
          const offer = ManagedDraftStartSchema.parse(JSON.parse(String(raw)))
          received.push(offer.payload)
          dedicated?.send(
            frame('command.ack', { commandId: offer.payload.commandId, accepted: true }),
          )
        })
        if (scenario === 'revoked') {
          const revoked = await apiInject(ctx, alice, {
            method: 'DELETE',
            url: `${sourceUrl}/${sourceId}`,
            idempotencyKey: idemKey(),
          })
          expect(revoked.statusCode).toBe(204)
          expect(await worker.dispatchOnce()).toMatchObject({ sent: 0, failed: 1 })
        } else if (scenario === 'expired') {
          expect(await ctx.app.runOrchestrator.reconcileLeases(new Date(Date.now() + 61_000))).toBe(
            1,
          )
          expect(await worker.dispatchOnce()).toMatchObject({ sent: 0, failed: 0 })
        } else {
          expect(await worker.dispatchOnce()).toMatchObject({ sent: 1, failed: 0 })
        }
        const terminal = await waitForValue(
          async () => ((await run())?.status === 'cancelled' ? run() : undefined),
          'preparation ended without executing',
        )
        expect(terminal?.startedAt).toBeNull()
        const [record] = await database.db
          .select()
          .from(schema.dispatchOutbox)
          .where(eq(schema.dispatchOutbox.id, offer.id))
        if (scenario !== 'delivered') {
          expect(received).toEqual([])
          expect(record).toMatchObject({ sentAt: null, ackedAt: null, failedAt: expect.any(Date) })
        } else {
          expect(child?.exitCode).toBeNull()
          expect(record).toMatchObject({
            sentAt: expect.any(Date),
            ackedAt: expect.any(Date),
            failedAt: null,
          })
        }
        expect(ordinaryFrames).toEqual([])
        expect(await database.db.select().from(schema.artifacts)).toEqual([])
        const workKey = work.json().data.workKey as string
        expect(await countMachineRunsForWork(database.db, workKey)).toBe(0)
        expect(await countFailedMachineRunsForWork(database.db, workKey)).toBe(0)
        if (scenario === 'delivered') {
          expect(
            (await post(`/api/v1/tasks/${taskId}/reassign`, { assigneeUserId: bob.userId }))
              .statusCode,
          ).toBe(200)
          const history = await apiInject(ctx, bob, { method: 'GET', url: workUrl })
          expect(history.statusCode).toBe(200)
          expect(history.json().data.dispatchIntents[0]).toMatchObject({
            runId: null,
            agentId: null,
            deviceId: null,
            workspaceId: null,
            profileRevisionId: null,
          })
        }
      } finally {
        for (const socket of sockets) socket.terminate()
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'close')
          child.kill('SIGKILL')
          await exited
        }
        if (childHome !== undefined) await rm(childHome, { recursive: true, force: true })
      }
    },
  )

  it('pins content, a named recipient and model route; version drift invalidates without changing old bytes', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const registered = await registerManagedDraftSource(
      database,
      alice.userId,
      input,
      MODEL_ROUTE,
      NOW,
    )
    expect(registered).toMatchObject({
      revisionId,
      recipientUserId: bob.userId,
      permitsPublishedAudience: false,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(registered)).not.toContain(SOURCE_MARKER)
    expect(
      await registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).toEqual(registered)
    const loaded = await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, NOW)
    expect(loaded?.bytes.toString('utf8')).toContain(SOURCE_MARKER)

    const changedRoute = { ...MODEL_ROUTE, accountId: 'another-account' }
    expect(
      await loadRegisteredDraftSource(database, registered.id, changedRoute, NOW),
    ).toBeUndefined()
    const renewedRoute = { ...MODEL_ROUTE, policyGeneration: MODEL_ROUTE.policyGeneration + 1 }
    expect(
      await loadRegisteredDraftSource(database, registered.id, renewedRoute, NOW),
    ).toBeUndefined()
    expect(
      await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, EXPIRY),
    ).toBeUndefined()

    const next = await confirmAgreement(alice, 'new revision')
    expect(next).not.toBe(revisionId)
    expect(
      await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, NOW),
    ).toBeUndefined()
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('freezes the exact source and active Mandate with an independently approved managed host', async () => {
    const revisionId = await confirmAgreement()
    const source = await registerManagedDraftSource(
      database,
      alice.userId,
      registration(revisionId),
      MODEL_ROUTE,
      NOW,
    )
    const workResponse = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: 'Draft the registered agreement' },
    })
    expect(workResponse.statusCode).toBe(201)
    const workKey = workResponse.json().data.workKey as string
    const mandateResponse = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        allowedActionClasses: ['draft'],
        allowedSourceTypes: ['task_message'],
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    })
    expect(mandateResponse.statusCode).toBe(201)

    const request = { actorUserId: alice.userId, workKey, runId: randomUUID(), sourceId: source.id }
    const placement = {
      deviceId: randomUUID(),
      workspaceId: randomUUID(),
      profileRevisionId: randomUUID(),
      managedHostGeneration: 2,
    }
    const prepare = (trustedPlacement: typeof placement | undefined) =>
      database.transaction((tx) =>
        prepareManagedDraftSourceManifest(tx, request, trustedPlacement, MODEL_ROUTE, NOW),
      )
    expect(await prepare(undefined)).toBeUndefined()
    const plan = await prepare(placement)
    expect(plan?.manifest).toMatchObject({
      runId: request.runId,
      projectId,
      taskId,
      workKey,
      ownerUserId: alice.userId,
      ...placement,
      instruction: 'draft_registered_agreement.v1',
      source: { policyId: source.id, revisionId, sha256: source.sha256, byteSize: source.byteSize },
      expiresAt: EXPIRY.toISOString(),
    })
    expect(plan?.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(plan)).not.toContain(SOURCE_MARKER)
    expect(await prepare(placement)).toEqual(plan)

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${mandateResponse.json().data.id}/pause`,
      payload: {},
    })
    expect(paused.statusCode).toBe(200)
    expect(await prepare(placement)).toBeUndefined()
  })

  it('does not infer ownership from readability, task responsibility or a model-looking identifier', async () => {
    const revisionId = await confirmAgreement(bob)
    const input = registration(revisionId)
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      registerManagedDraftSource(database, bob.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 403 })
    const own = await confirmAgreement()
    const ownInput = registration(own)
    await expect(
      registerManagedDraftSource(database, alice.userId, ownInput, undefined, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      registerManagedDraftSource(
        database,
        alice.userId,
        { ...ownInput, projectId: randomUUID() },
        MODEL_ROUTE,
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects a draft with unknown editor provenance, even if A wrote the first version', async () => {
    const url = `/api/v1/tasks/${taskId}/agreement`
    const body = { goal: SOURCE_MARKER, constraints: '', acceptance: '', openQuestions: '' }
    const original = await apiInject(ctx, alice, {
      method: 'POST',
      url: `${url}/draft`,
      payload: { content: body },
    })
    expect(original.statusCode).toBe(200)
    const edited = await apiInject(ctx, bob, {
      method: 'POST',
      url: `${url}/draft`,
      payload: { content: { ...body, goal: 'another author' }, expectedDraftVersion: 1 },
    })
    expect(edited.statusCode).toBe(200)
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `${url}/confirm`,
      payload: { draftVersion: 2 },
    })
    expect(confirmed.statusCode).toBe(200)
    await expect(
      registerManagedDraftSource(
        database,
        alice.userId,
        registration(confirmed.json().data.id),
        MODEL_ROUTE,
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('invalidates the old registration when assignment moves away and then back', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const first = await registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW)
    for (const assignee of [bob, alice]) {
      const reassign = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/reassign`,
        payload: { assigneeUserId: assignee.userId },
      })
      expect(reassign.statusCode).toBe(200)
      const accept = await apiInject(ctx, assignee, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/accept`,
      })
      expect(accept.statusCode).toBe(200)
      expect(await loadRegisteredDraftSource(database, first.id, MODEL_ROUTE, NOW)).toBeUndefined()
    }
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({
      statusCode: 409,
    })
    const next = await registerManagedDraftSource(
      database,
      alice.userId,
      { ...input, idempotencyKey: idemKey() },
      MODEL_ROUTE,
      NOW,
    )
    expect(next.id).not.toBe(first.id)
  })

  it('persists source invalidation in the member-disable transaction', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const registered = await registerManagedDraftSource(
      database,
      alice.userId,
      input,
      MODEL_ROUTE,
      NOW,
    )
    const disabled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
    })
    expect(disabled.statusCode).toBe(200)
    expect(
      await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, NOW),
    ).toBeUndefined()
    const [row] = await database.sql<
      { revoked: boolean }[]
    >`select revoked_at is not null as revoked from managed_draft_source_policy where id = ${registered.id}`
    expect(row?.revoked).toBe(true)
  })

  it('revokes an exact registration and never revives it when explicitly reauthorizing', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const first = await registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW)
    await expect(
      revokeManagedDraftSource(database, bob.userId, first.id, NOW),
    ).rejects.toMatchObject({ statusCode: 404 })
    await revokeManagedDraftSource(database, alice.userId, first.id, NOW)
    expect(await loadRegisteredDraftSource(database, first.id, MODEL_ROUTE, NOW)).toBeUndefined()
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
    const next = await registerManagedDraftSource(
      database,
      alice.userId,
      { ...input, idempotencyKey: idemKey() },
      MODEL_ROUTE,
      NOW,
    )
    expect(next.id).not.toBe(first.id)
    expect(await loadRegisteredDraftSource(database, first.id, MODEL_ROUTE, NOW)).toBeUndefined()
    expect(await loadRegisteredDraftSource(database, next.id, MODEL_ROUTE, NOW)).toBeDefined()
  })
})
