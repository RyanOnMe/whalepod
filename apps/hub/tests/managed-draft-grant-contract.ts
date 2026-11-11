import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Outbox, type Database } from '@whalepod/db'
import { NodeDownstreamSchema } from '@whalepod/protocol'
import WebSocket from 'ws'
import { WsDeviceGateway } from '../src/modules/device/gateway.js'
import { OutboxWorker } from '../src/modules/run/outbox-worker.js'
import { sql } from 'drizzle-orm'
import { expect } from 'vitest'
import {
  apiInject,
  driveInviteAndAccept,
  idemKey,
  runEventFrame,
  type Session,
  type TestApp,
  waitForValue,
} from './helpers.js'

interface RecipientScenario {
  readonly alice: Session
  readonly bob: Session
  readonly taskId: string
  readonly runId: string
  readonly artifactId: string
  readonly body: string
  readonly sourceId: string
  readonly workKey?: string
}

function listenerOrigin(ctx: TestApp): string {
  const address = ctx.app.server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP HTTP fixture')
  return `http://127.0.0.1:${address.port}`
}

/** Called by the production managed upload scenario after real Node, Runtime and Hub complete. */
export async function verifyManagedDraftRecipient(
  ctx: TestApp,
  database: Database,
  { alice, bob, taskId, runId, artifactId, body, sourceId }: RecipientScenario,
): Promise<void> {
  const invite = async (name: string, role: 'member' | 'admin') =>
    (
      await driveInviteAndAccept(
        ctx,
        alice,
        { username: name, displayName: name, password: 'correct horse battery staple' },
        role,
      )
    ).session
  const [other, admin] = [
    await invite('draft-outsider', 'member'),
    await invite('draft-admin', 'admin'),
  ]
  const request = (
    actor: Session,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    payload?: object,
    idempotencyKey?: string,
  ) =>
    apiInject(ctx, actor, {
      method,
      url: '/api/v1' + path,
      ...(payload === undefined ? {} : { payload }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
  const candidatePath = '/managed-draft-candidates'
  const grantPath = '/draft-share-grants'
  const content = (actor: Session, grantId: string) =>
    request(actor, 'GET', grantPath + '/' + grantId + '/content')
  const offerUrl = candidatePath + '/' + artifactId + '/grants'
  const candidateUrl = candidatePath + '/' + artifactId + '/content'
  const exactBytes = Buffer.from(body)
  const sha256 = createHash('sha256').update(exactBytes).digest('hex')
  const runCount = async () =>
    (await database.sql<{ n: number }[]>`select count(*)::int as n from run`)[0]?.n
  const runsBefore = await runCount()

  const list = await request(alice, 'GET', candidatePath)
  expect(list.statusCode).toBe(200)
  expect(list.headers['cache-control']).toBe('private, no-store')
  expect(list.json().data).toContainEqual(expect.objectContaining({ artifactId, sha256 }))
  for (const reader of [bob, other, admin]) {
    expect((await request(reader, 'GET', candidatePath)).json().data).toEqual([])
    expect((await request(reader, 'GET', candidateUrl)).statusCode).toBe(404)
  }

  const reviewed = await request(alice, 'GET', candidateUrl)
  expect(reviewed.statusCode).toBe(200)
  expect(Buffer.from(reviewed.body)).toEqual(exactBytes)
  expect(reviewed.headers['cache-control']).toBe('private, no-store')
  const reviewReceiptId = reviewed.headers['x-whalepod-draft-review-id']
  expect(reviewReceiptId).toBeTypeOf('string')
  const offeredBody = {
    recipientUserId: bob.userId,
    sha256,
    reviewReceiptId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmsReadOnly: true,
  }
  for (const bad of [
    { sha256: 'f'.repeat(64) },
    { recipientUserId: other.userId },
    { reviewReceiptId: randomUUID() },
  ]) {
    expect((await request(alice, 'POST', offerUrl, { ...offeredBody, ...bad })).statusCode).toBe(
      404,
    )
  }
  expect((await request(admin, 'POST', offerUrl, offeredBody)).statusCode).toBe(404)
  expect(
    (
      await request(alice, 'POST', offerUrl, {
        ...offeredBody,
        projectId: randomUUID(),
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await request(alice, 'POST', offerUrl, {
        ...offeredBody,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
    ).statusCode,
  ).toBe(404)

  const offerKey = idemKey()
  const offered = await request(alice, 'POST', offerUrl, offeredBody, offerKey)
  expect(offered.statusCode).toBe(201)
  const { grantId } = offered.json().data as { grantId: string }
  expect((await request(alice, 'POST', offerUrl, offeredBody, offerKey)).json().data.grantId).toBe(
    grantId,
  )
  expect((await request(alice, 'POST', offerUrl, offeredBody)).statusCode).toBe(409)
  const pending = await request(bob, 'GET', grantPath)
  expect(pending.statusCode).toBe(200)
  expect(pending.json().data).toEqual([
    { grantId, state: 'offered', expiresAt: offeredBody.expiresAt },
  ])
  const noSession = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1' + grantPath + '/' + grantId + '/content',
  })
  expect(noSession.statusCode).toBe(401)
  expect(noSession.body).not.toContain(body)
  const denied = await content(bob, grantId)
  expect(denied.statusCode).toBe(404)
  const absent = await content(bob, randomUUID())
  expect(absent.statusCode).toBe(404)
  expect(denied.json().error.code).toBe(absent.json().error.code)
  for (const reader of [alice, other, admin]) {
    expect((await request(reader, 'POST', grantPath + '/' + grantId + '/accept')).statusCode).toBe(
      404,
    )
  }

  const acceptKey = idemKey()
  const acceptUrl = grantPath + '/' + grantId + '/accept'
  expect((await request(bob, 'POST', acceptUrl, { purpose: 'agent_input' })).statusCode).toBe(400)
  const accepted = await request(bob, 'POST', acceptUrl, undefined, acceptKey)
  expect(accepted.statusCode).toBe(200)
  expect(accepted.json().data).toEqual({
    grantId,
    state: 'active',
    expiresAt: offeredBody.expiresAt,
  })
  expect((await request(bob, 'POST', acceptUrl, undefined, acceptKey)).json().data).toEqual(
    accepted.json().data,
  )
  for (const reader of [alice, bob]) {
    const read = await content(reader, grantId)
    expect(read.statusCode).toBe(200)
    expect(Buffer.from(read.body)).toEqual(exactBytes)
    expect(read.headers['cache-control']).toBe('private, no-store')
    expect(read.headers['x-content-type-options']).toBe('nosniff')
  }
  for (const reader of [other, admin]) {
    expect((await content(reader, grantId)).statusCode).toBe(404)
    expect((await request(reader, 'GET', grantPath)).json().data).toEqual([])
    expect((await request(reader, 'DELETE', grantPath + '/' + grantId)).statusCode).toBe(404)
  }

  // The ordinary Artifact/Run/Task views remain unable to reveal the sealed material or grant.
  for (const reader of [alice, bob, other, admin]) {
    expect((await request(reader, 'GET', '/artifacts/' + artifactId + '/content')).statusCode).toBe(
      404,
    )
    expect(
      (await request(reader, 'POST', '/artifacts/' + artifactId + '/publish')).statusCode,
    ).toBe(404)
    expect((await request(reader, 'GET', '/runs/' + runId + '/events')).statusCode).toBe(404)
    const task = await request(reader, 'GET', '/tasks/' + taskId)
    expect(task.statusCode).toBe(200)
    expect(task.body).not.toContain(artifactId)
    expect(task.body).not.toContain(grantId)
    expect(task.body).not.toContain(sha256)
    expect(task.body).not.toContain(body)
    const attention = await request(reader, 'GET', '/tasks/attention')
    expect(attention.statusCode).toBe(200)
    expect(attention.body).not.toContain(artifactId)
    expect(attention.body).not.toContain(grantId)
  }
  const teamProjection = await database.sql<{ payload: unknown }[]>`select payload from team_event`
  expect(JSON.stringify(teamProjection)).not.toContain(grantId)
  expect(JSON.stringify(teamProjection)).not.toContain(artifactId)
  expect(JSON.stringify(teamProjection)).not.toContain(sha256)
  expect(JSON.stringify(teamProjection)).not.toContain(body)
  expect(await runCount()).toBe(runsBefore)

  const actualContent = (actor: Session, id: string) =>
    fetch(listenerOrigin(ctx) + '/api/v1' + grantPath + '/' + id + '/content', {
      headers: { cookie: actor.cookie, origin: ctx.origin },
      redirect: 'error',
    })
  const revokeKey = idemKey()
  const revokeUrl = grantPath + '/' + grantId
  // Observe both real HTTP commands blocked at the same Task authority lock;
  // the first waiter is admitted first when the test transaction releases it.
  const ordered = async <T, U>(first: () => Promise<T>, second: () => Promise<U>) => {
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const locker = database.transaction(async (tx) => {
      await tx.execute(sql`select id from task where id = ${taskId} for update`)
      held.resolve()
      await release.promise
    })
    const waiting = async (count: number) => {
      await waitForValue(async () => {
        const [state] = await database.sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and (query like '%from "task"%' or query like '%from task%')
            and query like '%for update%'`
        return (state?.n ?? 0) >= count ? true : undefined
      }, 'private read/revocation queued at final Task lock')
    }
    try {
      await held.promise
      const one = first()
      await waiting(1)
      const two = second()
      await waiting(2)
      release.resolve()
      return await Promise.all([one, two])
    } finally {
      release.resolve()
      await locker
    }
  }
  const [revoked, refused] = await ordered(
    () => request(alice, 'DELETE', revokeUrl, undefined, revokeKey),
    () => actualContent(bob, grantId),
  )
  expect(revoked.statusCode).toBe(204)
  expect(refused.status).toBe(404)
  expect(await refused.text()).not.toContain(body)
  const readCount = async (id: string) =>
    (
      await database.sql<{ n: number }[]>`
      select count(*)::int as n from draft_share_read_admission where grant_id = ${id}`
    )[0]?.n
  expect(await readCount(grantId)).toBe(2)
  expect((await request(alice, 'DELETE', revokeUrl, undefined, revokeKey)).statusCode).toBe(204)
  expect((await content(bob, grantId)).statusCode).toBe(404)
  expect((await request(bob, 'POST', acceptUrl, undefined, acceptKey)).statusCode).toBe(404)
  expect((await request(alice, 'POST', offerUrl, offeredBody, offerKey)).statusCode).toBe(404)

  const newActiveGrant = async () => {
    const next = await request(alice, 'POST', offerUrl, offeredBody)
    expect(next.statusCode).toBe(201)
    const nextId = next.json().data.grantId as string
    expect(nextId).not.toBe(grantId)
    expect((await content(bob, nextId)).statusCode).toBe(404)
    expect(
      (await request(bob, 'POST', grantPath + '/' + nextId + '/accept', undefined, acceptKey))
        .statusCode,
    ).toBe(409)
    expect((await content(bob, nextId)).statusCode).toBe(404)
    expect((await request(bob, 'POST', grantPath + '/' + nextId + '/accept')).statusCode).toBe(200)
    expect(
      (await request(alice, 'DELETE', grantPath + '/' + nextId, undefined, revokeKey)).statusCode,
    ).toBe(409)
    return nextId
  }
  const inFlightGrantId = await newActiveGrant()
  const [alreadyAdmitted, stopped] = await ordered(
    () => actualContent(bob, inFlightGrantId),
    () => request(bob, 'DELETE', grantPath + '/' + inFlightGrantId),
  )
  expect(alreadyAdmitted.status).toBe(200)
  expect(Buffer.from(await alreadyAdmitted.arrayBuffer())).toEqual(exactBytes)
  expect(stopped.statusCode).toBe(204)
  expect((await content(bob, inFlightGrantId)).statusCode).toBe(404)
  expect(await readCount(inFlightGrantId)).toBe(1)

  const declined = await request(alice, 'POST', offerUrl, offeredBody)
  expect(declined.statusCode).toBe(201)
  const declinedId = declined.json().data.grantId as string
  expect((await request(bob, 'POST', grantPath + '/' + declinedId + '/decline')).statusCode).toBe(
    204,
  )
  expect((await request(bob, 'POST', grantPath + '/' + declinedId + '/accept')).statusCode).toBe(
    404,
  )

  const soon = new Date(Date.now() + 1_500)
  const short = await request(alice, 'POST', offerUrl, {
    ...offeredBody,
    expiresAt: soon.toISOString(),
  })
  expect(short.statusCode).toBe(201)
  const shortId = short.json().data.grantId as string
  await waitForValue(
    async () => (Date.now() >= soon.getTime() ? true : undefined),
    'grant expires on Hub clock',
  )
  expect((await request(bob, 'POST', grantPath + '/' + shortId + '/accept')).statusCode).toBe(404)
  expect(
    (await request(alice, 'POST', offerUrl, { ...offeredBody, replaceGrantId: randomUUID() }))
      .statusCode,
  ).toBe(404)
  const replacementId = await newActiveGrant()
  expect(Buffer.from((await content(bob, replacementId)).body)).toEqual(exactBytes)

  const deniedAfterReassignment = async () => {
    expect((await content(bob, replacementId)).statusCode).toBe(404)
    expect((await request(alice, 'GET', candidateUrl)).statusCode).toBe(404)
    expect((await request(bob, 'GET', grantPath)).json().data).toEqual([])
  }
  const taskUrl = '/tasks/' + taskId
  expect(
    (await request(alice, 'POST', taskUrl + '/reassign', { assigneeUserId: bob.userId }))
      .statusCode,
  ).toBe(200)
  await deniedAfterReassignment()
  expect((await request(bob, 'POST', taskUrl + '/accept')).statusCode).toBe(200)
  const back = await request(alice, 'POST', taskUrl + '/reassign', { assigneeUserId: alice.userId })
  expect(back.statusCode, back.body).toBe(200)
  expect((await request(alice, 'POST', taskUrl + '/accept')).statusCode).toBe(200)
  await deniedAfterReassignment()
  const [source] = await database.sql<{ revoked: boolean }[]>`
    select revoked_at is not null as revoked from managed_draft_source_policy where id = ${sourceId}`
  expect(source?.revoked).toBe(true)
}

/** An ordinary business Run may return a submitted Task to in_progress; sealed authority cannot. */
export async function verifyManagedDraftReviewInvalidation(
  ctx: TestApp,
  database: Database,
  { alice, bob, taskId, runId, artifactId, body, sourceId, workKey }: RecipientScenario,
): Promise<void> {
  const taskUrl = `/api/v1/tasks/${taskId}`
  const candidateUrl = `/api/v1/managed-draft-candidates/${artifactId}`
  const request = (actor: Session, method: 'GET' | 'POST', url: string, payload?: object) =>
    apiInject(ctx, actor, { method, url, ...(payload === undefined ? {} : { payload }) })
  const reviewed = await request(alice, 'GET', candidateUrl + '/content')
  expect(reviewed.statusCode, reviewed.body).toBe(200)
  expect(reviewed.body).toBe(body)
  const offered = await request(alice, 'POST', candidateUrl + '/grants', {
    recipientUserId: bob.userId,
    sha256: createHash('sha256').update(body).digest('hex'),
    reviewReceiptId: reviewed.headers['x-whalepod-draft-review-id'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmsReadOnly: true,
  })
  expect(offered.statusCode, offered.body).toBe(201)
  const grantId = offered.json().data.grantId as string
  const grantUrl = `/api/v1/draft-share-grants/${grantId}`
  expect((await request(bob, 'POST', grantUrl + '/accept')).statusCode).toBe(200)
  const read = () => request(bob, 'GET', grantUrl + '/content')
  expect((await read()).body).toBe(body)

  const pairing = await request(alice, 'POST', '/api/v1/devices/pairing-codes', {})
  expect(pairing.statusCode, pairing.body).toBe(201)
  const claim = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/devices/pairing-claims',
    headers: { 'idempotency-key': idemKey() },
    payload: {
      code: pairing.json().data.code,
      name: 'ordinary-review-control',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
    },
  })
  expect(claim.statusCode, claim.body).toBe(201)
  const { deviceId, deviceToken } = claim.json().data as { deviceId: string; deviceToken: string }
  const workspaceId = randomUUID()
  const socket = new WebSocket(listenerOrigin(ctx).replace('http:', 'ws:') + '/ws/v1/node', {
    headers: { authorization: 'Device ' + deviceToken },
  })
  const send = (type: string, payload: unknown) =>
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type,
        payload,
      }),
    )
  try {
    await once(socket, 'open')
    send('node.hello', {
      deviceId,
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      supportedProtocolVersions: [1],
      dshDistributionVersion: 'ordinary-review-control',
      pluginPackDigests: [],
      contextCapabilities: ['project-context.v1', 'context-state.v1', 'work-input.v1'],
    })
    send('node.inventory', {
      deviceId,
      workspaces: [
        {
          workspaceId,
          name: 'ordinary-review-control',
          kind: 'directory',
          capabilities: { read: true, write: true, git: false },
          available: true,
          lastCheckedAt: new Date().toISOString(),
        },
      ],
      credentialSlots: [],
    })
    await waitForValue(async () => {
      const list = await request(alice, 'GET', '/api/v1/workspaces')
      const workspaces = list.json().data as { workspaceId: string }[]
      return workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    }, 'ordinary review control Workspace registered over WS')
    const agents = await request(alice, 'GET', '/api/v1/agents')
    expect(agents.statusCode, agents.body).toBe(200)
    const agentId = (agents.json().data as { id: string }[])[0]?.id
    if (agentId === undefined) throw new Error('missing ordinary review control Agent')
    const start = async () => {
      const result = await request(alice, 'POST', taskUrl + '/runs', {
        agentId,
        deviceId,
        workspaceId,
        prompt: 'Ordinary review lifecycle control',
      })
      expect(result.statusCode, result.body).toBe(201)
      return result.json().data.id as string
    }
    const ordinaryRunId = await start()
    const worker = new OutboxWorker({
      outbox: new Outbox(database),
      gateway: new WsDeviceGateway(),
      managedDraftTransport: ctx.app.managedDraftTransport,
      managedDraftExecution: ctx.app.managedDraftExecution,
      beforeDispatch: (command) => ctx.app.runOrchestrator.beforeDispatch(command),
    })
    const frames: Array<ReturnType<typeof NodeDownstreamSchema.parse>> = []
    socket.on('message', (raw) => {
      const frame = NodeDownstreamSchema.safeParse(JSON.parse(String(raw)))
      if (frame.success) frames.push(frame.data)
    })
    const dispatch = await worker.dispatchOnce()
    expect(dispatch.sent).toBeGreaterThanOrEqual(1)
    expect(dispatch.failed).toBe(0)
    const offer = await waitForValue(
      async () =>
        frames.find((frame) => frame.type === 'run.start' && frame.payload.runId === ordinaryRunId),
      'ordinary review control Run reaches ordinary WS',
    )
    if (offer.type !== 'run.start') throw new Error('ordinary Run did not reach ordinary WS')
    send('command.ack', { commandId: offer.payload.commandId, accepted: true })
    socket.send(
      JSON.stringify(
        runEventFrame(ordinaryRunId, 1, { type: 'runtime.ready', dshSessionId: 'review-control' }),
      ),
    )
    socket.send(
      JSON.stringify(
        runEventFrame(ordinaryRunId, 2, {
          type: 'run.completed',
          finalText: 'Public control complete',
        }),
      ),
    )
    await waitForValue(async () => {
      const result = await request(alice, 'GET', `/api/v1/runs/${ordinaryRunId}`)
      return result.statusCode === 200 && result.json().data.status === 'completed'
        ? true
        : undefined
    }, 'ordinary control completed via production Run events')
    const bytes = Buffer.from('Ordinary published control')
    const query = new URLSearchParams({
      title: 'Public review control',
      mediaType: 'text/plain',
      byteSize: String(bytes.length),
      sourceRelativePath: 'ordinary-review.txt',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/runs/${ordinaryRunId}/artifacts?${query}`,
      headers: {
        authorization: 'Device ' + deviceToken,
        'content-type': 'application/octet-stream',
        'idempotency-key': idemKey(),
      },
      payload: bytes,
    })
    expect(uploaded.statusCode, uploaded.body).toBe(201)
    const ordinaryArtifactId = uploaded.json().data.id as string
    const published = await request(
      alice,
      'POST',
      `/api/v1/artifacts/${ordinaryArtifactId}/publish`,
    )
    expect(published.statusCode, published.body).toBe(200)

    if (workKey === undefined) throw new Error('missing Work for business subscription negative')
    const subscribe = (targetRef: string) =>
      request(alice, 'POST', `/api/v1/works/${workKey}/subscriptions`, {
        targetType: 'business_ref',
        targetRef,
      })
    for (const targetRef of [`artifact:${artifactId}`, `run:${runId}`]) {
      const denied = await subscribe(targetRef)
      expect(denied.statusCode, denied.body).toBe(400)
      expect(denied.json().error.message).toContain('not resolvable')
    }
    expect((await subscribe(`artifact:${ordinaryArtifactId}`)).statusCode).toBe(201)
    expect((await subscribe(`run:${ordinaryRunId}`)).statusCode).toBe(201)

    expect((await read()).body).toBe(body)
    const submitted = await request(alice, 'POST', taskUrl + '/submit-review')
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().data.status).toBe('in_review')
    expect((await read()).statusCode).toBe(404)
    await start()
    const resumed = await request(alice, 'GET', taskUrl)
    expect(resumed.json().data.task.status).toBe('in_progress')
    expect((await read()).statusCode).toBe(404)
    const [source] = await database.sql<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from managed_draft_source_policy where id = ${sourceId}`
    expect(source?.revoked).toBe(true)
  } finally {
    socket.terminate()
  }
}
