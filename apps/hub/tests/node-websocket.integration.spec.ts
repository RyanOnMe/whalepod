import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
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

  async function pair(as: Session): Promise<{ deviceId: string; deviceToken: string }> {
    const code = await apiPairingCode(as)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code,
        name: 'test-node',
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

  function connect(token: string | undefined): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: token === undefined ? {} : { authorization: `Device ${token}` },
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
    await new Promise((r) => setTimeout(r, 150))
    const [row] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId))
    expect(row?.dshDistributionVersion).toBe('0.1.0-rc.8')
    expect(row?.pluginPackDigests).toEqual(['a'.repeat(64)])
    expect(row?.lastSeenAt).not.toBeNull()
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
      }),
    )
    await new Promise((r) => setTimeout(r, 120))
    const [before] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId))
    await new Promise((r) => setTimeout(r, 20))
    socket.send(nodeFrame('node.heartbeat', { deviceId, activeRunIds: [], lastEventSeqByRun: {} }))
    await new Promise((r) => setTimeout(r, 120))
    const [after] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId))
    expect(after!.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before!.lastSeenAt!.getTime())
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
