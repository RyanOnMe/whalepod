import { eq } from 'drizzle-orm'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { listTeamEvents, schema } from '@whalepod/db'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { nodeConnections } from '../src/modules/device/connection-registry.js'
import { WsDeviceGateway } from '../src/modules/device/gateway.js'
import { NodeDownstreamSchema } from '@whalepod/protocol'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

// P1-09：Node 出站 WS 认证、hello 落库、心跳、单连接替换与撤销推送。
async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || (typeof address === 'object' && !('port' in address))) {
    throw new Error('no listen port')
  }
  return `ws://127.0.0.1:${(address as { port: number }).port}/ws/v1/node`
}

function nodeFrame(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  })
}

describe('node websocket (/ws/v1/node)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let url: string
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx)
    url = await listen(ctx.app)
  })
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function pair(
    as: Session,
    name = 'test-node',
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const code = await apiPairingCode(as)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code,
        name,
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    return claim.json().data
  }

  async function apiPairingCode(as: Session): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { origin: ctx.origin, cookie: as.cookie, 'idempotency-key': randomUUID() },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    return res.json().data.code as string
  }

  function connect(token: string | undefined, managedProof?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          ...(token === undefined ? {} : { authorization: `Device ${token}` }),
          ...(managedProof === undefined ? {} : { 'x-whalepod-managed-host': managedProof }),
        },
      })
      sockets.push(socket)
      socket.once('open', () => resolve(socket))
      socket.once('error', (error: Error & { statusCode?: number }) => reject(error))
    })
  }

  function nextMessage(
    socket: WebSocket,
    timeoutMs = 2000,
  ): Promise<{ type: string; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting frame')), timeoutMs)
      socket.once('message', (raw: unknown) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(raw)))
      })
    })
  }

  function nextClose(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      socket.once('close', (code: number) => resolve(code))
    })
  }

  it('无 Token / 错 Token 都在升级前 401', async () => {
    await expect(connect(undefined)).rejects.toThrow(/Unexpected server response: 401/)
    await expect(connect('f'.repeat(43))).rejects.toThrow(/Unexpected server response: 401/)
  })

  it('受管通道要求独立凭证，并在实际 WS 发送处隔离专用清单和普通控制帧', async () => {
    const dedicated = await pair(alice)
    const ordinary = await pair(alice, 'ordinary-node')
    const proof = randomBytes(32).toString('hex')
    const host = {
      deviceId: dedicated.deviceId,
      ownerUserId: alice.userId,
      workspaceId: randomUUID(),
      profileRevisionId: randomUUID(),
      managedHostGeneration: 2,
      proofSha256: createHash('sha256').update(proof).digest('hex'),
    }
    await ctx.close()
    ctx = await createTestApp(database, { managedDraftHost: host })
    url = await listen(ctx.app)
    await expect(connect(dedicated.deviceToken)).rejects.toThrow(/Unexpected server response: 401/)
    await expect(connect(dedicated.deviceToken, randomBytes(32).toString('hex'))).rejects.toThrow(
      /401/,
    )
    await expect(connect(ordinary.deviceToken, proof)).rejects.toThrow(/401/)
    const ordinarySocket = await connect(ordinary.deviceToken)
    const managedSocket = await connect(dedicated.deviceToken, proof)
    const ordinaryFrames: unknown[] = []
    ordinarySocket.on('message', (raw) => ordinaryFrames.push(JSON.parse(String(raw))))
    const gateway = new WsDeviceGateway()
    const control = NodeDownstreamSchema.parse(
      JSON.parse(nodeFrame('run.status_request', { commandId: randomUUID(), runId: randomUUID() })),
    )
    const manifest = {
      kind: 'managed_draft_source.v1',
      instruction: 'draft_registered_agreement.v1',
      runId: randomUUID(),
      projectId: randomUUID(),
      taskId: randomUUID(),
      workKey: randomUUID(),
      mandateId: randomUUID(),
      mandateVersion: 1,
      deviceId: host.deviceId,
      ownerUserId: host.ownerUserId,
      workspaceId: host.workspaceId,
      profileRevisionId: host.profileRevisionId,
      managedHostGeneration: host.managedHostGeneration,
      source: {
        policyId: randomUUID(),
        revisionId: randomUUID(),
        sha256: 'a'.repeat(64),
        byteSize: 12,
      },
      modelBindingDigest: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const makeManifestFrame = (value: unknown) =>
      NodeDownstreamSchema.parse(
        JSON.parse(
          nodeFrame('managed_draft.start', {
            commandId: randomUUID(),
            manifest: value,
            manifestDigest: 'c'.repeat(64),
          }),
        ),
      )
    const specialized = makeManifestFrame(manifest)
    await expect(gateway.send(dedicated.deviceId, specialized)).rejects.toThrow(/not online/)
    managedSocket.send(
      nodeFrame('node.hello', {
        deviceId: dedicated.deviceId,
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        supportedProtocolVersions: [1],
        dshDistributionVersion: 'managed-draft-control.v1',
        pluginPackDigests: [],
      }),
    )
    await waitForValue(
      async () => (nodeConnections.isManagedDraftOnline(host) ? true : undefined),
      'dedicated connection finished hello',
    )
    await expect(gateway.send(ordinary.deviceId, specialized)).rejects.toThrow(/not online/)
    await expect(gateway.send(dedicated.deviceId, control)).rejects.toThrow(/not online/)
    await expect(
      gateway.send(
        dedicated.deviceId,
        makeManifestFrame({ ...manifest, managedHostGeneration: 1 }),
      ),
    ).rejects.toThrow(/not online/)
    const delivered = nextMessage(managedSocket)
    await gateway.send(dedicated.deviceId, specialized)
    expect(await delivered).toEqual(specialized)
    const ordinaryControl = nextMessage(ordinarySocket)
    await gateway.send(ordinary.deviceId, control)
    expect(await ordinaryControl).toEqual(control)
    expect(ordinaryFrames).toEqual([control])
    const closed = nextClose(managedSocket)
    managedSocket.send(
      nodeFrame('node.heartbeat', {
        deviceId: dedicated.deviceId,
        activeRunIds: [manifest.runId],
        lastEventSeqByRun: {},
      }),
    )
    expect(await closed).toBe(4003)
  })

  it('hello 落库：dsh 版本与 pack digests 写入 #37 列并刷新 lastSeenAt', async () => {
    const { deviceId, deviceToken } = await pair(alice)
    const socket = await connect(deviceToken)
    socket.send(
      nodeFrame('node.hello', {
        deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: ['a'.repeat(64)],
      }),
    )
    // 等 hello 的版本事实落库（可观察条件），不猜时长。
    await waitForValue(async () => {
      const [row] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      return row?.dshDistributionVersion === '0.1.0-rc.8' ? row : undefined
    }, 'node.hello 的运行时候选事实未在超时内落库')
    const [row] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId))
    expect(row?.dshDistributionVersion).toBe('0.1.0-rc.8')
    expect(row?.pluginPackDigests).toEqual(['a'.repeat(64)])
    expect(row?.lastSeenAt).not.toBeNull()
  })

  it('#352：同一连接的第二条 hello **覆盖**事实列并再发 device.changed——设备视图不等重连', async () => {
    // 断链背景：Node 侧 hello 事实曾冻结在启动时刻，且 Hub 侧若做成「首写为准 / 并集合并」，
    // 本地装/重建 pack 或换 DSH 版本后设备视图都会停在旧值。两端各自单点削弱即红：
    // Node 侧按连接重算 + 会话内补发（session.spec.ts / hello-facts.spec.ts），
    // Hub 侧这份断言判「收到即回填、覆盖而非追加」（digests 收缩成 [] 时尤其能看出差别）。
    const { deviceId, deviceToken } = await pair(alice)
    const changedCount = async (): Promise<number> => {
      const events = await listTeamEvents(database.db)
      return events.filter(
        (event) =>
          event.type === 'device.changed' &&
          (event.payload as { deviceId?: string }).deviceId === deviceId,
      ).length
    }
    // 配对本身也发一条（#142）——以它为基线，判每条 hello 恰好追加一条。
    const baseline = await changedCount()
    const socket = await connect(deviceToken)
    socket.send(
      nodeFrame('node.hello', {
        deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: ['a'.repeat(64)],
      }),
    )
    await waitForValue(async () => {
      const [row] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      return row?.dshDistributionVersion === '0.1.0-rc.8' ? row : undefined
    }, '首条 node.hello 未在超时内落库')

    // 同一条连接上的第二条 hello（会话内补发的形态）：版本换新、digests 变空。
    socket.send(
      nodeFrame('node.hello', {
        deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: '0.1.0-rc.9',
        pluginPackDigests: [],
        contextCapabilities: ['project-context.v1', 'context-state.v1'],
      }),
    )
    await waitForValue(async () => {
      const [row] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      return row?.dshDistributionVersion === '0.1.0-rc.9' ? row : undefined
    }, '第二条 node.hello 未覆盖设备事实列（设备视图停在旧值——#352）')
    const [row] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId))
    expect(row?.pluginPackDigests).toEqual([]) // 覆盖：不是追加也不是保留

    // 每条 hello 都进 Team Event 流（Web 靠它把设备视图失效重拉）。
    expect(await changedCount()).toBe(baseline + 2)
  })

  it('同一 Device 第二条连接以 4008 替换第一条', async () => {
    const { deviceId, deviceToken } = await pair(alice)
    void deviceId
    const first = await connect(deviceToken)
    const second = await connect(deviceToken)
    expect(first.readyState).toBe(WebSocket.OPEN)
    const closed = nextClose(first)
    // 触发一帧交互确保替换逻辑执行（第二条 open 即应踢第一条）。
    second.send(
      nodeFrame('node.heartbeat', { deviceId: '', activeRunIds: [], lastEventSeqByRun: {} }),
    )
    expect(await closed).toBe(4008)
  })

  it('心跳刷新 lastSeenAt', async () => {
    const { deviceId, deviceToken } = await pair(alice)
    const socket = await connect(deviceToken)
    socket.send(
      nodeFrame('node.hello', {
        deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: [],
        contextCapabilities: ['project-context.v1', 'context-state.v1'],
      }),
    )
    // 等到 hello 落库（可观察条件：版本已写），而不是猜它要 120ms。
    const before = await waitForValue(
      async () =>
        (await database.db.select().from(schema.devices).where(eq(schema.devices.id, deviceId)))[0]
          ?.lastSeenAt ?? undefined,
      'node.hello 未在超时内刷新 lastSeenAt',
    )
    socket.send(nodeFrame('node.heartbeat', { deviceId, activeRunIds: [], lastEventSeqByRun: {} }))
    // 判据是**严格变大**（刷新语义），不是 >=——同毫秒的 >= 无法证明心跳生效。
    await waitForValue(async () => {
      const [after] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      return after?.lastSeenAt != null && after.lastSeenAt.getTime() > before.getTime()
        ? after
        : undefined
    }, '心跳未在超时内推进 lastSeenAt')
  })

  it('撤销后连接收到 node.token_revoked 并被关闭', async () => {
    const { deviceId, deviceToken } = await pair(alice)
    const socket = await connect(deviceToken)
    const revoked = nextMessage(socket)
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${deviceId}`,
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': randomUUID() },
    })
    expect(del.statusCode).toBe(200)
    expect(await revoked).toMatchObject({ type: 'node.token_revoked' })
    expect(await nextClose(socket)).toBe(4008)
  })
})
