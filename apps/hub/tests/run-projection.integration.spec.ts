/**
 * P1-13 Hub 侧集成验收（03 §5/§8、04 G4-04 服务端一半、R1/R6、§6.4 受众边界）。
 *
 * 驱动全走真人路径：真实 Fastify listen + ws 包 Node 端与 Browser 端客户端；
 * 落库断言直接读表（不爬日志）。覆盖：
 *   1) run.event 幂等落库（重复 seq 不产生第二行）+ 连续水位 run.event_ack
 *   2) 心跳上报水位高于 Hub 连续水位 → run.resend_from 主动拉缺口（R1 协议侧）
 *   3) run.live_delta 只投递给 Run owner 的浏览器连接（非 owner 永不可见）
 *   4) 持久 run.event 受众 diff：owner/admin/project 三类帧在 owner / member
 *      两个浏览器连接上呈现不同集合（G4-04 frame diff 的服务端一半）
 *   5) 双受众 approval.requested（同一 approvalId 两行）只落一条 Approval、
 *      只发一次 approval.changed
 *   6) Run HTTP 面接线：POST /tasks/:taskId/runs 201；GET /runs/:runId/events
 *      按受众过滤（owner 全量、member 仅 project、admin 加见 admin 行）
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { insertProject, insertTask, schema } from '@project311/db'
import { parseClientFrame } from '@project311/protocol'
import type { ClientFrame } from '@project311/protocol'
import WebSocket from 'ws'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  seedRunChainForUser,
  insertRunRow,
  type Session,
  type TestApp,
} from './helpers.js'

const TAKE_TIMEOUT_MS = 3000
const NEGATIVE_WINDOW_MS = 500
const silence = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 浏览器客户端：只收集协议解析后的帧（坏帧直接红测试）。 */
interface BrowserClient {
  readonly frames: ClientFrame[]
  take(n: number, timeoutMs?: number): Promise<ClientFrame[]>
  close(): void
}

describe('P1-13 run projection（Hub 侧）', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let nodeUrl: string
  let browserBase: string
  const nodeSockets: WebSocket[] = []
  const browserClients: BrowserClient[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx)
    await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const address = ctx.app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no listen port')
    nodeUrl = `ws://127.0.0.1:${address.port}/ws/v1/node`
    browserBase = `ws://127.0.0.1:${address.port}/ws/v1/client`
  })
  afterEach(async () => {
    for (const s of nodeSockets.splice(0)) s.terminate()
    for (const c of browserClients.splice(0)) c.close()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  // ---- 真人路径驱动 helpers ----

  async function apiPairingCode(as: Session): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { origin: ctx.origin, cookie: as.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    return res.json().data.code as string
  }

  async function pairDevice(as: Session): Promise<{ deviceId: string; deviceToken: string }> {
    const code = await apiPairingCode(as)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code,
        name: 'p113-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    return claim.json().data
  }

  function connectNode(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(nodeUrl, { headers: { authorization: `Device ${token}` } })
      nodeSockets.push(socket)
      socket.once('open', () => resolve(socket))
      socket.once('error', (error: Error) => reject(error))
    })
  }

  function connectBrowser(as: Session): Promise<BrowserClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${browserBase}?cursor=0`, {
        headers: { cookie: as.cookie, origin: ctx.origin },
      })
      const frames: ClientFrame[] = []
      const client: BrowserClient = {
        frames,
        take: async (n, timeoutMs = TAKE_TIMEOUT_MS) => {
          const deadline = Date.now() + timeoutMs
          while (frames.length < n) {
            if (Date.now() >= deadline) throw new Error(`timeout waiting ${n} browser frames`)
            await silence(20)
          }
          return frames.slice(0, n)
        },
        close: () => socket.close(),
      }
      socket.on('message', (data) => {
        frames.push(parseClientFrame(JSON.parse(data.toString())))
      })
      socket.once('open', () => {
        browserClients.push(client)
        resolve(client)
      })
      socket.once('error', reject)
    })
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

  // 常驻 message 监听 + take(n) 等待：once 式监听在回连帧同 tick 到达时会丢帧。
  interface NodeClient {
    readonly frames: Array<{ type: string; payload: Record<string, unknown> }>
    take(
      n: number,
      timeoutMs?: number,
    ): Promise<Array<{ type: string; payload: Record<string, unknown> }>>
  }
  function nodeClient(socket: WebSocket): NodeClient {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = []
    let closeCode = -1
    socket.on('message', (raw: unknown) => {
      frames.push(JSON.parse(String(raw)))
    })
    socket.on('close', (code: number) => {
      closeCode = code
    })
    return {
      frames,
      take: async (n, timeoutMs = TAKE_TIMEOUT_MS) => {
        const deadline = Date.now() + timeoutMs
        while (frames.length < n) {
          if (Date.now() >= deadline) {
            throw new Error(
              `timeout waiting ${n} node frames; got ${JSON.stringify(frames)}; closeCode=${closeCode}`,
            )
          }
          await silence(20)
        }
        return frames.slice(0, n)
      },
    }
  }

  /** Run 前置链：agent/revision 走 helper；workspace 挂在配对设备下；task 派给 alice 并已接受。 */
  async function seedRunFor(deviceId: string): Promise<string> {
    const chain = await seedRunChainForUser(database.db, alice.userId)
    const projectId = randomUUID()
    const taskId = randomUUID()
    const workspaceId = randomUUID()
    await insertProject(database.db, {
      id: projectId,
      name: `proj-${projectId.slice(0, 8)}`,
      createdBy: alice.userId,
    })
    await insertTask(database.db, {
      id: taskId,
      projectId,
      title: 'P1-13 task',
      assigneeUserId: alice.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: alice.userId,
    })
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId,
      ownerUserId: alice.userId,
      name: 'ws-p113',
      kind: 'directory',
      capabilities: { read: true, write: true },
      available: true,
    })
    return insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: chain.agentId,
      profileRevisionId: chain.profileRevisionId,
      deviceId,
      workspaceId,
      status: 'running',
    })
  }

  function runEvent(runId: string, seq: number, event: Record<string, unknown>, audience: string) {
    return nodeFrame('run.event', {
      runId,
      seq,
      occurredAt: new Date().toISOString(),
      audience,
      event,
    })
  }

  // ---- 用例 ----

  it('run.event 幂等落库（R6）+ 连续水位 ack；重复 seq 不产生第二行', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const runId = await seedRunFor(deviceId)

    const node = nodeClient(socket)
    socket.send(runEvent(runId, 1, { type: 'run.phase', phase: 'thinking' }, 'project'))
    socket.send(runEvent(runId, 2, { type: 'run.phase', phase: 'tool' }, 'project'))
    // 重复 (runId, seq=2)：幂等已应用，仍回 ack 水位 2，不产生第二行。
    socket.send(runEvent(runId, 2, { type: 'run.phase', phase: 'tool' }, 'project'))
    const acks = await node.take(3)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { runId, throughSeq: 1 } })
    expect(acks[1]?.payload.throughSeq).toBe(2)
    expect(acks[2]?.payload.throughSeq).toBe(2)
    await silence(150)
    const rows = await database.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
    expect(rows).toHaveLength(2)
  })

  it('心跳水位高于 Hub 连续水位 → run.resend_from 主动拉缺口（R1 协议侧）', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const runId = await seedRunFor(deviceId)
    // Hub 只有 1..2；Node 自称已到 5 → 拉 3 起。
    const node = nodeClient(socket)
    for (const seq of [1, 2]) {
      socket.send(runEvent(runId, seq, { type: 'run.phase', phase: 'tool' }, 'project'))
    }
    await node.take(2) // 两条 ack 排干
    socket.send(
      nodeFrame('node.heartbeat', {
        deviceId,
        activeRunIds: [runId],
        lastEventSeqByRun: { [runId]: 5 },
      }),
    )
    const resend = (await node.take(3))[2]
    expect(resend).toMatchObject({
      type: 'run.resend_from',
      payload: { runId, fromSeq: 3 },
    })
  })

  it('live_delta 只投递给 Run owner 的浏览器连接（04 §6.2）', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const runId = await seedRunFor(deviceId)
    const aliceWs = await connectBrowser(alice)
    const bobWs = await connectBrowser(bob)

    socket.send(nodeFrame('run.live_delta', { runId, deltaSeq: 1, text: 'Hello, ' }))
    socket.send(nodeFrame('run.live_delta', { runId, deltaSeq: 2, text: 'world' }))
    const [f1, f2] = await aliceWs.take(2)
    expect(f1).toMatchObject({ kind: 'live', runId, deltaSeq: 1, delta: { text: 'Hello, ' } })
    expect(f2).toMatchObject({ kind: 'live', runId, deltaSeq: 2, delta: { text: 'world' } })

    const bobSeen = bobWs.frames.length
    await silence(NEGATIVE_WINDOW_MS)
    expect(bobWs.frames.length).toBe(bobSeen)
  })

  it('持久 run.event 受众 diff：owner/admin/project 帧在 owner 与 member 连接上不同集合', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const runId = await seedRunFor(deviceId)
    const aliceWs = await connectBrowser(alice)
    const bobWs = await connectBrowser(bob)

    const node = nodeClient(socket) // 先挂监听再发：ack 可能同 tick 回来
    socket.send(runEvent(runId, 1, { type: 'run.phase', phase: 'tool' }, 'project'))
    socket.send(
      runEvent(runId, 2, { type: 'assistant.message', text: 'owner only full text' }, 'owner'),
    )
    socket.send(
      runEvent(runId, 3, { type: 'run.failed', code: 'INTERNAL_ERROR', summary: 'boom' }, 'admin'),
    )
    await node.take(3) // 三条 ack 排干

    // alice（team owner 角色 + run owner）：三帧全见。
    const aliceFrames = await aliceWs.take(3)
    const aliceRunEvents = aliceFrames.filter(
      (f) => f.kind === 'persistent' && f.event.type === 'run.event',
    )
    expect(aliceRunEvents).toHaveLength(3)

    // bob（member）：只见 project 帧；owner/admin 帧在回放与轮询两路都不可见。
    const bobFrames = await bobWs.take(1)
    expect(bobFrames[0]).toMatchObject({
      kind: 'persistent',
      event: { type: 'run.event', payload: { audience: 'project' } },
    })
    const bobSeen = bobWs.frames.length
    await silence(NEGATIVE_WINDOW_MS)
    expect(bobWs.frames.length).toBe(bobSeen)
    // bob 断线重连（回放路径）也只补到 project 帧。
    bobWs.close()
    const bobAgain = await connectBrowser(bob)
    const replayed = await bobAgain.take(1)
    expect(replayed[0]).toMatchObject({
      kind: 'persistent',
      event: { type: 'run.event', payload: { audience: 'project' } },
    })
    const replaySeen = bobAgain.frames.length
    await silence(NEGATIVE_WINDOW_MS)
    expect(bobAgain.frames.length).toBe(replaySeen)
  })

  it('双受众 approval.requested 只落一条 Approval、只发一次 approval.changed', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const runId = await seedRunFor(deviceId)
    const approvalId = randomUUID()
    const callId = randomUUID()
    const card = {
      approvalId,
      runId,
      callId,
      toolName: 'bash',
      reason: 'needs rm',
      preview: { command: 'rm -rf <workspace>/build' },
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }

    const node = nodeClient(socket)
    socket.send(runEvent(runId, 1, { type: 'approval.requested', approval: card }, 'owner'))
    socket.send(
      runEvent(
        runId,
        2,
        {
          type: 'approval.requested',
          approval: { ...card, reason: '', preview: { category: 'shell' } },
        },
        'project',
      ),
    )
    await node.take(2)

    const approvals = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, runId))
    expect(approvals).toHaveLength(1)
    // 留下的是 owner 全量卡（先到者为准；project 缩水卡被幂等跳过）。
    expect(approvals[0]?.reason).toBe('needs rm')
    const approvalEvents = await database.db
      .select()
      .from(schema.teamEvents)
      .where(eq(schema.teamEvents.type, 'approval.changed'))
    expect(approvalEvents).toHaveLength(1)
  })

  it('Run HTTP 面：POST 创建 201；GET events 按 owner/member/admin 受众过滤', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const { session: carol } = await driveInviteAndAccept(
      ctx,
      alice,
      { username: 'carol', displayName: 'Carol', password: 'correct horse battery staple' },
      'admin',
    )
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    // hello 回填 dsh 版本列：路由的 DEVICE_OFFLINE 判据。
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
    await silence(150)

    const chain = await seedRunChainForUser(database.db, alice.userId)
    const projectId = randomUUID()
    const taskId = randomUUID()
    await insertProject(database.db, {
      id: projectId,
      name: `proj-${projectId.slice(0, 8)}`,
      createdBy: alice.userId,
    })
    await insertTask(database.db, {
      id: taskId,
      projectId,
      title: 'P1-13 create route',
      assigneeUserId: alice.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: alice.userId,
    })
    const workspaceId = randomUUID()
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId,
      ownerUserId: alice.userId,
      name: 'ws-route',
      kind: 'directory',
      capabilities: { read: true, write: true },
      available: true,
    })

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: { agentId: chain.agentId, deviceId, workspaceId, prompt: 'do it' },
    })
    expect(created.statusCode).toBe(201)
    const runId = created.json().data.id as string

    // 三种受众各落一条（经 run.event 上行真人路径）。
    const node = nodeClient(socket) // 先挂监听再发：ack 可能同 tick 回来
    socket.send(runEvent(runId, 1, { type: 'run.phase', phase: 'tool' }, 'project'))
    socket.send(runEvent(runId, 2, { type: 'assistant.message', text: 'full' }, 'owner'))
    socket.send(
      runEvent(runId, 3, { type: 'run.failed', code: 'INTERNAL_ERROR', summary: 'boom' }, 'admin'),
    )
    await node.take(3)

    const getEvents = (as: Session) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/runs/${runId}/events`,
        headers: { origin: ctx.origin, cookie: as.cookie },
      })
    const ownerRes = await getEvents(alice)
    expect(ownerRes.statusCode).toBe(200)
    expect(ownerRes.json().data.events.map((e: { audience: string }) => e.audience)).toEqual([
      'project',
      'owner',
      'admin',
    ])

    const memberRes = await getEvents(bob)
    expect(memberRes.json().data.events.map((e: { seq: number }) => e.seq)).toEqual([1])

    const adminRes = await getEvents(carol)
    expect(adminRes.json().data.events.map((e: { seq: number }) => e.seq)).toEqual([1, 3])

    // after 游标 + 404。
    const afterRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/events?after=1`,
      headers: { origin: ctx.origin, cookie: bob.cookie },
    })
    expect(afterRes.json().data.events).toEqual([])
    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${randomUUID()}/events`,
      headers: { origin: ctx.origin, cookie: alice.cookie },
    })
    expect(missing.statusCode).toBe(404)
  })
})
