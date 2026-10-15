import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  waitForValue,
  makeHarness,
  runEventFrame,
  type TestApp,
  type Session,
} from './helpers.js'

let db: Database
let ctx: TestApp
let owner: Session
let socket: WebSocket
let taskId: string
let agentId: string
let deviceId: string
let deviceToken: string
let workspaceId: string
let harness: ReturnType<typeof makeHarness>

async function command(url: string, payload: object = {}, key = randomUUID()) {
  return apiInject(ctx, owner, {
    method: 'POST',
    url: `/api/v1${url}`,
    payload,
    idempotencyKey: key,
  })
}
async function pair() {
  const code = await command('/devices/pairing-codes')
  const claim = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/devices/pairing-claims',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      code: code.json().data.code,
      name: `snapshot-node-${randomUUID().slice(0, 8)}`,
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
    },
  })
  expect(claim.statusCode).toBe(201)
  return claim.json().data as { deviceId: string; deviceToken: string }
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
beforeEach(async () => {
  db = await createTestDatabase()
  await resetDatabase(db)
  ctx = await createTestApp(db)
  owner = await driveSetup(ctx)
  const packs = await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/plugin-packs' })
  const pack = packs.json().data.find((p: { name: string }) => p.name === 'core-empty')
  expect(pack).toBeDefined()
  const agent = await command('/agents', {
    name: 'snapshot-agent',
    persona: 'Review the selected inputs.',
    provider: 'fixture',
    model: 'fixture',
    credentialSlot: 'default',
    pluginPackId: pack.id,
  })
  expect(agent.statusCode).toBe(201)
  agentId = agent.json().data.id
  const project = await command('/projects', { name: 'input-snapshot' })
  const task = await command(`/projects/${project.json().data.id}/tasks`, {
    title: 'input-snapshot',
    assigneeUserId: owner.userId,
  })
  taskId = task.json().data.id
  expect((await command(`/tasks/${taskId}/accept`)).statusCode).toBe(200)
  const paired = await pair()
  deviceId = paired.deviceId
  deviceToken = paired.deviceToken
  workspaceId = randomUUID()
  await ctx.app.listen({ host: '127.0.0.1', port: 0 })
  const address = ctx.app.server.address()
  if (address === null || typeof address === 'string') throw new Error('listen missing')
  socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/v1/node`, {
    headers: { authorization: `Device ${deviceToken}` },
  })
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
      dshDistributionVersion: 'snapshot-fixture',
      pluginPackDigests: [],
    }),
  )
  socket.send(
    frame('node.inventory', {
      deviceId,
      workspaces: [
        {
          workspaceId,
          name: 'private-work',
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
      (await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/workspaces' }))
        .json()
        .data.find((w: { workspaceId: string }) => w.workspaceId === workspaceId),
    'workspace through inventory',
  )
  harness = makeHarness(db)
  harness.clock.advance(Date.now() - harness.clock.now().getTime())
})
afterEach(async () => {
  socket?.terminate()
  await ctx.close()
  await db.close()
})
async function start(extra: object = {}, key = randomUUID()) {
  return command(
    `/tasks/${taskId}/runs`,
    { agentId, deviceId, workspaceId, prompt: 'Check input snapshot.', ...extra },
    key,
  )
}
async function started(extra: object = {}) {
  const response = await start(extra)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().data.id as string
}
async function finish(runId: string) {
  harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
  await harness.worker.dispatchOnce()
  const device = { deviceId, ownerUserId: owner.userId }
  for (const ack of harness.gateway.drainUpstream())
    await harness.orchestrator.ingestNodeEvent(device, ack)
  await harness.orchestrator.ingestNodeEvent(
    device,
    runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `snapshot-${runId}` }),
  )
  await harness.orchestrator.ingestNodeEvent(
    device,
    runEventFrame(runId, 2, { type: 'run.completed', finalText: 'done' }),
  )
}
async function upload(runId: string, title: string, publish = true) {
  const bytes = Buffer.from(`Content of ${title}`)
  const query = new URLSearchParams({
    title,
    mediaType: 'text/plain',
    byteSize: String(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceRelativePath: 'report.txt',
  })
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/node/runs/${runId}/artifacts?${query}`,
    headers: {
      authorization: `Device ${deviceToken}`,
      'content-type': 'application/octet-stream',
      'idempotency-key': randomUUID(),
    },
    payload: bytes,
  })
  expect(response.statusCode, response.body).toBe(201)
  const id = response.json().data.id as string
  if (publish) expect((await command(`/artifacts/${id}/publish`)).statusCode).toBe(200)
  return id
}
async function manifest(runId: string, token = deviceToken) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/node/runs/${runId}/input-manifest`,
    headers: { authorization: `Device ${token}` },
  })
}
describe('immutable run input manifest (#325)', () => {
  it('empty at creation stays empty; late publication never changes an old reviewer snapshot', async () => {
    const producer = await started()
    const first = await upload(producer, 'first report')
    expect((await manifest(producer)).json().data.artifacts).toEqual([])
    await finish(producer)
    const reviewer = await started()
    const before = (await manifest(reviewer)).json().data
    expect(before.artifacts.map((a: { artifactId: string }) => a.artifactId)).toEqual([first])
    await upload(producer, 'late report')
    expect((await manifest(reviewer)).json().data).toEqual(before)
    const memberView = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/runs/${reviewer}/input-manifest`,
    })
    expect(memberView.statusCode).toBe(200)
    expect(memberView.json().data).toEqual(before)
    expect(JSON.stringify(before)).not.toMatch(/storageKey|sourceRelativePath|canonicalPath/)
  })
  it('explicit subset and request order are fixed, including an explicit empty input', async () => {
    const producer = await started()
    const a = await upload(producer, 'a')
    const b = await upload(producer, 'b')
    await finish(producer)
    const selected = await started({ artifactInputIds: [b, a] })
    expect(
      (await manifest(selected))
        .json()
        .data.artifacts.map((row: { artifactId: string }) => row.artifactId),
    ).toEqual([b, a])
    await command(`/runs/${selected}/cancel`)
    const empty = await started({ artifactInputIds: [] })
    expect((await manifest(empty)).json().data.artifacts).toEqual([])
  })
  it('accepts uppercase material UUIDs and rejects mixed-case duplicates without changing snapshots', async () => {
    const producer = await started()
    const id = await upload(producer, 'case-insensitive identity')
    await finish(producer)
    const selected = await started({ artifactInputIds: [id.toUpperCase()] })
    const before = (await manifest(selected)).json().data
    expect(before.artifacts.map((row: { artifactId: string }) => row.artifactId)).toEqual([id])
    await finish(selected)
    for (const url of [`/tasks/${taskId}/runs`, `/tasks/${taskId}/instructions`]) {
      const duplicate = await command(
        url,
        url.endsWith('/runs')
          ? {
              agentId,
              deviceId,
              workspaceId,
              prompt: 'duplicate',
              artifactInputIds: [id, id.toUpperCase()],
            }
          : {
              agentId,
              text: 'duplicate',
              intent: { kind: 'new' },
              artifactInputIds: [id, id.toUpperCase()],
            },
      )
      expect(duplicate.statusCode, duplicate.body).toBe(400)
    }
    const unified = await command(`/tasks/${taskId}/instructions`, {
      agentId,
      text: 'uppercase',
      intent: { kind: 'new' },
      artifactInputIds: [id.toUpperCase()],
    })
    expect(unified.statusCode, unified.body).toBe(201)
    expect(
      (await manifest(unified.json().data.runId))
        .json()
        .data.artifacts.map((row: { artifactId: string }) => row.artifactId),
    ).toEqual([id])
    expect((await manifest(selected)).json().data).toEqual(before)
  })
  it('candidate, unknown and artifacts on another task cannot be selected', async () => {
    const producer = await started()
    const candidate = await upload(producer, 'private candidate', false)
    const published = await upload(producer, 'published')
    await finish(producer)
    for (const id of [candidate, randomUUID()]) {
      const denied = await start({ artifactInputIds: [id] })
      expect(denied.statusCode).toBe(404)
      expect(denied.json().error.code).toBe('NOT_FOUND')
    }
    const originalTask = taskId
    const project = await command('/projects', { name: 'other' })
    const task = await command(`/projects/${project.json().data.id}/tasks`, {
      title: 'other',
      assigneeUserId: owner.userId,
    })
    taskId = task.json().data.id
    await command(`/tasks/${taskId}/accept`)
    expect((await start({ artifactInputIds: [published] })).statusCode).toBe(404)
    taskId = originalTask
  })
  it('idempotent create replay retains the original snapshot after another publication', async () => {
    const producer = await started()
    const a = await upload(producer, 'before')
    await finish(producer)
    const key = randomUUID()
    const first = await start({}, key)
    expect(first.statusCode).toBe(201)
    await upload(producer, 'after')
    const replay = await start({}, key)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data.id).toBe(first.json().data.id)
    expect(
      (await manifest(replay.json().data.id))
        .json()
        .data.artifacts.map((r: { artifactId: string }) => r.artifactId),
    ).toEqual([a])
  })
  it('over 64 default inputs fail before creating a run; a bounded explicit subset still works', async () => {
    const producer = await started()
    const ids: string[] = []
    for (let i = 0; i < 65; i++) ids.push(await upload(producer, `report-${i}`))
    await finish(producer)
    const denied = await start()
    expect(denied.statusCode).toBe(409)
    expect(denied.json().error.code).toBe('ARTIFACT_INPUT_MANIFEST_TOO_LARGE')
    const selected = await started({ artifactInputIds: [ids[0]] })
    expect((await manifest(selected)).json().data.artifacts).toHaveLength(1)
  })
  it('resume and rerun inherit old inputs unless the new execution explicitly selects different published feedback', async () => {
    const producer = await started()
    const a = await upload(producer, 'original')
    await finish(producer)
    const reviewer = await started()
    await finish(reviewer)
    const feedback = await upload(reviewer, 'feedback')
    const resumed = await started({ resumeFromRunId: reviewer })
    expect(
      (await manifest(resumed))
        .json()
        .data.artifacts.map((r: { artifactId: string }) => r.artifactId),
    ).toEqual([a])
    await finish(resumed)
    const rerun = await started({ rerunOfRunId: reviewer, artifactInputIds: [feedback] })
    expect(
      (await manifest(rerun))
        .json()
        .data.artifacts.map((r: { artifactId: string }) => r.artifactId),
    ).toEqual([feedback])
    expect(
      (await manifest(reviewer))
        .json()
        .data.artifacts.map((r: { artifactId: string }) => r.artifactId),
    ).toEqual([a])
  })
  it('another device cannot read the snapshot of a run it does not carry', async () => {
    const run = await started()
    const second = await pair()
    expect((await manifest(run, second.deviceToken)).statusCode).toBe(404)
  })
  it('unified explicit new execution accepts a selection, while followup and implicit routing reject it', async () => {
    const response = await command(`/tasks/${taskId}/instructions`, {
      text: 'review',
      agentId,
      artifactInputIds: [],
      intent: { kind: 'new' },
    })
    expect(response.statusCode, response.body).toBe(201)
    const runId = response.json().data.runId as string
    expect((await manifest(runId)).json().data.artifacts).toEqual([])
    expect(
      (
        await command(`/tasks/${taskId}/instructions`, {
          text: 'change inputs',
          artifactInputIds: [],
          intent: { kind: 'followup', runId },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await command(`/tasks/${taskId}/instructions`, {
          text: 'implicit inputs',
          artifactInputIds: [],
        })
      ).statusCode,
    ).toBe(400)
  })
})
