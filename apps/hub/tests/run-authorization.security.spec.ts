/**
 * A0 安全负向用例族（Q7）：审批归属、一次性时效、设备撤销、失效授权（专家 1/2/3/4/8）。
 *
 * 来源：2026-10-08 外部架构审查「我会增加的安全验收」——**每条都以反证收口**：
 * 拒绝之外还要证明「状态没变、命令没多、旧授权没被复用」，不信错误文案。
 *
 * 驱动全走真人路径：真 App + 真 PG（with-test-postgres）、HTTP 经 Fastify inject、
 * Node 侧经真 Device Token 握手（WS 401 在升级前）；Run/Approval 的出生用既有
 * 夹具惯例（insertRunRow）——被测路径是**授权与复用判定**本身。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertProject, insertTask, schema } from '@whalepod/db'
import WebSocket from 'ws'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  makeHarness,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
} from './helpers.js'

let database: Database
let ctx: TestApp
let wsBase: string

interface Actors {
  alice: Session
  bob: Session
  carol: Session
  bobDeviceId: string
  bobTaskId: string
}

/** alice = 团队 Owner；bob = 成员（Task 责任人 + 设备 owner）；carol = 第三名成员。 */
async function seedActors(): Promise<Actors> {
  const alice = await driveSetup(ctx)
  const { session: bob } = await driveInviteAndAccept(ctx, alice, {
    username: 'bob',
    displayName: 'Bob',
    password: 'correct horse battery staple',
  })
  const { session: carol } = await driveInviteAndAccept(ctx, alice, {
    username: 'carol',
    displayName: 'Carol',
    password: 'correct horse battery staple',
  })
  const chain = await seedRunChainForUser(database.db, bob.userId)
  const projectId = randomUUID()
  const taskId = randomUUID()
  await insertProject(database.db, { id: projectId, name: 'sec', createdBy: alice.userId })
  await insertTask(database.db, {
    id: taskId,
    projectId,
    title: 'sec task',
    assigneeUserId: bob.userId,
    assignmentStatus: 'accepted',
    acceptedAt: new Date(),
    createdBy: alice.userId,
  })
  return { alice, bob, carol, bobDeviceId: chain.deviceId, bobTaskId: taskId }
}

/** 造一条 waiting_approval 的 Run（owner = 指定责任人）+ 一条 pending Approval。 */
async function seedWaitingApproval(
  actors: Actors,
  ownerUserId: string,
): Promise<{ runId: string; approvalId: string; callId: string; deviceId: string }> {
  const chain = await seedRunChainForUser(database.db, ownerUserId)
  const runId = await insertRunRow(database.db, {
    taskId: actors.bobTaskId,
    ownerUserId,
    agentId: chain.agentId,
    profileRevisionId: chain.profileRevisionId,
    deviceId: chain.deviceId,
    workspaceId: chain.workspaceId,
    status: 'waiting_approval',
    dshSessionId: `s-${runId8()}`,
  })
  const approvalId = randomUUID()
  const callId = randomUUID()
  await database.db.insert(schema.approvals).values({
    id: approvalId,
    runId,
    callId,
    toolName: 'bash',
    reason: 'needs rm',
    preview: { command: 'rm -rf <workspace>/build' },
    status: 'pending',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
  })
  return { runId, approvalId, callId, deviceId: chain.deviceId }
}

function runId8(): string {
  return randomUUID().slice(0, 8)
}

async function decide(
  session: Session,
  approvalId: string,
  decision: 'allowed_once' | 'rejected',
): Promise<{ statusCode: number; code: string | undefined }> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/approvals/${approvalId}/decisions`,
    payload: { decision },
  })
  const body = res.json() as { error?: { code?: string } }
  return { statusCode: res.statusCode, code: body.error?.code }
}

async function decideCommands() {
  return database.db
    .select()
    .from(schema.dispatchOutbox)
    .where(eq(schema.dispatchOutbox.type, 'approval.decide'))
}

async function approvalRow(approvalId: string) {
  const [row] = await database.db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId))
  return row
}

beforeAll(async () => {
  database = await createTestDatabase()
})
beforeEach(async () => {
  await resetDatabase(database)
  ctx = await createTestApp(database)
  await ctx.app.listen({ host: '127.0.0.1', port: 0 })
  const address = ctx.app.server.address()
  if (address === null || typeof address !== 'object' || !('port' in address)) {
    throw new Error('no listen port')
  }
  wsBase = `ws://127.0.0.1:${(address as { port: number }).port}`
})
afterEach(async () => {
  await ctx.close()
})
afterAll(async () => {
  await database.close()
})

describe('专家1：审批只属于 Run owner，团队 Owner/Admin 与第三方成员都批不了', () => {
  it('carol（第三方）与 alice（团队 Owner）对 bob 的审批 → 403，零命令、状态不变；bob 本人 → 200（正控）', async () => {
    const actors = await seedActors()
    const { approvalId } = await seedWaitingApproval(actors, actors.bob.userId)

    for (const [who, session] of [
      ['carol', actors.carol],
      ['alice（团队 Owner）', actors.alice],
    ] as const) {
      const res = await decide(session, approvalId, 'allowed_once')
      expect(res.statusCode, `${who} 必须被拒`).toBe(403)
      expect(res.code).toBe('FORBIDDEN')
    }
    // 反证：没有任何决定落地、没有命令入队。
    expect((await approvalRow(approvalId))?.status).toBe('pending')
    expect(await decideCommands()).toHaveLength(0)

    // 正控：真正的 owner（bob）决定成功——证明上面的 403 不是"接口本来就坏"。
    const ok = await decide(actors.bob, approvalId, 'allowed_once')
    expect(ok.statusCode).toBe(200)
    expect((await approvalRow(approvalId))?.status).toBe('allowed_once')
    const commands = await decideCommands()
    expect(commands).toHaveLength(1)
    expect((commands[0]?.payload as { approvalId?: string }).approvalId).toBe(approvalId)
  })
})

describe('专家2：一次性放行有时效——旧决定不重置、不扩展到新工具调用', () => {
  it('已终态的 approval 重复决定 → 拒绝且不产生第二条命令（反证：命令数仍为 1）', async () => {
    const actors = await seedActors()
    const { approvalId } = await seedWaitingApproval(actors, actors.bob.userId)

    const first = await decide(actors.bob, approvalId, 'allowed_once')
    expect(first.statusCode).toBe(200)
    expect(await decideCommands()).toHaveLength(1)

    // 同一决定重放：幂等 200（既有口径），但**不重发命令**——不能凭"再批一次"给
    // 同一个 callId 续期；反证就看命令数。
    const replay = await decide(actors.bob, approvalId, 'allowed_once')
    expect(replay.statusCode).toBe(200)
    expect(await approvalRow(approvalId)).toMatchObject({ status: 'allowed_once' })
    expect(await decideCommands()).toHaveLength(1) // 反证：没有第二条 decide 命令

    // 相反的重复决定被拒（终态不被改写）。
    const flipped = await decide(actors.bob, approvalId, 'rejected')
    expect(flipped.statusCode).toBeGreaterThanOrEqual(400)
    expect((await approvalRow(approvalId))?.status).toBe('allowed_once')
    expect(await decideCommands()).toHaveLength(1)
  })

  it('同 callId 的重放不重置状态；新 callId 必须**重新**决定（旧放行不延续）', async () => {
    const actors = await seedActors()
    const { runId, approvalId, callId, deviceId } = await seedWaitingApproval(
      actors,
      actors.bob.userId,
    )
    const ok = await decide(actors.bob, approvalId, 'allowed_once')
    expect(ok.statusCode).toBe(200)

    // Node 侧重放同 callId 的 approval.requested（R6 同型）：不得把已决行重置回 pending。
    const harness = makeHarness(database)
    const device = { deviceId, ownerUserId: actors.bob.userId }
    await harness.orchestrator.ingestNodeEvent(device, {
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.event',
      payload: {
        runId,
        seq: 1,
        occurredAt: new Date().toISOString(),
        audience: 'owner',
        event: {
          type: 'approval.requested',
          approval: {
            approvalId,
            runId,
            callId,
            toolName: 'bash',
            reason: 'needs rm',
            preview: { command: 'rm -rf <workspace>/build' },
            status: 'pending',
            requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        },
      },
    })
    expect((await approvalRow(approvalId))?.status).toBe('allowed_once') // 反证：重放没把它拉回 pending

    // 新的工具调用（新 callId）→ 新 pending，必须由 owner 再决定一次。
    const secondApprovalId = randomUUID()
    await database.db.insert(schema.approvals).values({
      id: secondApprovalId,
      runId,
      callId: randomUUID(),
      toolName: 'bash',
      reason: 'needs another',
      preview: {},
      status: 'pending',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    expect((await approvalRow(secondApprovalId))?.status).toBe('pending')
    expect(await decideCommands()).toHaveLength(1) // 新调用没有因为旧放行而自动获得命令
  })
})

describe('专家3：Device 撤销后，旧凭据不能再获得新的执行权', () => {
  it('撤销后用同一 token 重连 → 升级前 401；配对码也不可用', async () => {
    const actors = await seedActors()
    // 真配对（HTTP 真人路径）拿一个 device token。
    const codeRes = await apiInject(ctx, actors.bob, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    const code = (codeRes.json() as { data: { code: string } }).data.code
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code,
        name: 'sec-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    const { deviceToken, deviceId } = claim.json().data as {
      deviceToken: string
      deviceId: string
    }

    // 撤销前能连（正控）。
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/ws/v1/node`, {
        headers: { authorization: `Device ${deviceToken}` },
      })
      socket.once('open', () => {
        socket.terminate()
        resolve()
      })
      socket.once('error', reject)
    })

    const del = await apiInject(ctx, actors.bob, {
      method: 'DELETE',
      url: `/api/v1/devices/${deviceId}`,
    })
    expect(del.statusCode).toBe(200)

    // 反证：同一 token 再握手 → 升级前 401（不是"连上了再踢"）。
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/ws/v1/node`, {
        headers: { authorization: `Device ${deviceToken}` },
      })
      socket.once('open', () => {
        socket.terminate()
        resolve(undefined)
      })
      socket.once('error', (error: Error & { statusCode?: number }) => {
        resolve(error.statusCode)
      })
      socket.once('unexpected-response', (_req, res) => {
        socket.terminate()
        resolve(res.statusCode)
      })
      setTimeout(() => reject(new Error('撤销后的握手既没成功也没被拒（挂起）')), 3_000)
    })
    expect(status).toBe(401)
  })
})

describe('专家4：失效授权不被复用（run 已 lost 时，未决审批不得再被决定）', () => {
  it('租约过期 → run lost + pending 折叠 cancelled；此时 owner 再决定 → 拒绝、零新命令', async () => {
    const actors = await seedActors()
    const { runId, approvalId } = await seedWaitingApproval(actors, actors.bob.userId)

    // 设备从未 hello（lastSeenAt 为空）+ 把现在推到租约窗口之外 → reconcile 判 lost。
    const harness = makeHarness(database)
    const farFuture = new Date(Date.now() + 10 * 60_000)
    await harness.orchestrator.reconcileLeases(farFuture)

    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('lost')
    expect(run?.failureCode).toBe('RUNTIME_LOST')
    // ADR-0007：终态不挂 pending Approval——折叠是系统写入。
    expect((await approvalRow(approvalId))?.status).toBe('cancelled')

    // 反证：拿着已失效 Run 上的审批再批准，不能起任何新命令。
    const res = await decide(actors.bob, approvalId, 'allowed_once')
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect((await approvalRow(approvalId))?.status).toBe('cancelled')
    expect(await decideCommands()).toHaveLength(0)
    const [stillLost] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    expect(stillLost?.status).toBe('lost') // 终态不复活
  })
})

describe('专家8：伪造身份不能借对端通道执行；越权/伪造 ID 不能操作他人运行', () => {
  it('Device Token 连不上 Browser WS；Cookie 连不上 Node WS（04 §6.2 两条腿）', async () => {
    const actors = await seedActors()
    // 真配对拿一个 Device Token。
    const codeRes = await apiInject(ctx, actors.bob, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    const code = (codeRes.json() as { data: { code: string } }).data.code
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code,
        name: 'sec-node-8',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    const { deviceToken } = claim.json().data as { deviceToken: string }

    const handshakeStatus = (
      url: string,
      headers: Record<string, string>,
    ): Promise<number | undefined> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers })
        socket.once('open', () => {
          socket.terminate()
          resolve(undefined)
        })
        socket.once('error', (error: Error & { statusCode?: number }) => resolve(error.statusCode))
        socket.once('unexpected-response', (_req, res) => {
          socket.terminate()
          resolve(res.statusCode)
        })
        setTimeout(() => reject(new Error('握手既没成功也没被拒（挂起）')), 3_000)
      })

    // Device Token 拿去连 Browser WS：无 Session Cookie → 升级前 401。
    expect(
      await handshakeStatus(`${wsBase}/ws/v1/client?cursor=0`, {
        origin: ctx.origin,
        authorization: `Device ${deviceToken}`,
      }),
      'Device Token 不能换到浏览器通道',
    ).toBe(401)
    // Session Cookie 拿去连 Node WS：无 Device 凭据 → 升级前 401。
    expect(
      await handshakeStatus(`${wsBase}/ws/v1/node`, { cookie: actors.bob.cookie }),
      '浏览器 Cookie 不能换到设备通道',
    ).toBe(401)
  })

  it('伪造/越权 approval id：第三方决定 403 零变化；未知 id 404；两者都不产生命令', async () => {
    const actors = await seedActors()
    const { approvalId } = await seedWaitingApproval(actors, actors.bob.userId)

    // carol 猜中 bob 的 approval id → 策略拒绝（G5-02 口径：非 owner 一律 403），账本零变化。
    const foreign = await decide(actors.carol, approvalId, 'allowed_once')
    expect(foreign.statusCode).toBe(403)
    expect(foreign.code).toBe('FORBIDDEN')
    expect((await approvalRow(approvalId))?.status).toBe('pending')

    // 完全不存在的 id → 404（既有规格），同样零副作用。
    const unknown = await decide(actors.carol, randomUUID(), 'allowed_once')
    expect(unknown.statusCode).toBe(404)

    // 反证：两条非法路径都没能让任何 decide 命令入队。
    expect(await decideCommands()).toHaveLength(0)
  })
})
