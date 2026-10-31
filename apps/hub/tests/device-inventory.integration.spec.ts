/**
 * node.inventory → /workspaces 投影集成测试（P1-12；03 §2.4/§4、G3-04、02 Task 12 Step 3）。
 *
 * 判定基线：
 * - 真实 WS 上行 node.inventory → Hub owner 校验（恒等 Device owner）+ 不透明投影 upsert；
 * - GET /api/v1/workspaces 只返回当前 Member 自己的投影（无任何本地路径字段）；
 * - 同名重注册替换旧投影（Node registry 镜像语义，重放收敛）；
 * - inventory 刷 lastSeenAt，但不动 #37 运行时事实列（dsh 版本仍为 null）。
 */
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@whalepod/db'
import { getDeviceById, schema } from '@whalepod/db'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { nodeConnections } from '../src/modules/device/connection-registry.js'
import {
  apiInject,
  createTestApp,
  insertRunRow,
  seedRunChainForUser,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

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

describe('device inventory → workspaces 投影', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let url: string
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx)
    bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    url = await listen(ctx.app)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const s of sockets.splice(0)) s.terminate()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function pair(as: Session): Promise<{ deviceId: string; deviceToken: string }> {
    const codeRes = await apiInject(ctx, as, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: codeRes.json().data.code as string,
        name: 'inventory-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    return claim.json().data as { deviceId: string; deviceToken: string }
  }

  function connect(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Device ${token}` } })
      sockets.push(socket)
      socket.once('open', () => resolve(socket))
      socket.once('error', (error: Error) => reject(error))
    })
  }

  function sendInventory(
    socket: WebSocket,
    deviceId: string,
    workspaces: Array<Record<string, unknown>>,
    credentialSlots: Array<Record<string, string>> = [],
  ): void {
    socket.send(nodeFrame('node.inventory', { deviceId, workspaces, credentialSlots }))
  }

  it('#320 责任人HTTP经本人Node连接检查固定版本；非责任人零探针', async () => {
    const ids = await seedRunChainForUser(database.db, alice.userId)
    // 静态Agent/Task前置沿用已登记fixtures；只把任务指派给真人，设备由真实配对建立。
    const createdProject = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: '准备' },
    })
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${createdProject.json().data.id}/tasks`,
      payload: { title: '准备检查', assigneeUserId: alice.userId },
    })
    const taskId = task.json().data.id as string
    const paired = await pair(alice)
    const socket = await connect(paired.deviceToken)
    const workspaceId = randomUUID()
    socket.send(
      nodeFrame('node.hello', {
        deviceId: paired.deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: 'fixture-version',
        pluginPackDigests: [],
      }),
    )
    sendInventory(socket, paired.deviceId, [
      {
        workspaceId,
        name: 'private-work',
        kind: 'directory',
        capabilities: { read: true, write: true, git: false },
        available: true,
        lastCheckedAt: new Date().toISOString(),
      },
    ])
    await waitForValue(
      async () =>
        (await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/workspaces' }))
          .json()
          .data.find((row: { workspaceId: string }) => row.workspaceId === workspaceId),
      '等待本次检查的工作目录投影',
    )
    let probes = 0
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as {
        type: string
        payload: { requestId: string; provider: string; credentialSlot: string }
      }
      if (frame.type !== 'node.preparation_check') return
      probes++
      expect(frame.payload.provider).toBe('deepseek-official')
      expect(frame.payload.credentialSlot).toBe('default')
      socket.send(
        nodeFrame('node.preparation_result', {
          requestId: frame.payload.requestId,
          workspace: 'available',
          credential: 'configured',
        }),
      )
    })
    const payload = {
      agentId: ids.agentId,
      profileRevisionId: ids.profileRevisionId,
      deviceId: paired.deviceId,
      workspaceId,
    }
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/tasks/${taskId}/instruction-grants`,
          payload: { userId: bob.userId },
        })
      ).statusCode,
    ).toBe(201)
    const denied = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/preparation-check`,
      payload,
    })
    expect(denied.statusCode).toBe(403)
    expect(probes).toBe(0)
    const otherTask = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${createdProject.json().data.id}/tasks`,
      payload: { title: '成员自己的任务', assigneeUserId: bob.userId },
    })
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/tasks/${otherTask.json().data.id}/preparation-check`,
          payload,
        })
      ).statusCode,
    ).toBe(403)
    expect(probes).toBe(0)
    // 准备检查的应答也是活性证据：先把心跳投影推到 20 秒前（仍在在线窗口内），
    // 结果帧到达后应刷新到请求之后；不刷新则仍是 20 秒前。
    const staleSeen = new Date(Date.now() - 20_000)
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: staleSeen })
      .where(eq(schema.devices.id, paired.deviceId))
    const beforeCheck = Date.now()
    const checked = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/preparation-check`,
      payload,
    })
    expect(checked.statusCode).toBe(200)
    expect(checked.headers['cache-control']).toBe('no-store')
    expect(checked.json().data).toMatchObject({
      profileRevisionId: ids.profileRevisionId,
      deviceId: paired.deviceId,
      workspaceId,
      workspace: 'available',
      credential: 'configured',
      modelCall: 'not_tested',
    })
    expect(probes).toBe(1)
    expect(
      (await getDeviceById(database.db, paired.deviceId))?.lastSeenAt?.getTime() ?? 0,
    ).toBeGreaterThanOrEqual(beforeCheck)
    expect(JSON.stringify(checked.json())).not.toMatch(/deviceToken|canonicalPath|secretValue/)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
    // 在真实连接已交付结果后暂停HTTP继续；用另一条真实WS替换，再让路由收尾。
    const requestPreparation = nodeConnections.requestPreparation.bind(nodeConnections)
    vi.spyOn(nodeConnections, 'requestPreparation').mockImplementationOnce(async (...args) => {
      const snapshot = await requestPreparation(...args)
      await connect(paired.deviceToken)
      await waitForValue(async () => !snapshot.isCurrent(), '等待已交付快照的连接被替换')
      expect(nodeConnections.isOnline(paired.deviceId)).toBe(true)
      return snapshot
    })
    const replaced = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/preparation-check`,
      payload,
    })
    expect(replaced.statusCode).toBe(409)
    expect(replaced.json().data).toBeUndefined()
  })

  it('G3-04: inventory 上行 → 投影落库（owner 恒等 Device owner，无路径字段）', async () => {
    const { deviceId, deviceToken: token } = await pair(alice)
    const socket = await connect(token)
    sendInventory(socket, deviceId, [
      {
        workspaceId: randomUUID(),
        name: 'project-alpha',
        kind: 'git_repository',
        capabilities: { read: true, write: true, git: true },
        available: true,
        lastCheckedAt: new Date().toISOString(),
      },
      {
        workspaceId: randomUUID(),
        name: 'missing-dir',
        kind: 'directory',
        capabilities: { read: true, write: false, git: false },
        available: false,
        lastCheckedAt: new Date().toISOString(),
      },
    ])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).length === 2 ? true : undefined,
      '两份 inventory 未在超时内落库（期望 2 行投影）',
    )

    // owner 恒等 Alice；不透明投影：无任何路径字段。
    const rows = await database.db.select().from(schema.workspaces)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.ownerUserId).toBe(alice.userId)
      expect(JSON.stringify(row)).not.toContain('/Users/')
      expect(JSON.stringify(row)).not.toContain('canonical_path')
    }

    // GET /workspaces：Alice 看到两个投影（不透明：无本地路径；P1-13 起携带 deviceId
    // 供 Run Launcher 配对 workspace→device——deviceId 是不透明标识，03 §2.4 不破）。
    const mine = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/workspaces' })
    expect(mine.statusCode).toBe(200)
    const list = mine.json().data as Array<Record<string, unknown>>
    expect(list).toHaveLength(2)
    expect(list.map((w) => w.name).sort()).toEqual(['missing-dir', 'project-alpha'])
    for (const w of list) {
      expect(Object.keys(w).sort()).toEqual([
        'available',
        'capabilities',
        'deviceId',
        'kind',
        'lastCheckedAt',
        'name',
        'workspaceId',
      ])
    }

    // Bob（另一 Member）：看不到 Alice 的 Workspace。
    const bobs = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/workspaces' })
    expect(bobs.json().data).toEqual([])
  })

  it('同名重注册：旧投影被替换（镜像语义，重放收敛）', async () => {
    const { deviceId, deviceToken: token } = await pair(alice)
    const socket = await connect(token)
    const oldId = randomUUID()
    sendInventory(socket, deviceId, [
      {
        workspaceId: oldId,
        name: 'renamed-project',
        kind: 'directory',
        capabilities: { read: true, write: true, git: false },
        available: true,
        lastCheckedAt: new Date().toISOString(),
      },
    ])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).some((r) => r.id === oldId)
          ? true
          : undefined,
      '首轮 inventory 未在超时内落库（期望旧 id 出现）',
    )

    // Node 侧重注册（新 id、同名）后的第二轮 inventory。
    const newId = randomUUID()
    sendInventory(socket, deviceId, [
      {
        workspaceId: newId,
        name: 'renamed-project',
        kind: 'directory',
        capabilities: { read: true, write: true, git: false },
        available: true,
        lastCheckedAt: new Date().toISOString(),
      },
    ])
    await waitForValue(async () => {
      const current = await database.db.select().from(schema.workspaces)
      return current.length === 1 && current[0]?.id === newId ? true : undefined
    }, '同名重注册未在超时内完成投影替换（期望只剩新 id 一行）')

    const rows = await database.db.select().from(schema.workspaces)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(newId)

    const mine = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/workspaces' })
    expect((mine.json().data as Array<{ workspaceId: string }>)[0]?.workspaceId).toBe(newId)
  })

  it('inventory 刷新 lastSeenAt 但不动 #37 运行时事实列', async () => {
    const { deviceId, deviceToken: token } = await pair(alice)
    const socket = await connect(token)
    sendInventory(socket, deviceId, [])
    await waitForValue(
      async () => (await database.db.select().from(schema.devices))[0]?.lastSeenAt ?? undefined,
      'inventory 未在超时内刷新 lastSeenAt',
    )

    const [device] = await database.db.select().from(schema.devices).limit(1)
    expect(device?.lastSeenAt).not.toBeNull()
    // hello 才回填 #37 列；inventory 不越权。
    expect(device?.dshDistributionVersion).toBeNull()
    expect(device?.pluginPackDigests).toEqual([])
  })

  it('inventory 帧在未认证连接上被升级前 401 拒绝（与 hello/心跳同门）', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/ws/v1/node',
      headers: { connection: 'upgrade', upgrade: 'websocket' },
    })
    expect(res.statusCode).toBe(401)
  })

  // #94 删除收敛（变化时重报的 Hub 半边）。
  it('全量清单未覆盖的本设备 Workspace：无 Run 引用删行、有引用标 unavailable；重新上报恢复', async () => {
    const { deviceId, deviceToken: token } = await pair(alice)
    const socket = await connect(token)
    const keepId = randomUUID()
    const removedId = randomUUID()
    const ws = (workspaceId: string, name: string) => ({
      workspaceId,
      name,
      kind: 'directory',
      capabilities: { read: true, write: true, git: false },
      available: true,
      lastCheckedAt: new Date().toISOString(),
    })
    sendInventory(socket, deviceId, [ws(keepId, 'keep-me'), ws(removedId, 'removed-one')])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).length === 2 ? true : undefined,
      '两份 inventory 未在超时内落库',
    )

    // Node 侧 workspace remove 后的第二轮 inventory（全量快照只列存活项）。
    sendInventory(socket, deviceId, [ws(keepId, 'keep-me')])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).length === 1 ? true : undefined,
      'workspace remove 未在超时内收敛（期望只剩 keep-me 一行）',
    )

    const rows = await database.db.select().from(schema.workspaces)
    // 无 Run 引用的移除项：行被删除——投影与 Node registry 镜像一致。
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(keepId)
    expect(rows[0]?.available).toBe(true)

    // 有 Run 引用的移除项：行必须保留（runs.workspaceId FK），降级为 unavailable。
    const referencedId = randomUUID()
    sendInventory(socket, deviceId, [ws(keepId, 'keep-me'), ws(referencedId, 'has-runs')])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).some((r) => r.id === referencedId)
          ? true
          : undefined,
      'has-runs 工作区未在超时内出现在 Hub 投影',
    )
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'p-inventory-convergence' },
    })
    const projectId = (project.json() as { data: { id: string } }).data.id
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 't-inventory', assigneeUserId: alice.userId },
    })
    const taskId = (task.json() as { data: { id: string } }).data.id
    const chain = await seedRunChainForUser(database.db, alice.userId)
    await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: chain.agentId,
      profileRevisionId: chain.profileRevisionId,
      deviceId,
      workspaceId: referencedId,
      status: 'completed',
    })
    sendInventory(socket, deviceId, [ws(keepId, 'keep-me')])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).find((r) => r.id === referencedId)
          ?.available === false
          ? true
          : undefined,
      'has-runs 工作区未在超时内降级为 unavailable',
    )
    const after = await database.db.select().from(schema.workspaces)
    const referenced = after.find((r) => r.id === referencedId)
    expect(referenced).toBeDefined() // 行保留
    expect(referenced?.available).toBe(false) // 但不再可被新 Run 选用

    // 重新 add → 下一份全量清单带回 → 恢复 available（镜像语义闭环）。
    sendInventory(socket, deviceId, [ws(keepId, 'keep-me'), ws(referencedId, 'has-runs')])
    await waitForValue(
      async () =>
        (await database.db.select().from(schema.workspaces)).find((r) => r.id === referencedId)
          ?.available === true
          ? true
          : undefined,
      'has-runs 工作区未在超时内恢复 available',
    )
    const restored = await database.db.select().from(schema.workspaces)
    expect(restored.find((r) => r.id === referencedId)?.available).toBe(true)
  })
})
