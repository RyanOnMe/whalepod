import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import {
  buildManagedDraftModelBody,
  ManagedDraftCandidateProofSchema,
  ManagedDraftExecuteSchema,
  ManagedDraftStartSchema,
  parseClientFrame,
  type ClientFrame,
  MANAGED_DRAFT_EXECUTION_VERSION,
} from '@whalepod/protocol'
import { managedDraftCandidateStore } from '../src/modules/draft-share/candidate-store.js'
import { nodeConnections } from '../src/modules/device/connection-registry.js'
import { WsDeviceGateway } from '../src/modules/device/gateway.js'
import { OutboxWorker } from '../src/modules/run/outbox-worker.js'
import { prepareManagedDraftSourceManifest } from '../src/modules/draft-share/source-manifest.js'
import {
  activateManagedDraftModelPolicy,
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
import {
  verifyManagedDraftRecipient,
  verifyManagedDraftReviewInvalidation,
} from './managed-draft-grant-contract.js'

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
const MODEL_OUTPUT = 'private local model response'

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

  it('never reactivates a superseded model policy across concurrent Hubs or a restart', async () => {
    const revisionId = await confirmAgreement()
    const url = `/api/v1/tasks/${taskId}/managed-draft-sources`
    const host = {
      ownerUserId: alice.userId,
      deviceId: randomUUID(),
      workspaceId: randomUUID(),
      profileRevisionId: randomUUID(),
      managedHostGeneration: 1,
      proofSha256: createHash('sha256').update(randomBytes(32)).digest('hex'),
    }
    const first = { ...MODEL_ROUTE, expiresAt: new Date(Date.now() + 30 * 60_000) }
    const next = {
      ...first,
      policyGeneration: first.policyGeneration + 1,
      accountId: 'new-account',
    }
    const apps: TestApp[] = []
    const boot = async (modelRoute: typeof first) => {
      const app = await createTestApp(database, {
        managedDraftHost: host,
        managedDraftModelRoute: modelRoute,
      })
      apps.push(app)
      return app
    }
    const get = (app: TestApp) => apiInject(app, alice, { method: 'GET', url })
    const register = (app: TestApp, modelBindingDigest: string) =>
      apiInject(app, alice, {
        method: 'POST',
        url,
        payload: {
          projectId,
          revisionId,
          recipientUserId: bob.userId,
          permitsPublishedAudience: false,
          confirmsOwnershipAndUses: true,
          modelBindingDigest,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      })

    try {
      const oldHub = await boot(first)
      const oldPolicy = await get(oldHub)
      expect(oldPolicy.statusCode).toBe(200)
      const oldDigest = oldPolicy.json().data.bindingDigest as string
      const initial = await register(oldHub, oldDigest)
      expect(initial.statusCode).toBe(201)
      const sourceId = initial.json().data.id as string
      expect(await loadRegisteredDraftSource(database, sourceId, first, new Date())).toBeDefined()

      const nextHub = await boot(next)
      const current = await get(nextHub)
      expect(current.statusCode).toBe(200)
      expect(current.json().data.bindingDigest).not.toBe(oldDigest)
      expect((await get(oldHub)).statusCode).toBe(404)
      expect((await register(oldHub, oldDigest)).statusCode).toBe(409)
      expect(await loadRegisteredDraftSource(database, sourceId, first, new Date())).toBeUndefined()

      const rollback = await boot(first)
      const conflict = await boot({ ...next, accountId: 'conflicting-account' })
      for (const disabled of [rollback, conflict]) {
        expect((await get(disabled)).statusCode).toBe(404)
        expect((await disabled.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
      }
      const restarted = await boot(next)
      expect((await get(restarted)).json().data.bindingDigest).toBe(
        current.json().data.bindingDigest,
      )
      expect(
        (await register(restarted, current.json().data.bindingDigest as string)).statusCode,
      ).toBe(201)
    } finally {
      await Promise.all(apps.map((app) => app.close()))
    }
  })

  it.each([
    'delivered',
    'revoked',
    'expired',
    'execution-revoked',
    'execution-in-flight',
    'execution-in-flight-reconnect',
    'execution-reconnected',
    'execution-upload-revoked',
    'execution-upload-incomplete',
    ...(process.platform === 'darwin' ? (['execution', 'execution-review'] as const) : []),
  ] as const)(
    'production HTTP and WS: a sealed operation is %s',
    async (scenario) => {
      const packaged = scenario === 'execution' || scenario === 'execution-review'
      const executes =
        packaged ||
        scenario === 'execution-revoked' ||
        scenario === 'execution-in-flight' ||
        scenario === 'execution-in-flight-reconnect' ||
        scenario === 'execution-reconnected' ||
        scenario === 'execution-upload-revoked' ||
        scenario === 'execution-upload-incomplete'
      let releaseProvider: (() => void) | undefined
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve
      })
      let modelServer: Server | undefined
      const providerBodies: Buffer[] = []
      let providerDisconnected = false
      let pendingModel: Promise<Response> | undefined
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
        let managedDraftLoopbackEndpoint: string | undefined
        if (executes) {
          modelServer = createServer(async (request, response) => {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            providerBodies.push(Buffer.concat(chunks))
            if (
              scenario === 'execution-in-flight' ||
              scenario === 'execution-in-flight-reconnect'
            ) {
              response.once('close', () => {
                providerDisconnected = !response.writableEnded
              })
              await providerGate
            }
            if (response.destroyed) return
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(
              JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: MODEL_OUTPUT } }],
                usage: { prompt_tokens: 5, completion_tokens: 4 },
              }),
            )
          })
          modelServer.listen({ host: '127.0.0.1', port: 0 })
          await once(modelServer, 'listening')
          managedDraftLoopbackEndpoint = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/completion`
        }
        ctx = await createTestApp(database, {
          managedDraftHost: host,
          managedDraftModelRoute: modelRoute,
          managedDraftLoopbackEndpoint,
          managedDraftMemberReviewEnabled: packaged || scenario === 'execution-upload-incomplete',
        })
        const wsUrl = await listen()
        if (scenario === 'execution-upload-revoked')
          expect((await get('/api/v1/managed-draft-candidates')).statusCode).toBe(404)
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
          allowedSourceTypes:
            scenario === 'execution-review' ? ['task_message', 'context_entry'] : ['task_message'],
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
          executionProfile: executes
            ? 'managed_draft_source_execution_check'
            : 'managed_draft_source_preparation',
          managedDraftSourceId: sourceId,
        }
        expect((await post(`${intent}/dispatch`, request)).statusCode).toBe(409)
        const ordinarySocket = await connect(wsUrl, other.deviceToken)
        const ordinaryFrames: unknown[] = []
        ordinarySocket.on('message', (raw) => ordinaryFrames.push(String(raw)))
        let dedicated: WebSocket | undefined
        if (scenario === 'execution') {
          const previousVersion = await connect(wsUrl, device.deviceToken, proof)
          const closed = once(previousVersion, 'close')
          previousVersion.send(
            frame('node.hello', {
              deviceId: device.deviceId,
              platform: 'darwin',
              architecture: 'arm64',
              nodeVersion: '24.12.0',
              supportedProtocolVersions: [1],
              dshDistributionVersion: 'managed-draft-isolated.v1',
              pluginPackDigests: [],
            }),
          )
          expect((await closed)[0]).toBe(4003)
          expect(nodeConnections.isManagedDraftOnline(host)).toBe(false)
        }
        if (scenario === 'delivered' || packaged) {
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
              ...(executes ? { managedDraftExecution: true } : {}),
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
              dshDistributionVersion: executes
                ? MANAGED_DRAFT_EXECUTION_VERSION
                : 'managed-draft-control.v1',
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
        expect(offer.type).toBe(executes ? 'managed_draft.execute' : 'managed_draft.start')
        const payload = (
          executes ? ManagedDraftExecuteSchema : ManagedDraftStartSchema
        ).shape.payload.parse(offer.payload)
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
          managedDraftExecution: ctx.app.managedDraftExecution,
        })
        if (executes) {
          const offered = dedicated === undefined ? undefined : once(dedicated, 'message')
          expect(await worker.dispatchOnce()).toMatchObject({ sent: 1, failed: 0 })
          if (offered !== undefined) {
            const [raw] = await offered
            expect(ManagedDraftExecuteSchema.parse(JSON.parse(String(raw))).payload).toEqual(
              payload,
            )
          }
          const url = `${new URL(wsUrl.replace('ws:', 'http:')).origin}/api/v1/node/managed-drafts/${runId}`
          const devicePost = (path: string, body: object, proofHeader = true) =>
            fetch(`${url}/${path}`, {
              method: 'POST',
              headers: {
                authorization: `Device ${device.deviceToken}`,
                'idempotency-key': idemKey(),
                'content-type': 'application/json',
                ...(proofHeader ? { 'x-whalepod-managed-host': proof } : {}),
              },
              body: JSON.stringify(body),
              redirect: 'error',
            })
          const candidatePost = (
            binding: object,
            contents: string,
            token = device.deviceToken,
            proofHeader = true,
          ) =>
            fetch(`${url}/candidate`, {
              method: 'POST',
              headers: {
                authorization: `Device ${token}`,
                'idempotency-key':
                  'fileWriteReceiptId' in binding ? String(binding.fileWriteReceiptId) : idemKey(),
                'content-type': 'application/octet-stream',
                'x-whalepod-managed-candidate': Buffer.from(JSON.stringify(binding)).toString(
                  'base64url',
                ),
                ...(proofHeader ? { 'x-whalepod-managed-host': proof } : {}),
              },
              body: contents,
              redirect: 'error',
            })
          const sourceRequest = {
            commandId: offer.id,
            manifestDigest: payload.manifestDigest,
            requestId: randomUUID(),
          }
          expect((await devicePost('source', sourceRequest, false)).status).toBe(404)
          if (scenario === 'execution-reconnected') {
            const oldAttachment = nodeConnections.managedDraftConnectionId(host, true)
            let locked: (() => void) | undefined
            let unlock: (() => void) | undefined
            const outboxLocked = new Promise<void>((resolve) => {
              locked = resolve
            })
            const releaseOutbox = new Promise<void>((resolve) => {
              unlock = resolve
            })
            const locker = database.transaction(async (tx) => {
              await tx
                .select({ id: schema.dispatchOutbox.id })
                .from(schema.dispatchOutbox)
                .where(eq(schema.dispatchOutbox.id, offer.id))
                .for('update')
              locked?.()
              await releaseOutbox
            })
            try {
              await outboxLocked
              const blockedRead = devicePost('source', sourceRequest)
              await waitForValue(async () => {
                const [state] = await database.sql<{ waiting: boolean }[]>`
                  select exists (select 1 from pg_stat_activity
                    where pid <> pg_backend_pid() and wait_event_type = 'Lock'
                      and query like '%dispatch_outbox%') as waiting`
                return state?.waiting ? true : undefined
              }, 'source request waits for the outbox row lock')
              const replacement = await connect(wsUrl, device.deviceToken, proof)
              replacement.send(
                frame('node.hello', {
                  deviceId: device.deviceId,
                  platform: 'darwin',
                  architecture: 'arm64',
                  nodeVersion: '24.12.0',
                  supportedProtocolVersions: [1],
                  dshDistributionVersion: MANAGED_DRAFT_EXECUTION_VERSION,
                  pluginPackDigests: [],
                }),
              )
              await waitForValue(async () => {
                const attached = nodeConnections.managedDraftConnectionId(host, true)
                return attached === undefined || attached === oldAttachment ? undefined : attached
              }, 'replacement independently proves a new attachment')
              unlock?.()
              await locker
              const denied = await blockedRead
              expect(denied.status).toBe(404)
              expect(await denied.text()).not.toContain(SOURCE_MARKER)
              const [execution] = await database.db.select().from(schema.managedDraftExecutions)
              expect(execution).toMatchObject({
                connectionId: oldAttachment,
                sourceReadAt: null,
                modelDecidedAt: null,
              })
              expect(providerBodies).toEqual([])
            } finally {
              unlock?.()
              await locker
            }
            return
          }
          if (!packaged) {
            const frozen = await devicePost('source', sourceRequest)
            expect(frozen.status).toBe(200)
            expect(frozen.headers.get('cache-control')).toContain('no-store')
            const sourceText = await frozen.text()
            expect(sourceText).toContain(SOURCE_MARKER)
            expect(
              (await devicePost('source', { ...sourceRequest, requestId: randomUUID() })).status,
            ).toBe(404)
            const modelBytes = Buffer.from(buildManagedDraftModelBody(modelRoute.model, sourceText))
            const modelRequest = {
              commandId: offer.id,
              manifestDigest: payload.manifestDigest,
              modelBindingDigest: payload.manifest.modelBindingDigest,
              attemptId: randomUUID(),
              requestDigest: createHash('sha256').update(modelBytes).digest('hex'),
              byteSize: modelBytes.length,
            }
            expect(
              (await devicePost('model', { ...modelRequest, requestDigest: '0'.repeat(64) }))
                .status,
            ).toBe(404)
            const outputDigest = createHash('sha256').update(MODEL_OUTPUT).digest('hex')
            const writeProof = {
              commandId: offer.id,
              manifestDigest: payload.manifestDigest,
              modelAttemptId: modelRequest.attemptId,
              fileWriteReceiptId: randomUUID(),
              sha256: outputDigest,
              byteSize: Buffer.byteLength(MODEL_OUTPUT),
            }
            const revoke = async () =>
              expect(
                (
                  await apiInject(ctx, alice, {
                    method: 'DELETE',
                    url: `${sourceUrl}/${sourceId}`,
                  })
                ).statusCode,
              ).toBe(204)
            if (scenario === 'execution-revoked') {
              await revoke()
              expect((await devicePost('model', modelRequest)).status).toBe(404)
              expect(providerBodies).toEqual([])
            } else if (
              scenario === 'execution-upload-revoked' ||
              scenario === 'execution-upload-incomplete'
            ) {
              expect((await candidatePost(writeProof, MODEL_OUTPUT)).status).toBe(404)
              const modelResult = await devicePost('model', modelRequest)
              expect(modelResult.status).toBe(200)
              expect(((await modelResult.json()) as { data: unknown }).data).toEqual({
                attemptId: modelRequest.attemptId,
                text: MODEL_OUTPUT,
              })
              expect(
                (await candidatePost(writeProof, MODEL_OUTPUT, other.deviceToken)).status,
              ).toBe(404)
              expect(
                (await candidatePost(writeProof, MODEL_OUTPUT, device.deviceToken, false)).status,
              ).toBe(404)
              expect(
                (await candidatePost({ ...writeProof, modelAttemptId: randomUUID() }, MODEL_OUTPUT))
                  .status,
              ).toBe(404)
              expect(
                (await candidatePost({ ...writeProof, title: SOURCE_MARKER }, MODEL_OUTPUT)).status,
              ).toBe(404)
              expect((await candidatePost(writeProof, 'not the model output')).status).toBe(404)
              const old = 'old workspace bytes'
              expect(
                (
                  await candidatePost(
                    {
                      ...writeProof,
                      sha256: createHash('sha256').update(old).digest('hex'),
                      byteSize: Buffer.byteLength(old),
                    },
                    old,
                  )
                ).status,
              ).toBe(404)
              if (scenario === 'execution-upload-revoked') {
                await revoke()
                const denied = await candidatePost(writeProof, MODEL_OUTPUT)
                expect(denied.status).toBe(404)
                expect(await denied.text()).not.toContain(MODEL_OUTPUT)
                expect(await database.db.select().from(schema.managedDraftCandidates)).toEqual([])
                await expect(
                  stat(join(ctx.config.artifactStoreDir, 'managed-drafts')),
                ).rejects.toMatchObject({ code: 'ENOENT' })
              } else {
                const sendOutcome = (artifactId: string, verifiedUploadReceiptId: string) =>
                  dedicated?.send(
                    frame('managed_draft.outcome', {
                      commandId: offer.id,
                      runId,
                      manifestDigest: payload.manifestDigest,
                      attemptId: modelRequest.attemptId,
                      outcome: 'completed',
                      artifactId,
                      verifiedUploadReceiptId,
                    }),
                  )
                sendOutcome(randomUUID(), randomUUID())
                const accepted = await candidatePost(writeProof, MODEL_OUTPUT)
                expect(accepted.status, await accepted.clone().text()).toBe(201)
                const receipt = ManagedDraftCandidateProofSchema.parse(
                  ((await accepted.json()) as { data: unknown }).data,
                )
                sendOutcome(receipt.artifactId, randomUUID())
                expect((await candidatePost(writeProof, MODEL_OUTPUT)).status).toBe(404)
                expect(
                  (
                    await candidatePost(
                      { ...writeProof, fileWriteReceiptId: randomUUID() },
                      MODEL_OUTPUT,
                    )
                  ).status,
                ).toBe(404)
                expect((await run())?.status).toBe('running')
                const candidates = await get('/api/v1/managed-draft-candidates')
                expect(candidates.statusCode).toBe(200)
                expect(candidates.json().data).toEqual([])
                expect(await database.db.select().from(schema.managedDraftCandidates)).toEqual([
                  expect.objectContaining(receipt),
                ])
                await revoke()
                sendOutcome(receipt.artifactId, receipt.verifiedUploadReceiptId)
                expect((await candidatePost(writeProof, MODEL_OUTPUT)).status).toBe(404)
                // A deliberately invalid next frame closes only after queued outcomes are processed.
                const drained = once(dedicated!, 'close')
                dedicated!.send(frame('unregistered.test-barrier', {}))
                expect((await drained)[0]).toBe(4003)
                expect((await run())?.status).toBe('running')
              }
            } else {
              // Hold the real provider response. Replays and revocation must finish before it is released.
              const inFlight = devicePost('model', modelRequest)
              pendingModel = inFlight
              await waitForValue(
                async () => (providerBodies.length === 1 ? true : undefined),
                'first provider POST',
              )
              expect((await devicePost('model', modelRequest)).status).toBe(404)
              expect(
                (await devicePost('model', { ...modelRequest, attemptId: randomUUID() })).status,
              ).toBe(404)
              if (scenario === 'execution-in-flight-reconnect') {
                const replacement = await connect(wsUrl, device.deviceToken, proof)
                replacement.send(
                  frame('node.hello', {
                    deviceId: device.deviceId,
                    platform: 'darwin',
                    architecture: 'arm64',
                    nodeVersion: '24.12.0',
                    supportedProtocolVersions: [1],
                    dshDistributionVersion: MANAGED_DRAFT_EXECUTION_VERSION,
                    pluginPackDigests: [],
                  }),
                )
                await waitForValue(
                  async () => (providerDisconnected ? true : undefined),
                  'provider connection aborts on WebSocket replacement while model HTTP stays connected',
                )
              } else {
                await revoke()
              }
              releaseProvider?.()
              const denied = await inFlight
              expect(denied.status).toBe(404)
              expect(await denied.text()).not.toContain(MODEL_OUTPUT)
              expect(providerBodies).toHaveLength(1)
              const [execution] = await database.db.select().from(schema.managedDraftExecutions)
              expect(execution).toMatchObject({
                modelAttemptId: modelRequest.attemptId,
                modelDecidedAt: expect.any(Date),
                modelRespondedAt: null,
              })
              await expect(
                database.sql`update managed_draft_execution set model_attempt_id = ${randomUUID()} where run_id = ${runId}`,
              ).rejects.toMatchObject({
                code: '23514',
                constraint_name: 'managed_draft_execution_receipt_immutable',
              })
            }
          } else {
            await waitForValue(
              async () => ((await run())?.status === 'completed' ? true : undefined),
              'isolated runtime confirmed private execution',
              { timeoutMs: 18_000 },
            )
            expect(providerBodies).toHaveLength(1)
            expect(JSON.parse(providerBodies[0]!.toString('utf8'))).toMatchObject({
              model: modelRoute.model,
              max_tokens: 1024,
              messages: [
                { role: 'system' },
                { role: 'user', content: expect.stringContaining(SOURCE_MARKER) },
              ],
            })
            const [execution] = await database.db.select().from(schema.managedDraftExecutions)
            expect(execution).toMatchObject({
              runId,
              sourceReadAt: expect.any(Date),
              modelDecidedAt: expect.any(Date),
              modelRespondedAt: expect.any(Date),
              modelResponseSha256: createHash('sha256').update(MODEL_OUTPUT).digest('hex'),
              modelResponseByteSize: Buffer.byteLength(MODEL_OUTPUT),
              modelRequestDigest: createHash('sha256').update(providerBodies[0]!).digest('hex'),
            })
            expect(
              (
                await devicePost('model', {
                  commandId: offer.id,
                  manifestDigest: payload.manifestDigest,
                  modelBindingDigest: payload.manifest.modelBindingDigest,
                  attemptId: execution?.modelAttemptId,
                  requestDigest: execution?.modelRequestDigest,
                  byteSize: providerBodies[0]!.length,
                })
              ).status,
            ).toBe(404)
            expect(providerBodies).toHaveLength(1)
            const artifacts = await database.db.select().from(schema.artifacts)
            expect(artifacts).toEqual([
              expect.objectContaining({
                runId,
                status: 'candidate',
                sourceRelativePath: null,
                sha256: createHash('sha256').update(MODEL_OUTPUT).digest('hex'),
                byteSize: Buffer.byteLength(MODEL_OUTPUT),
              }),
            ])
            const artifact = artifacts[0]!
            const [candidate] = await database.db.select().from(schema.managedDraftCandidates)
            expect(candidate).toMatchObject({
              artifactId: artifact.id,
              runId,
              sourcePolicyId: sourceId,
              manifestDigest: payload.manifestDigest,
              modelAttemptId: execution?.modelAttemptId,
              sha256: artifact.sha256,
              byteSize: artifact.byteSize,
              fileWriteReceiptId: expect.any(String),
              verifiedUploadReceiptId: expect.any(String),
              verifiedAt: expect.any(Date),
            })
            expect(candidate?.fileWriteReceiptId).not.toBe(candidate?.verifiedUploadReceiptId)
            const stored = await managedDraftCandidateStore(
              ctx.config.artifactStoreDir,
            ).readVerified(artifact.storageKey, artifact.sha256)
            expect(stored).toEqual(Buffer.from(MODEL_OUTPUT))
            await expect(
              database.sql`update managed_draft_candidate set sha256 = ${'0'.repeat(64)} where run_id = ${runId}`,
            ).rejects.toMatchObject({
              code: '23514',
              constraint_name: 'managed_draft_candidate_receipt_immutable',
            })
            await expect(
              database.sql`update managed_draft_execution set model_response_sha256 = ${'0'.repeat(64)} where run_id = ${runId}`,
            ).rejects.toMatchObject({
              code: '23514',
              constraint_name: 'managed_draft_execution_response_immutable',
            })
            for (const reader of [alice, bob]) {
              for (const path of [
                `/api/v1/artifacts/${artifact.id}/content`,
                `/api/v1/runs/${runId}/events`,
                `/api/v1/runs/${runId}/handoff-draft`,
              ]) {
                expect(
                  (await apiInject(ctx, reader, { method: 'GET', url: path })).statusCode,
                ).toBe(404)
              }
              const room = await apiInject(ctx, reader, {
                method: 'GET',
                url: `/api/v1/tasks/${taskId}`,
              })
              expect(room.statusCode).toBe(200)
              for (const marker of [artifact.id, artifact.sha256, artifact.title, MODEL_OUTPUT])
                expect(room.body).not.toContain(marker)
            }
            expect((await post(`/api/v1/artifacts/${artifact.id}/publish`, {})).statusCode).toBe(
              404,
            )
            const workHistory = await get(workUrl)
            expect(workHistory.statusCode).toBe(200)
            const routerHistory = await get(`${workUrl}/router/evaluations`)
            expect(routerHistory.statusCode).toBe(200)
            const browser = new WebSocket(wsUrl.replace('/ws/v1/node', '/ws/v1/client?cursor=0'), {
              headers: { cookie: bob.cookie, origin: ctx.origin },
            })
            sockets.push(browser)
            const teamFrames: ClientFrame[] = []
            browser.on('message', (raw) =>
              teamFrames.push(parseClientFrame(JSON.parse(String(raw)))),
            )
            await once(browser, 'open')
            await waitForValue(
              async () =>
                teamFrames.find((value) => {
                  if (value.kind !== 'persistent' || value.event.type !== 'run.changed')
                    return false
                  const payload = value.event.payload
                  return (
                    typeof payload === 'object' &&
                    payload !== null &&
                    !Array.isArray(payload) &&
                    payload['runId'] === runId &&
                    payload['status'] === 'completed'
                  )
                }),
              'B receives only fixed Run status from normal team WebSocket replay',
            )
            for (const marker of [
              artifact.id,
              artifact.sha256,
              artifact.title,
              MODEL_OUTPUT,
              candidate!.fileWriteReceiptId,
              candidate!.verifiedUploadReceiptId,
            ]) {
              expect(workHistory.body).not.toContain(marker)
              expect(routerHistory.body).not.toContain(marker)
              expect(JSON.stringify(teamFrames)).not.toContain(marker)
            }
            const verifyRecipient =
              scenario === 'execution-review'
                ? verifyManagedDraftReviewInvalidation
                : verifyManagedDraftRecipient
            await verifyRecipient(ctx, database, {
              alice,
              bob,
              taskId,
              runId,
              artifactId: artifact.id,
              body: MODEL_OUTPUT,
              sourceId,
              workKey: work.json().data.workKey as string,
            })
          }
          expect(ordinaryFrames).toEqual([])
          if (!packaged && scenario !== 'execution-upload-incomplete')
            expect(await database.db.select().from(schema.artifacts)).toEqual([])
          return
        }
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
        releaseProvider?.()
        await pendingModel?.catch(() => undefined)
        if (modelServer !== undefined) {
          modelServer.closeAllConnections()
          await new Promise<void>((resolve) => modelServer?.close(() => resolve()))
        }
      }
    },
    30_000,
  )

  it('pins content, a named recipient and model route; version drift invalidates without changing old bytes', async () => {
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
    expect(await activateManagedDraftModelPolicy(database, MODEL_ROUTE)).toBe(true)
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
