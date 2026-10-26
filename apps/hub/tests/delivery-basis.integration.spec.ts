/** #440: all runtime facts are driven by HTTP, device upload and protocol frames. */
import { emptyHandoffNarrative } from '@whalepod/protocol'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  driveInviteAndAccept,
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
let reviewer: Session
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
  reviewer = (
    await driveInviteAndAccept(ctx, owner, {
      username: 'basis-reviewer',
      displayName: 'Reviewer',
      password: 'correct horse battery staple',
    })
  ).session
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
async function basis(artifactId: string, session = reviewer) {
  return apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/artifacts/${artifactId}/delivery-basis`,
  })
}
async function confirmGoal(goal: string) {
  const content = {
    goal,
    constraints: '保留原始数据',
    acceptance: '检查重复字段',
    openQuestions: '真实数据尚未验证',
  }
  const draft = await command(`/tasks/${taskId}/agreement/draft`, { content })
  expect(draft.statusCode, draft.body).toBe(200)
  const confirmed = await command(`/tasks/${taskId}/agreement/confirm`, {
    draftVersion: draft.json().data.draftVersion,
  })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return confirmed.json().data
}
async function publishExplanation(runId: string, text: string, referenceId: string) {
  const draft = await command(`/runs/${runId}/handoff-draft`)
  expect(draft.statusCode, draft.body).toBe(201)
  const narrative = emptyHandoffNarrative()
  narrative.completed = [{ text, verified: false, refs: [] }]
  narrative.evidence = [
    {
      text: '样本结果由发布者核对，未验证全量数据',
      verified: true,
      refs: [{ kind: 'artifact', artifactId: referenceId }],
    },
  ]
  const edited = await apiInject(ctx, owner, {
    method: 'PATCH',
    url: `/api/v1/runs/${runId}/handoff-draft`,
    payload: { narrative, expectedDraftVersion: draft.json().data.draftVersion },
  })
  expect(edited.statusCode, edited.body).toBe(200)
  const published = await command(`/runs/${runId}/handoff-draft/publish`)
  expect(published.statusCode, published.body).toBe(201)
  return published.json().data
}

describe('artifact delivery basis HTTP (#440)', () => {
  it('pins the actual historical agreement and input, excludes unrelated handoffs, and keeps verification scope', async () => {
    const materialRun = await started({ artifactInputIds: [] })
    const material = await upload(materialRun, 'fixed input')
    await finish(materialRun)
    await apiInject(ctx, owner, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { agreementEnabled: true },
    })
    const original = await confirmGoal('历史要求：按样本处理')
    const producer = await started({ artifactInputIds: [material] })
    const output = await upload(producer, 'delivered result')
    const privateOutput = await upload(producer, 'private candidate must not leak', false)
    await finish(producer)
    const newer = await confirmGoal('新要求：正式全量处理')
    expect(newer.id).not.toBe(original.id)
    const otherRun = await started({ artifactInputIds: [] })
    const otherOutput = await upload(otherRun, 'same task other run')
    await finish(otherRun)
    await publishExplanation(otherRun, 'OTHER RUN DO NOT ATTACH', otherOutput)
    const before = await basis(output)
    expect(before.statusCode, before.body).toBe(200)
    expect(before.headers['cache-control']).toBe('no-store')
    expect(before.json().data.agreement.revision.id).toBe(original.id)
    expect(before.json().data.agreement.revision.content.goal).toBe('历史要求：按样本处理')
    expect(
      before
        .json()
        .data.taskInputs.artifacts.map((item: { artifactId: string }) => item.artifactId),
    ).toEqual([material])
    expect(before.json().data.handoffs).toEqual([])
    expect(before.body).not.toContain(newer.id)
    expect(before.body).not.toContain('OTHER RUN DO NOT ATTACH')
    const published = await publishExplanation(producer, '准确的成果交接说明', material)
    const after = await basis(output)
    const value = after.json().data
    expect(value.sourceRun.id).toBe(producer)
    expect(value.handoffs.map((row: { id: string }) => row.id)).toEqual([published.id])
    expect(value.handoffs[0].narrative.completed[0].verified).toBe(false)
    expect(value.handoffs[0].narrative.evidence[0].verified).toBe(true)
    expect(value.handoffs[0].narrative.evidence[0].text).toContain('未验证全量数据')
    expect(after.body).not.toMatch(
      /sourceRelativePath|storageKey|canonicalPath|credentialSlot|dshSessionId/,
    )
    expect(after.body).not.toContain(privateOutput)
    expect(after.body).not.toContain('private candidate must not leak')
    expect((await basis(privateOutput)).statusCode).toBe(404)
    expect((await basis(privateOutput, owner)).statusCode).toBe(200)
  })
  it('a confirmed empty input stays empty after later publication; missing handoff is not invented', async () => {
    const producer = await started({ artifactInputIds: [] })
    const output = await upload(producer, 'empty input output')
    await finish(producer)
    await upload(producer, 'published after the run')
    const response = await basis(output)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data).toMatchObject({
      artifactId: output,
      sourceRun: { id: producer },
      agreement: { status: 'unbound', revision: null },
      taskInputs: { status: 'recorded', complete: true, artifacts: [] },
      handoffInputs: { status: 'not_selected', complete: true, artifacts: [] },
      handoffs: [],
    })
    expect((await basis(randomUUID())).statusCode).toBe(404)
  })
})
