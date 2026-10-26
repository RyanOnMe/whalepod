import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { eq } from 'drizzle-orm'
import { claimArtifactRevisionRoundStart, getArtifactRevisionRound, schema } from '@whalepod/db'
import { RunOrchestrator } from '../src/modules/run/orchestrator.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let bob: Session
let admin: Session
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
  bob = (
    await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
  ).session
  admin = (
    await driveInviteAndAccept(
      ctx,
      owner,
      { username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' },
      'admin',
    )
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
async function ready(runId: string) {
  harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
  await harness.worker.dispatchOnce()
  const device = { deviceId, ownerUserId: owner.userId }
  for (const ack of harness.gateway.drainUpstream())
    await harness.orchestrator.ingestNodeEvent(device, ack)
  await harness.orchestrator.ingestNodeEvent(
    device,
    runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `snapshot-${runId}` }),
  )
}
async function finish(runId: string) {
  await ready(runId)
  await harness.orchestrator.ingestNodeEvent(
    { deviceId, ownerUserId: owner.userId },
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

interface Item {
  kind: string
  taskId: string
  objectId: string
  runId: string | null
  taskTitle: string
  projectName: string
  createdAt: string
}
async function attention(session = owner, suffix = '') {
  return apiInject(ctx, session, { method: 'GET', url: `/api/v1/tasks/attention${suffix}` })
}
async function items(session = owner): Promise<Item[]> {
  const r = await attention(session)
  expect(r.statusCode, r.body).toBe(200)
  return r.json().data.items
}
async function assigned(session = bob) {
  const project = await command('/projects', { name: `attention-${randomUUID()}` })
  const task = await command(`/projects/${project.json().data.id}/tasks`, {
    title: '需要行动的任务',
    assigneeUserId: session.userId,
  })
  expect(task.statusCode, task.body).toBe(201)
  return task.json().data.id as string
}
async function as(session: Session, path: string, payload = {}) {
  return apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1${path}`,
    payload,
    idempotencyKey: randomUUID(),
  })
}
async function approval(expiresAt = new Date(Date.now() + 600000).toISOString()) {
  const run = await started()
  await ready(run)
  const id = randomUUID()
  await harness.orchestrator.ingestNodeEvent(
    { deviceId, ownerUserId: owner.userId },
    runEventFrame(run, 2, {
      type: 'approval.requested',
      approval: {
        approvalId: id,
        runId: run,
        callId: randomUUID(),
        toolName: 'bash',
        reason: 'private reason',
        preview: { command: 'private command' },
        status: 'pending',
        requestedAt: new Date().toISOString(),
        expiresAt,
      },
    }),
  )
  return { run, id }
}
describe('personal attention via production commands (#331)', () => {
  it('requires a session; a viewer override cannot select another member; response is private and empty', async () => {
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/tasks/attention' })).statusCode,
    ).toBe(401)
    const task = await assigned()
    const r = await attention(owner, `?userId=${bob.userId}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('private, no-store')
    expect(r.json().data).toEqual({ items: [], hasMore: false })
    expect((await items(bob))[0]).toMatchObject({
      kind: 'accept_assignment',
      taskId: task,
      objectId: task,
    })
  })
  it('disabled members cannot use a previously issued session to read their queue', async () => {
    await assigned()
    expect((await command(`/team/members/${bob.userId}/disable`)).statusCode).toBe(200)
    expect((await attention(bob)).statusCode).toBe(401)
  })
  it('accept/reject/reassign update the actual actor actions; members never gain admin repair work', async () => {
    const task = await assigned()
    expect((await as(bob, `/tasks/${task}/reject`)).statusCode).toBe(200)
    expect(await items(bob)).toEqual([])
    for (const who of [owner, admin])
      expect(await items(who)).toEqual([
        expect.objectContaining({ kind: 'reassign_task', taskId: task }),
      ])
    expect(
      (await command(`/tasks/${task}/reassign`, { assigneeUserId: bob.userId })).statusCode,
    ).toBe(200)
    expect(await items(owner)).toEqual([])
    expect((await items(bob))[0]?.kind).toBe('accept_assignment')
    expect((await as(bob, `/tasks/${task}/accept`)).statusCode).toBe(200)
    expect(await items(bob)).toEqual([])
  })
  it('candidate ownership survives handoff; no title, count or ID leaks to the new assignee or admin', async () => {
    const run = await started()
    const id = await upload(run, 'private candidate name', false)
    await finish(run)
    expect(
      (await command(`/tasks/${taskId}/reassign`, { assigneeUserId: bob.userId })).statusCode,
    ).toBe(200)
    expect(await items(owner)).toEqual([
      expect.objectContaining({ kind: 'inspect_candidate', objectId: id, runId: run }),
    ])
    for (const who of [bob, admin]) {
      const r = await attention(who)
      expect(r.body).not.toContain(id)
      expect(r.body).not.toContain('private candidate name')
      expect(r.json().data.hasMore).toBe(false)
      expect(r.json().data.items.some((i: Item) => i.kind === 'inspect_candidate')).toBe(false)
    }
    expect((await command(`/artifacts/${id}/publish`)).statusCode).toBe(200)
    expect(await items(owner)).toEqual([])
  })
  it('only pending unexpired approval on the carried waiting Run is actionable; a grant is not approval rights', async () => {
    const card = await approval()
    expect(
      (await command(`/tasks/${taskId}/instruction-grants`, { userId: bob.userId })).statusCode,
    ).toBe(201)
    expect(await items(owner)).toEqual([
      expect.objectContaining({ kind: 'decide_approval', objectId: card.id, runId: card.run }),
    ])
    expect(await items(bob)).toEqual([])
    expect(await items(admin)).toEqual([])
    const r = await attention(owner)
    expect(r.body).not.toMatch(
      /private reason|private command|preview|workspace|dshSession|storageKey|sourceRelativePath/,
    )
    expect(
      (await command(`/approvals/${card.id}/decisions`, { decision: 'allowed_once' })).statusCode,
    ).toBe(200)
    expect(await items(owner)).toEqual([])
  })
  it('expired pending approvals are excluded even before cleanup', async () => {
    await approval(new Date(Date.now() - 1000).toISOString())
    expect(await items(owner)).toEqual([])
  })
  it('human completion appears only in accepted in_review, and disappears on completion', async () => {
    const run = await started()
    await upload(run, 'published')
    await finish(run)
    expect(await items(owner)).toEqual([])
    expect((await command(`/tasks/${taskId}/submit-review`)).statusCode).toBe(200)
    expect(await items(owner)).toEqual([
      expect.objectContaining({ kind: 'complete_task', taskId, objectId: taskId }),
    ])
    expect(await items(bob)).toEqual([])
    expect((await command(`/tasks/${taskId}/complete`)).statusCode).toBe(200)
    expect(await items(owner)).toEqual([])
  })
  it('terminal tasks do not retain pending or candidate reminders', async () => {
    const pending = await assigned()
    expect((await as(bob, `/tasks/${pending}/accept`)).statusCode).toBe(200)
    expect((await as(bob, `/tasks/${pending}/cancel`)).statusCode).toBe(200)
    expect(await items(bob)).toEqual([])
    const run = await started()
    await upload(run, 'left candidate', false)
    await finish(run)
    expect((await command(`/tasks/${taskId}/cancel`)).statusCode).toBe(200)
    expect(await items(owner)).toEqual([])
  })
  it('limits after viewer filtering, has truthful overflow and deterministic deduplicated order', async () => {
    for (let i = 0; i < 13; i++) await assigned()
    const first = await attention(bob)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().data.items).toHaveLength(12)
    expect(first.json().data.hasMore).toBe(true)
    expect((await attention(bob)).json().data).toEqual(first.json().data)
    expect(new Set(first.json().data.items.map((i: Item) => `${i.kind}:${i.objectId}`)).size).toBe(
      12,
    )
    expect((await attention(owner)).json().data).toEqual({ items: [], hasMore: false })
    const card = await approval()
    const mine = await assigned(owner)
    const ordered = await items(owner)
    expect(ordered.map((i) => i.kind)).toEqual(['decide_approval', 'accept_assignment'])
    expect(ordered[0]?.objectId).toBe(card.id)
    expect(ordered[1]?.objectId).toBe(mine)
  })
})

// #430: drive the loop through the same HTTP/Node-event path as a real member.
it('审阅反馈 → 固定批次 → 启动 → 私有候选 → 发布 → 作者复核；待办与完成提示随事实变化', async () => {
  const sourceRun = await started()
  await finish(sourceRun)
  const source = await upload(sourceRun, 'review-source.md')
  const commentReply = await as(bob, `/artifacts/${source}/comments`, { body: '请补充边界条件' })
  expect(commentReply.statusCode, commentReply.body).toBe(201)
  const commentId = commentReply.json().data.id
  const ownerFeedback = () =>
    items(owner).then((rows) => rows.filter((row) => row.kind === 'organize_feedback'))
  const bobResolve = () =>
    items(bob).then((rows) => rows.filter((row) => row.kind === 'resolve_comments'))
  expect(await ownerFeedback()).toMatchObject([{ objectId: source, taskId, runId: null }])
  expect(await bobResolve()).toEqual([])
  const created = await command(`/tasks/${taskId}/artifact-revision-rounds`, {
    sourceArtifactId: source,
    commentIds: [commentId],
  })
  expect(created.statusCode, created.body).toBe(201)
  const roundId = created.json().data.id
  expect(await ownerFeedback()).toHaveLength(1) // freezing is not execution
  const launch = await command(`/artifact-revision-rounds/${roundId}/start`, {
    agentId,
    deviceId,
    workspaceId,
    resumeFromRunId: sourceRun,
  })
  expect(launch.statusCode, launch.body).toBe(200)
  const runId = launch.json().data.runId
  expect(await ownerFeedback()).toEqual([])
  await finish(runId)
  const candidate = await upload(runId, 'review-new.md', false)
  expect(
    (
      await command(`/artifact-revision-rounds/${roundId}/candidates`, {
        candidateArtifactId: candidate,
      })
    ).statusCode,
  ).toBe(200)
  expect(await bobResolve()).toEqual([])
  const privateView = await apiInject(ctx, bob, {
    method: 'GET',
    url: `/api/v1/artifact-revision-rounds/${roundId}`,
  })
  expect(privateView.statusCode).toBe(200)
  expect(privateView.json().data.candidate).toBeNull()
  expect((await command(`/artifacts/${candidate}/publish`)).statusCode).toBe(200)
  expect(await bobResolve()).toMatchObject([{ objectId: source, taskId, runId: null }])
  const room = () => apiInject(ctx, owner, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
  expect((await room()).json().data.reviewFeedback).toEqual({
    unresolvedCount: 1,
    artifactId: source,
  })
  const resolved = await as(bob, `/artifact-revision-rounds/${roundId}/resolutions`, {
    commentId,
    status: 'resolved',
  })
  expect(resolved.statusCode, resolved.body).toBe(200)
  expect(await bobResolve()).toEqual([])
  expect((await room()).json().data.reviewFeedback).toEqual({
    unresolvedCount: 0,
    artifactId: null,
  })
  expect(
    (
      await as(bob, `/artifact-revision-rounds/${roundId}/resolutions`, {
        commentId,
        status: 'needs_work',
      })
    ).statusCode,
  ).toBe(200)
  expect(await ownerFeedback()).toHaveLength(1)
  // An unresolved opinion is an explicit warning, not a new task-completion gate.
  expect((await command(`/tasks/${taskId}/submit-review`)).statusCode).toBe(200)
  expect((await command(`/tasks/${taskId}/complete`)).statusCode).toBe(200)
  expect(await ownerFeedback()).toEqual([])
  expect(await bobResolve()).toEqual([])
})

/** #430: all prerequisites use member HTTP / production Node protocol paths. */
async function reviewRoundForRecovery() {
  const sourceRun = await started()
  await finish(sourceRun)
  const source = await upload(sourceRun, 'recovery-source.md')
  const comment = await as(bob, `/artifacts/${source}/comments`, { body: '修订恢复时保持本轮意见' })
  expect(comment.statusCode, comment.body).toBe(201)
  const response = await command(`/tasks/${taskId}/artifact-revision-rounds`, {
    sourceArtifactId: source,
    commentIds: [comment.json().data.id],
  })
  expect(response.statusCode, response.body).toBe(201)
  return { sourceRun, source, roundId: response.json().data.id as string }
}
const revisionInput = () => ({ agentId, deviceId, workspaceId })
async function reviewRuns(roundId: string) {
  return (await db.db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId))).filter(
    (row) => row.reviewInput?.roundId === roundId,
  )
}

describe('revision start recovery via member HTTP (#430)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('legacy claim persisted before Run creation: retries recover one Run instead of staying starting', async () => {
    const { roundId } = await reviewRoundForRecovery()
    // Controlled old-process crash seam: execute the production claim and stop before
    // create. No Run/projection is inserted; delete when all old starting rows are retired.
    await claimArtifactRevisionRoundStart(db.db, roundId)
    expect((await getArtifactRevisionRound(db.db, roundId))?.status).toBe('starting')
    const first = await command(`/artifact-revision-rounds/${roundId}/start`, revisionInput())
    expect(first.statusCode, first.body).toBe(200)
    const repeated = await command(`/artifact-revision-rounds/${roundId}/start`, revisionInput())
    expect(repeated.statusCode, repeated.body).toBe(200)
    expect(repeated.json().data.runId).toBe(first.json().data.runId)
    expect(await reviewRuns(roundId)).toHaveLength(1)
  })

  it('failure after Run/outbox writes rolls the whole start back and permits a clean retry', async () => {
    const { roundId } = await reviewRoundForRecovery()
    const beforeOutbox = new Set(
      (await db.db.select().from(schema.dispatchOutbox)).map((row) => row.id),
    )
    type Operation = (...args: unknown[]) => Promise<unknown>
    const prototype = RunOrchestrator.prototype as unknown as Record<string, Operation>
    // The old implementation commits create() separately; the new thin entry stays in
    // the round's Tx. Fault only after the real production creation core has returned.
    const method = 'createWithinTransaction' in prototype ? 'createWithinTransaction' : 'create'
    const original = prototype[method]!
    const injected = vi.spyOn(prototype, method).mockImplementationOnce(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      await original.apply(this, args)
      throw new Error('CONTROLLED_REVIEW_START_ABORT')
    })
    const failed = await command(`/artifact-revision-rounds/${roundId}/start`, revisionInput())
    expect(failed.statusCode).toBe(500)
    injected.mockRestore()
    expect((await getArtifactRevisionRound(db.db, roundId))?.status).toBe('preparing')
    expect(await reviewRuns(roundId)).toHaveLength(0)
    const outbox = await db.db.select().from(schema.dispatchOutbox)
    expect(outbox.filter((row) => !beforeOutbox.has(row.id))).toHaveLength(0)
    const retry = await command(`/artifact-revision-rounds/${roundId}/start`, revisionInput())
    expect(retry.statusCode, retry.body).toBe(200)
    expect(await reviewRuns(roundId)).toHaveLength(1)
  })

  it.each(['same', 'different'] as const)(
    'parallel starts with %s keys all observe the same round Run',
    async (mode) => {
      const { roundId } = await reviewRoundForRecovery()
      const sharedKey = randomUUID()
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          command(
            `/artifact-revision-rounds/${roundId}/start`,
            revisionInput(),
            mode === 'same' ? sharedKey : randomUUID(),
          ),
        ),
      )
      for (const response of responses) expect(response.statusCode, response.body).toBe(200)
      expect(new Set(responses.map((response) => response.json().data.runId)).size).toBe(1)
      expect(await reviewRuns(roundId)).toHaveLength(1)
    },
  )

  it('rechecks the assignee after reassignment commits before the start transaction', async () => {
    const { roundId } = await reviewRoundForRecovery()
    const transaction = db.transaction.bind(db)
    const interleave: Database['transaction'] = async (execute, options) => {
      const reassigned = await command(`/tasks/${taskId}/reassign`, { assigneeUserId: bob.userId })
      expect(reassigned.statusCode, reassigned.body).toBe(200)
      return transaction(execute, options)
    }
    // Interleave after the route's initial actor read, before it obtains the Task lock.
    vi.spyOn(db, 'transaction').mockImplementationOnce(interleave)
    const denied = await command(`/artifact-revision-rounds/${roundId}/start`, revisionInput())
    expect(denied.statusCode, denied.body).toBe(403)
    expect(await reviewRuns(roundId)).toHaveLength(0)
    expect((await getArtifactRevisionRound(db.db, roundId))?.status).toBe('preparing')
  })

  it('legacy committed Run is rebound instead of creating another Run', async () => {
    const { roundId, source } = await reviewRoundForRecovery()
    const round = await getArtifactRevisionRound(db.db, roundId)
    expect(round).toBeDefined()
    // Controlled legacy crash seam: claim and use the same production orchestrator that
    // the old HTTP route used, then stop before round binding. No business-table insert.
    await claimArtifactRevisionRoundStart(db.db, roundId)
    const committed = await harness.orchestrator.create(
      { userId: owner.userId, role: 'owner' } as Parameters<RunOrchestrator['create']>[0],
      taskId,
      {
        idempotencyKey: randomUUID(),
        ...revisionInput(),
        prompt: '恢复已经提交的修订',
        artifactInputIds: [source],
        reviewInput: round!.input,
        dshDistributionVersion: 'snapshot-fixture',
      },
    )
    const recovered = await command(`/artifact-revision-rounds/${roundId}/start`, revisionInput())
    expect(recovered.statusCode, recovered.body).toBe(200)
    expect(recovered.json().data.runId).toBe(committed.id)
    expect(await reviewRuns(roundId)).toHaveLength(1)
  })
})
