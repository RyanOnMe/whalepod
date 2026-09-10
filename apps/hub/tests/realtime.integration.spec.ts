/**
 * P1-08 Browser 实时链路集成验收（02 Task 8、03 §5、04 G2-06/R2/R3、§6.2）。
 *
 * 驱动走真人路径：真实端口 listen（app.listen({port:0})）+ `ws` 包客户端
 * 带 {cookie, origin} 自定义头握手（Node 全局 WebSocket 无法自定义 header）。
 * 覆盖：
 *   1) cursor 后按序补发
 *   2) 无 Cookie 在升级前 401 拒绝
 *   3) Origin 不符（错误/缺失）在升级前 403 拒绝
 *   4) 过期 cursor → control resync.required + close 4009
 *   5) 待发超压（>1000 条或 >4MiB）→ control resync.required + close 4009
 *   6) owner-only live delta 对 bob 永不可见（含反向）
 *   7) 断线重连按已提交 cursor 补发、无重复
 *   8) 成员产生的持久 task.changed 经 250ms 轮询推给所有已连接成员
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import type { Database } from '@whalepod/db'
import { appendTeamEvent, schema } from '@whalepod/db'
import { parseClientFrame } from '@whalepod/protocol'
import type { ClientFrame } from '@whalepod/protocol'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

const MESSAGE_TIMEOUT_MS = 3000
const NEGATIVE_WINDOW_MS = 400
const silence = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class HandshakeError extends Error {
  constructor(readonly statusCode: number) {
    super(`websocket handshake rejected with HTTP ${statusCode}`)
    this.name = 'HandshakeError'
  }
}

interface TestClient {
  readonly messages: ClientFrame[]
  readonly closed: Promise<{ code: number; reason: string }>
  /** 至少等到 n 条帧，返回前 n 条（超时抛 'timeout'，模仿 02 Task 8 Step 1 的 take）。 */
  take(n: number, timeoutMs?: number): Promise<ClientFrame[]>
  /** 断网前暂停底层 socket，制造服务端待发背压（超压用例）。 */
  pause(): void
  resume(): void
  close(): void
  /** 已收到帧里最后一个 persistent cursor（测试 7 的“已提交 cursor”）。 */
  lastPersistentCursor(): string
}

const sleep = silence

describe('browser realtime WS /ws/v1/client', () => {
  let database: Database
  let ctx: TestApp
  let baseUrl: string
  const clients: TestClient[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = ctx.app.server.address() as AddressInfo
    baseUrl = `ws://127.0.0.1:${addr.port}/ws/v1/client`
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await ctx.close()
  })

  afterAll(async () => {
    await database.close()
  })

  function connectClient(opts: {
    cookie?: string
    origin?: string
    cursor?: string
  }): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (opts.cookie !== undefined) headers.cookie = opts.cookie
      headers.origin = opts.origin ?? ctx.origin
      const url = `${baseUrl}?cursor=${opts.cursor ?? '0'}`
      const ws = new WebSocket(url, { headers })
      const messages: ClientFrame[] = []
      let settled = false
      let resolveClosed!: (value: { code: number; reason: string }) => void
      const closed = new Promise<{ code: number; reason: string }>((r) => {
        resolveClosed = r
      })
      const client: TestClient = {
        messages,
        closed,
        take: async (n, timeoutMs = MESSAGE_TIMEOUT_MS) => {
          const deadline = Date.now() + timeoutMs
          while (messages.length < n) {
            if (Date.now() >= deadline) throw new Error('timeout waiting for frames')
            await sleep(20)
          }
          return messages.slice(0, n)
        },
        pause: () => (ws as unknown as { _socket: { pause(): void } })._socket.pause(),
        resume: () => (ws as unknown as { _socket: { resume(): void } })._socket.resume(),
        close: () => ws.close(),
        lastPersistentCursor: () => {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const frame = messages[i]
            if (frame !== undefined && frame.kind === 'persistent') return frame.cursor
          }
          return '0'
        },
      }
      ws.on('message', (data) => {
        // 服务端帧一律经协议 deny 面解析（fail-closed：坏帧直接抛错红掉测试）。
        messages.push(parseClientFrame(JSON.parse(data.toString())))
      })
      ws.on('open', () => {
        if (!settled) {
          settled = true
          clients.push(client)
          resolve(client)
        }
      })
      ws.on('close', (code, reason) => {
        resolveClosed({ code, reason: reason.toString() })
      })
      ws.on('unexpected-response', (_request, response) => {
        if (!settled) {
          settled = true
          reject(new HandshakeError(response.statusCode ?? 0))
        }
      })
      ws.on('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
    })
  }

  /** 断言后续 NEGATIVE_WINDOW_MS 内没有新帧（隐私用例：非 owner 永收不到）。 */
  async function expectSilence(client: TestClient, what: string): Promise<void> {
    const seen = client.messages.length
    await sleep(NEGATIVE_WINDOW_MS)
    expect(client.messages.length, what).toBe(seen)
  }

  function persistent(frame: ClientFrame): Extract<ClientFrame, { kind: 'persistent' }> {
    if (frame.kind !== 'persistent') throw new Error(`expected persistent frame, got ${frame.kind}`)
    return frame
  }

  it('replays durable events after the client cursor, in id order', async () => {
    const alice = await driveSetup(ctx)
    const id1 = await appendTeamEvent(database.db, {
      type: 'task.changed',
      payload: { taskId: 't-1' },
    })
    const id2 = await appendTeamEvent(database.db, {
      type: 'task.changed',
      payload: { taskId: 't-1' },
    })
    const id3 = await appendTeamEvent(database.db, {
      type: 'comment.created',
      payload: { taskId: 't-1' },
    })
    const client = await connectClient({ cookie: alice.cookie, cursor: String(id1.id) })
    const frames = (await client.take(2)).map(persistent)
    expect(frames.map((f) => f.cursor)).toEqual([String(id2.id), String(id3.id)])
    expect(frames.map((f) => f.event.type)).toEqual(['task.changed', 'comment.created'])
    for (const frame of frames) {
      expect(frame.protocolVersion).toBe(1)
      expect(frame.occurredAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
    }
    // 没有 id1 的重复补发
    expect(client.messages.filter((f) => f.kind === 'persistent').length).toBe(2)
  })

  it('rejects handshake without the session cookie with 401 before upgrade', async () => {
    await expect(connectClient({ cursor: '0' })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects handshake with wrong or missing Origin with 403 before upgrade', async () => {
    const alice = await driveSetup(ctx)
    await expect(
      connectClient({ cookie: alice.cookie, origin: 'https://evil.example.com', cursor: '0' }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      connectClient({ cookie: alice.cookie, origin: 'http://localhost:4242.evil', cursor: '0' }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects an expired cursor (outside 24h window) with resync.required then close 4009', async () => {
    const alice = await driveSetup(ctx)
    // 25 小时前的过期事件：cursor 早于保留窗口 → 必须 resync，不猜缺失。
    const [expiredRow] = await database.db
      .insert(schema.teamEvents)
      .values({
        type: 'task.changed',
        payload: { taskId: 't-old' },
        occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })
      .returning()
    if (expiredRow === undefined) throw new Error('expected expired row to be inserted')
    const latest = await appendTeamEvent(database.db, { type: 'device.changed', payload: {} })
    const client = await connectClient({ cookie: alice.cookie, cursor: String(expiredRow.id) })
    const close = await client.closed
    expect(close.code).toBe(4009)
    expect(client.messages).toHaveLength(1)
    const control = client.messages[0]
    if (control === undefined || control.kind !== 'control') {
      throw new Error('expected a single control frame before close 4009')
    }
    expect(control.type).toBe('resync.required')
    expect(control.latestCursor).toBe(String(latest.id))
    expect(control.protocolVersion).toBe(1)
  })

  it('connects with cursor=0 when only expired events exist: no replay, no resync', async () => {
    const alice = await driveSetup(ctx)
    await database.db.insert(schema.teamEvents).values({
      type: 'task.changed',
      payload: { taskId: 't-old' },
      occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    })
    const client = await connectClient({ cookie: alice.cookie, cursor: '0' })
    await expectSilence(client, 'cursor=0 不应补发窗口外事件')
    expect(client.messages).toHaveLength(0)
  })

  it(
    'closes 4009 with resync.required when pending replay exceeds backpressure caps',
    {
      timeout: 20000,
    },
    async () => {
      const alice = await driveSetup(ctx)
      // 2500 条 × ~4KiB ≈ 10MiB：单连接待发持久事件同时超过 1000 条与 4MiB 两道上限。
      const blob = 'x'.repeat(4096)
      await database.db.insert(schema.teamEvents).values(
        Array.from({ length: 2500 }, (_, i) => ({
          type: 'task.changed',
          payload: { taskId: 't-1', seq: i, blob },
        })),
      )
      const latest = await appendTeamEvent(database.db, { type: 'device.changed', payload: {} })
      const client = await connectClient({ cookie: alice.cookie, cursor: '0' })
      client.pause() // 停止读取 → 服务端待发队列被压满
      await silence(800) // 服务端 overflow → control resync.required → close 4009
      client.resume()
      const close = await client.closed
      expect(close.code).toBe(4009)
      await silence(200) // 让内核缓冲里的残余帧 + control 帧 + close 帧送完
      expect(client.messages.length).toBeGreaterThan(0)
      const last = client.messages[client.messages.length - 1]
      if (last === undefined || last.kind !== 'control') {
        throw new Error('expected control resync.required to be the last frame before close 4009')
      }
      expect(last.type).toBe('resync.required')
      expect(last.latestCursor).toBe(String(latest.id))
    },
  )

  it('never sends owner-only live deltas to another member, either direction', async () => {
    const alice = await driveSetup(ctx)
    const bob = await driveInviteAndAccept(
      ctx,
      alice,
      { username: 'bob', displayName: 'Bob', password: 'correct horse battery staple' },
      'member',
    )
    const aliceClient = await connectClient({ cookie: alice.cookie, cursor: '0' })
    const bobClient = await connectClient({ cookie: bob.session.cookie, cursor: '0' })
    await silence(50) // 等服务端完成回放并登记 live 订阅

    ctx.app.realtime.publishLive({
      runId: '10000000-0000-4000-8000-000000000001',
      deltaSeq: 1,
      text: 'secret plan for alice only',
      ownerUserId: alice.userId,
    })
    const frames = await aliceClient.take(1)
    expect(frames[0]).toMatchObject({
      kind: 'live',
      runId: '10000000-0000-4000-8000-000000000001',
      audience: 'owner',
      deltaSeq: 1,
      delta: { text: 'secret plan for alice only' },
    })
    await expectSilence(bobClient, 'bob 永不收到 alice 的 owner 帧')

    ctx.app.realtime.publishLive({
      runId: '10000000-0000-4000-8000-000000000002',
      deltaSeq: 1,
      text: "bob's private delta",
      ownerUserId: bob.session.userId,
    })
    await bobClient.take(1)
    await expectSilence(aliceClient, 'alice 永不收到 bob 的 owner 帧')
  })

  it('reconnects with the committed cursor: gap-free backfill, no duplicates', async () => {
    const alice = await driveSetup(ctx)
    const id1 = await appendTeamEvent(database.db, {
      type: 'task.changed',
      payload: { taskId: 't-1' },
    })
    const id2 = await appendTeamEvent(database.db, {
      type: 'task.changed',
      payload: { taskId: 't-1' },
    })
    const first = await connectClient({ cookie: alice.cookie, cursor: '0' })
    const replayed = (await first.take(2)).map(persistent)
    expect(replayed.map((f) => f.cursor)).toEqual([String(id1.id), String(id2.id)])
    const committed = first.lastPersistentCursor() // “已提交”的 cursor（server 补发面）
    expect(committed).toBe(String(id2.id))
    first.close()
    await first.closed

    // 断线期间产生的新事件
    const id3 = await appendTeamEvent(database.db, {
      type: 'comment.created',
      payload: { taskId: 't-1' },
    })
    const second = await connectClient({ cookie: alice.cookie, cursor: committed })
    const backfilled = (await second.take(1)).map(persistent)
    expect(backfilled.map((f) => f.cursor)).toEqual([String(id3.id)])
    await silence(150)
    expect(second.messages.filter((f) => f.kind === 'persistent')).toHaveLength(1) // 无重复
  })

  it('delivers a persistent task.changed produced by another member via the poll loop', async () => {
    const alice = await driveSetup(ctx)
    const bob = await driveInviteAndAccept(
      ctx,
      alice,
      { username: 'bob', displayName: 'Bob', password: 'correct horse battery staple' },
      'member',
    )
    const aliceClient = await connectClient({ cookie: alice.cookie, cursor: '0' })
    await silence(50) // 等服务端登记订阅（250ms 轮询起点）

    // P1-13 起由 run/project/task 模块的 domain transaction 追加；此处直接走
    // repository 的同一 append 路径，模拟“bob 的操作产生 task.changed”。
    const event = await appendTeamEvent(database.db, {
      type: 'task.changed',
      payload: { taskId: 't-1' },
    })
    const frames = (await aliceClient.take(1)).map(persistent)
    expect(frames[0].cursor).toBe(String(event.id))
    expect(frames[0].event.type).toBe('task.changed')
    expect(frames[0].event.payload).toEqual({ taskId: 't-1' })
    void bob
  })
})
