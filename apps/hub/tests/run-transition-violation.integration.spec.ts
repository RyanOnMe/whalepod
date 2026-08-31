/**
 * #52 / ADR-0007：Run 状态机越边毒帧类清零（加边 + 留证降级并用）的 Hub 侧机器证据。
 *
 * 驱动全走真人路径：真实 Fastify listen + ws 包 Node 端客户端（与
 * run-projection.integration.spec 同型装配）；落库断言直接读表。
 *
 * 判据（Issue #52「怎样算修好」+ ADR-0007 决策栏）：
 *   1) waiting_approval + run.completed（owner 行）→ 连接存活、Run 落真终态
 *      completed（非 failed）、事件行持久留证（不随迁移失败回滚）、pending
 *      Approval 折叠为 cancelled（cause=run_terminal_fold）、ack 连续水位推进；
 *   2) waiting_approval + run.failed（Runtime 崩溃同型事实）→ 新边正常迁移，
 *      Run failed(RUNTIME_LOST)，折叠同上，连接存活；
 *   3) 表外越边（cancel_requested + completed / decided 引用缺失行）→ 降级为
 *      Run 级：留证 + failed(INVALID_RUN_TRANSITION) + 连接保留 + warn；
 *   4) 毒帧引擎拆除：心跳 resend_from 触发补发同一毒帧 → 一次应用即收敛，
 *      连续两轮 heartbeat 不再产生 resend/断连（R1 协议侧）；
 *   5) R6 幂等：毒帧应用后同 (runId,seq) 重放不产生第二行、不改状态、不断连；
 *   6) 重连 drain：模拟 Node 断线重连全量补发 → 无 4003、状态不回摆；
 *   7) 终态禁复活：终态后迟到的 run.failed 只留证不动状态（红线原样保留）；
 *   8) 反向守门：结构坏（schema 不过）与越权（外设备 Run）仍然是连接级 4003
 *      ——惩罚边界只收窄、不放宽（此前 4003 竟无任何断言，本 Issue 补上）。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { insertProject, insertTask, schema } from '@project311/db'
import WebSocket from 'ws'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  idemKey,
  insertRunRow,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
} from './helpers.js'

const TAKE_TIMEOUT_MS = 3000
const NEGATIVE_WINDOW_MS = 500
const silence = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface NodeFrame {
  type: string
  payload: Record<string, unknown>
}

/** Node 端客户端：常驻监听收集下行帧；closeCode 记录被 Hub 断连的码（-1 = 未断）。 */
interface NodeClient {
  frames: NodeFrame[]
  closeCode: number
  take(n: number, timeoutMs?: number): Promise<NodeFrame[]>
}

describe('#52 越边毒帧类清零（Hub 真人路径）', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let nodeUrl: string
  const nodeSockets: WebSocket[] = []

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
  })
  afterEach(async () => {
    for (const s of nodeSockets.splice(0)) s.terminate()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  // ---- 真人路径驱动 helpers（与 run-projection.integration.spec 同型）----

  async function pairDevice(as: Session): Promise<{ deviceId: string; deviceToken: string }> {
    const codeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { origin: ctx.origin, cookie: as.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    expect(codeRes.statusCode).toBe(201)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code: codeRes.json().data.code,
        name: `p52-node-${randomUUID().slice(0, 8)}`,
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

  function nodeClient(socket: WebSocket): NodeClient {
    const client: NodeClient = { frames: [], closeCode: -1, take }
    socket.on('message', (raw: unknown) => {
      client.frames.push(JSON.parse(String(raw)) as NodeFrame)
    })
    socket.on('close', (code: number) => {
      client.closeCode = code
    })
    async function take(n: number, timeoutMs = TAKE_TIMEOUT_MS): Promise<NodeFrame[]> {
      const deadline = Date.now() + timeoutMs
      while (client.frames.length < n) {
        if (Date.now() >= deadline) {
          throw new Error(
            `timeout waiting ${n} node frames; got ${JSON.stringify(client.frames)}; closeCode=${client.closeCode}`,
          )
        }
        await silence(20)
      }
      return client.frames.splice(0, client.frames.length)
    }
    return client
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

  function runEvent(runId: string, seq: number, event: Record<string, unknown>, audience: string) {
    return nodeFrame('run.event', {
      runId,
      seq,
      occurredAt: new Date().toISOString(),
      audience,
      event,
    })
  }

  /** Run 前置链：running 状态（真实 WS 用例只需要一条挂在配对设备上的活跃 Run）。 */
  async function seedRunFor(deviceId: string, status: 'running' = 'running'): Promise<string> {
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
      title: '#52 task',
      assigneeUserId: alice.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: alice.userId,
    })
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId,
      ownerUserId: alice.userId,
      name: 'ws-p52',
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
      status,
      dshSessionId: 's-p52',
    })
  }

  function approvalCard(runId: string, approvalId: string, callId: string) {
    return {
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
  }

  /** 真实 WS 路径把 Run 推到 waiting_approval（owner+project 双受众行）。 */
  async function driveToWaitingApproval(
    socket: WebSocket,
    node: NodeClient,
    runId: string,
    firstSeq: number,
  ): Promise<{ approvalId: string; callId: string }> {
    const approvalId = randomUUID()
    const callId = randomUUID()
    const card = approvalCard(runId, approvalId, callId)
    socket.send(runEvent(runId, firstSeq, { type: 'approval.requested', approval: card }, 'owner'))
    socket.send(
      runEvent(
        runId,
        firstSeq + 1,
        {
          type: 'approval.requested',
          approval: { ...card, reason: '', preview: { category: 'shell' } },
        },
        'project',
      ),
    )
    const acks = await node.take(2)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: firstSeq } })
    expect(acks[1]?.payload.throughSeq).toBe(firstSeq + 1)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('waiting_approval')
    return { approvalId, callId }
  }

  async function runRow(runId: string) {
    const [row] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    return row
  }

  async function eventRows(runId: string) {
    return database.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.seq)
  }

  async function teamEvents(type: string) {
    return database.db.select().from(schema.teamEvents).where(eq(schema.teamEvents.type, type))
  }

  // ---- 用例 ----

  it('waiting_approval + run.completed：连接存活、真终态、留证、折叠 cancelled、水位推进', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)
    const { approvalId } = await driveToWaitingApproval(socket, node, runId, 1)

    socket.send(runEvent(runId, 3, { type: 'run.completed', finalText: 'done' }, 'owner'))
    socket.send(runEvent(runId, 4, { type: 'run.completed', finalText: 'done' }, 'project'))
    const acks = await node.take(2)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 3 } })
    expect(acks[1]?.payload.throughSeq).toBe(4)

    // 判据 1a：连接存活——无 close 码，随后一帧心跳仍被处理（连接是活的）。
    expect(node.closeCode).toBe(-1)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.send(nodeFrame('node.heartbeat', { deviceId, activeRunIds: [], lastEventSeqByRun: {} }))
    await silence(NEGATIVE_WINDOW_MS)
    expect(node.closeCode).toBe(-1)
    expect(socket.readyState).toBe(WebSocket.OPEN)

    // 判据 1b：真终态 completed（不是 failed——裁决真值必须赢）。
    const run = await runRow(runId)
    expect(run?.status).toBe('completed')
    expect(run?.finishedAt).not.toBeNull()
    expect(run?.failureCode).toBeNull()

    // 判据 1c：留证——owner/project 两行都在（现状会被同事务回滚抹掉，直接证伪）。
    const rows = await eventRows(runId)
    expect(rows.map((r) => [r.seq, r.audience, r.type])).toEqual([
      [1, 'owner', 'approval.requested'],
      [2, 'project', 'approval.requested'],
      [3, 'owner', 'run.completed'],
      [4, 'project', 'run.completed'],
    ])

    // 判据 1d：pending Approval 折叠为 cancelled（cause=run_terminal_fold），有广播。
    const [approval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
    expect(approval?.status).toBe('cancelled')
    expect(approval?.decidedBy).toBe(alice.userId)
    expect(approval?.decidedAt).not.toBeNull()
    const folds = await teamEvents('approval.changed')
    expect(
      folds.some(
        (e) =>
          (e.payload as { approvalId?: string; status?: string; cause?: string }).approvalId ===
            approvalId &&
          (e.payload as { status?: string }).status === 'cancelled' &&
          (e.payload as { cause?: string }).cause === 'run_terminal_fold',
      ),
    ).toBe(true)

    // 迁移仅 owner 行驱动：completed 的 run.changed 恰一条（project 行纯镜像）。
    const changed = await teamEvents('run.changed')
    expect(
      changed.filter(
        (e) =>
          (e.payload as { runId?: string; status?: string }).runId === runId &&
          (e.payload as { status?: string }).status === 'completed',
      ),
    ).toHaveLength(1)
  })

  it('waiting_approval + run.failed（Runtime 崩溃同型事实）：failed(RUNTIME_LOST)、折叠、连接存活', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)
    const { approvalId } = await driveToWaitingApproval(socket, node, runId, 1)

    socket.send(
      runEvent(
        runId,
        3,
        { type: 'run.failed', code: 'RUNTIME_LOST', summary: 'runtime exited (code=7)' },
        'owner',
      ),
    )
    const acks = await node.take(1)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 3 } })
    expect(node.closeCode).toBe(-1)

    const run = await runRow(runId)
    expect(run?.status).toBe('failed')
    expect(run?.failureCode).toBe('RUNTIME_LOST')
    expect(run?.failureSummary).toBe('runtime exited (code=7)')
    const [approval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
    expect(approval?.status).toBe('cancelled')
    const folds = await teamEvents('approval.changed')
    expect(
      folds.some(
        (e) =>
          (e.payload as { status?: string; cause?: string }).status === 'cancelled' &&
          (e.payload as { cause?: string }).cause === 'run_terminal_fold',
      ),
    ).toBe(true)
  })

  it('表外兜底：cancel_requested 后 run.completed → 留证 + failed(INVALID_RUN_TRANSITION) + 连接存活', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)
    await driveToWaitingApproval(socket, node, runId, 1)

    // 真人 HTTP 路径取消：waiting_approval → cancel_requested（G5-07 已折叠审批）。
    const cancelRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
    })
    expect(cancelRes.statusCode).toBe(200)
    expect((await runRow(runId))?.status).toBe('cancel_requested')

    // 表外边：cancel_requested 不收 completed（决策不动这张边）→ 降级 Run 级。
    socket.send(runEvent(runId, 3, { type: 'run.completed', finalText: 'too late' }, 'owner'))
    const acks = await node.take(1)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 3 } })
    expect(node.closeCode).toBe(-1)
    expect(socket.readyState).toBe(WebSocket.OPEN)

    // 留证：事件行提交（现状：与迁移同事务回滚，行不存在）。
    const rows = await eventRows(runId)
    expect(
      rows.some(
        (r) =>
          r.seq === 3 &&
          r.audience === 'owner' &&
          (r.payload as { type?: string }).type === 'run.completed',
      ),
    ).toBe(true)

    const run = await runRow(runId)
    expect(run?.status).toBe('failed')
    expect(run?.failureCode).toBe('INVALID_RUN_TRANSITION')
    expect(run?.failureSummary).toContain('cannot apply')
  })

  it('表外兜底近亲：approval.decided 引用缺失行 → 留证 + Run 级收敛 + 连接存活', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)

    socket.send(
      runEvent(
        runId,
        1,
        { type: 'approval.decided', approvalId: randomUUID(), status: 'allowed_once' },
        'owner',
      ),
    )
    const acks = await node.take(1)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 1 } })
    expect(node.closeCode).toBe(-1)

    const rows = await eventRows(runId)
    expect(rows.some((r) => r.seq === 1 && r.type === 'approval.decided')).toBe(true)
    const run = await runRow(runId)
    expect(run?.status).toBe('failed')
    expect(run?.failureCode).toBe('INVALID_RUN_TRANSITION')
  })

  it('resend_from 引擎拆不掉毒：两轮心跳各触发补发，一次应用即收敛、零断连', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)
    await driveToWaitingApproval(socket, node, runId, 1)

    // 心跳#1：Node 水位(4) > Hub 水位(2) → resend_from(3)。
    socket.send(
      nodeFrame('node.heartbeat', {
        deviceId,
        activeRunIds: [runId],
        lastEventSeqByRun: { [runId]: 4 },
      }),
    )
    const first = await node.take(1)
    expect(first[0]).toMatchObject({
      type: 'run.resend_from',
      payload: { runId, fromSeq: 3 },
    })
    // Node 照命令补发毒帧（真实 drain 语义）：修复后一次应用即收敛。
    socket.send(runEvent(runId, 3, { type: 'run.completed', finalText: 'done' }, 'owner'))
    socket.send(runEvent(runId, 4, { type: 'run.completed', finalText: 'done' }, 'project'))
    const acks = await node.take(2)
    expect(acks[1]?.payload.throughSeq).toBe(4)
    expect(node.closeCode).toBe(-1)

    // 心跳#2：水位已追平 → 不得再有 resend_from，也不得断连（毒帧循环引擎拆除）。
    socket.send(
      nodeFrame('node.heartbeat', {
        deviceId,
        activeRunIds: [runId],
        lastEventSeqByRun: { [runId]: 4 },
      }),
    )
    const seen = node.frames.length
    await silence(NEGATIVE_WINDOW_MS)
    expect(node.frames.slice(seen)).toEqual([])
    expect(node.closeCode).toBe(-1)
    expect((await runRow(runId))?.status).toBe('completed')
  })

  it('R6 + 重连 drain：毒帧应用后全量补发不产生第二行、不二次迁移、不 4003', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)
    await driveToWaitingApproval(socket, node, runId, 1)
    const card = { type: 'run.completed', finalText: 'done' }
    socket.send(runEvent(runId, 3, card, 'owner'))
    socket.send(runEvent(runId, 4, card, 'project'))
    await node.take(2)
    expect(node.closeCode).toBe(-1)

    // 同 (runId,seq) 重放（R6）：幂等已应用，ack 只陈述水位。
    socket.send(runEvent(runId, 3, card, 'owner'))
    const dupAcks = await node.take(1)
    expect(dupAcks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 4 } })
    expect(node.closeCode).toBe(-1)

    // 重连 drain（R1）：模拟 spool 未 GC 的全量补发 1..4。
    socket.terminate()
    await silence(100)
    const socket2 = await connectNode(deviceToken)
    const node2 = nodeClient(socket2)
    socket2.send(
      runEvent(
        runId,
        1,
        { type: 'approval.requested', approval: approvalCard(runId, randomUUID(), randomUUID()) },
        'owner',
      ),
    )
    socket2.send(
      runEvent(
        runId,
        2,
        { type: 'approval.requested', approval: approvalCard(runId, randomUUID(), randomUUID()) },
        'project',
      ),
    )
    socket2.send(runEvent(runId, 3, card, 'owner'))
    socket2.send(runEvent(runId, 4, card, 'project'))
    const drainAcks = await node2.take(4)
    for (const ack of drainAcks) {
      expect(ack).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 4 } })
    }
    expect(node2.closeCode).toBe(-1)
    const rows = await eventRows(runId)
    expect(rows).toHaveLength(4) // 无第二行
    expect((await runRow(runId))?.status).toBe('completed') // 状态不回摆
  })

  it('终态禁复活：completed 后迟到 run.failed 只留证不动状态、不断连', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socket = await connectNode(deviceToken)
    const node = nodeClient(socket)
    const runId = await seedRunFor(deviceId)
    await driveToWaitingApproval(socket, node, runId, 1)
    socket.send(runEvent(runId, 3, { type: 'run.completed', finalText: 'done' }, 'owner'))
    await node.take(1)

    socket.send(
      runEvent(runId, 4, { type: 'run.failed', code: 'RUNTIME_LOST', summary: 'late' }, 'owner'),
    )
    const acks = await node.take(1)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { throughSeq: 4 } })
    expect(node.closeCode).toBe(-1)

    const rows = await eventRows(runId)
    expect(rows.some((r) => r.seq === 4 && r.type === 'run.failed')).toBe(true) // 留证
    const run = await runRow(runId)
    expect(run?.status).toBe('completed') // 不动状态
    expect(run?.failureCode).toBeNull()
    const changed = await teamEvents('run.changed')
    expect(
      changed.filter(
        (e) =>
          (e.payload as { runId?: string; status?: string }).runId === runId &&
          (e.payload as { status?: string }).status === 'failed',
      ),
    ).toHaveLength(0)
  })

  it('反向守门：结构坏帧与越权帧仍然 4003（惩罚边界只收窄不放宽）', async () => {
    const { deviceId, deviceToken } = await pairDevice(alice)
    const socketA = await connectNode(deviceToken)
    const nodeA = nodeClient(socketA)

    // (a) 结构坏：runId 非法 uuid → parseNodeFrame 拒绝 → 连接级 fail-closed。
    socketA.send(runEvent('not-a-uuid', 1, { type: 'run.phase', phase: 'tool' }, 'project'))
    expect(await waitForClose(nodeA)).toBe(4003)

    // (b) 越权：设备 2 的合法帧引用设备 1 的 Run → FORBIDDEN → 4003。
    const second = await pairDevice(alice)
    const runId = await seedRunFor(deviceId)
    const socketB = await connectNode(second.deviceToken)
    const nodeB = nodeClient(socketB)
    socketB.send(runEvent(runId, 1, { type: 'run.phase', phase: 'tool' }, 'project'))
    expect(await waitForClose(nodeB)).toBe(4003)
    // 受害者设备 1 的既有连接不受牵连（另一条连接仍可用）。
    const socketC = await connectNode(deviceToken)
    const nodeC = nodeClient(socketC)
    socketC.send(runEvent(runId, 1, { type: 'run.phase', phase: 'tool' }, 'project'))
    const acks = await nodeC.take(1)
    expect(acks[0]).toMatchObject({ type: 'run.event_ack', payload: { runId, throughSeq: 1 } })
    expect(nodeC.closeCode).toBe(-1)
  })
})

async function waitForClose(client: { closeCode: number }): Promise<number> {
  const deadline = Date.now() + 3000
  while (client.closeCode === -1) {
    if (Date.now() >= deadline) throw new Error('expected socket close, got none')
    await silence(20)
  }
  return client.closeCode
}
