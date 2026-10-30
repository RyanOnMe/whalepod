/**
 * ADR-0024 / PC-02a（#455）：来源绑定的 Hub 生命周期。
 *
 * 驱动全部走真人路径：
 * - 成员 HTTP（Fastify inject，Session + Origin + Idempotency-Key）；
 * - 采集 Node 走真实 /ws/v1/node WebSocket（假 Node 只模拟平台侧只读检查的应答，
 *   不绕过 Hub 的协议解析、连接注册表、状态机或事务）。
 *
 * 直读表只用于断言与时间模拟；不用直插来源表的方式制造业务状态。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import type { FastifyInstance } from 'fastify'
import type { Database } from '@whalepod/db'
import { getDeviceById, listTeamEvents, schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'
import { reconcileSourcePermissions } from '../src/modules/source/reconciler.js'
import { nodeConnections } from '../src/modules/device/connection-registry.js'

const FEISHU_GROUP = 'feishu.read.v1'

function nodeFrame(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  })
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || (typeof address === 'object' && !('port' in address))) {
    throw new Error('no listen port')
  }
  return `ws://127.0.0.1:${(address as { port: number }).port}/ws/v1/node`
}

/** 假 Node：只应答 source.permission_check；hello 声明能力（或按测试省略）。 */
class FakeSourceNode {
  readonly checks: Array<Record<string, unknown>> = []
  mode: 'readable' | 'denied' | 'not_found' | 'unsupported' | 'silent' = 'readable'
  appKey = 'fixture-app-key'

  constructor(
    readonly socket: WebSocket,
    readonly label: string,
  ) {
    socket.on('message', (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> }
      if (frame.type !== 'source.permission_check') return
      this.checks.push(frame.payload)
      if (this.mode === 'silent') return
      const payload =
        this.mode === 'readable'
          ? {
              requestId: frame.payload.requestId,
              result: 'readable',
              appKey: this.appKey,
              upstreamVersion: 'v1',
            }
          : { requestId: frame.payload.requestId, result: this.mode }
      socket.send(nodeFrame('source.permission_result', payload))
    })
  }

  hello(deviceId: string, capabilities: readonly string[]): void {
    this.socket.send(
      nodeFrame('node.hello', {
        deviceId,
        nodeVersion: '24.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        supportedProtocolVersions: [1],
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: [],
        sourceCapabilities: [...capabilities],
      }),
    )
  }
}

describe('PC-02a project source lifecycle', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let url: string
  const sockets: WebSocket[] = []
  const nodes: FakeSourceNode[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: `pc02a-${randomUUID().slice(0, 8)}` },
    })
    projectId = project.json().data.id as string
    url = await listen(ctx.app)
  })

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    nodes.splice(0)
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
  })

  async function pair(
    as: Session,
    name: string,
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const code = await apiInject(ctx, as, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    expect(code.statusCode).toBe(201)
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code: code.json().data.code,
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

  async function connect(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Device ${token}` } })
      sockets.push(socket)
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  async function connectNode(
    device: { deviceId: string; deviceToken: string },
    label: string,
    capabilities: readonly string[] = [FEISHU_GROUP],
  ): Promise<FakeSourceNode> {
    const socket = await connect(device.deviceToken)
    const node = new FakeSourceNode(socket, label)
    nodes.push(node)
    node.hello(device.deviceId, capabilities)
    await waitForValue(async () => {
      const row = await getDeviceById(database.db, device.deviceId)
      const raw = (row?.capabilities as { sourceCapabilities?: unknown } | undefined)
        ?.sourceCapabilities
      if (!Array.isArray(raw)) return undefined
      return capabilities.length === 0 || raw.includes(FEISHU_GROUP) ? true : undefined
    }, `${label} hello capability persisted`)
    return node
  }

  function bindPayload(
    deviceId: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      platform: 'feishu',
      kind: 'group',
      resourceKey: `oc_${randomUUID()}`,
      displayLabel: '活动筹备群',
      collectorNodeId: deviceId,
      credentialSlot: 'feishu-app',
      shareScope: 'team',
      ...overrides,
    }
  }

  async function bind(
    as: Session,
    deviceId: string,
    overrides: Partial<Record<string, unknown>> = {},
    key: string = idemKey(),
  ) {
    return apiInject(ctx, as, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/sources`,
      payload: bindPayload(deviceId, overrides),
      idempotencyKey: key,
    })
  }

  async function sourceCount(): Promise<number> {
    const rows = await database.db.select().from(schema.projectSources)
    return rows.length
  }

  it('binds only after an online node advertises the capability; the view hides resource/app identity', async () => {
    const device = await pair(alice, 'alice-node-1')
    const node = await connectNode(device, 'alice-node-1')

    const created = await bind(alice, device.deviceId, { resourceKey: 'oc_visible_group' })
    expect(created.statusCode).toBe(201)
    const view = created.json().data
    expect(view).toMatchObject({
      projectId,
      platform: 'feishu',
      kind: 'group',
      status: 'active',
      permissionState: 'verified',
      shareScope: 'team',
      autoExtraction: false,
      authorizationGeneration: 1,
    })
    expect(view.boundBy).toBe(alice.userId)
    // 视图与日志面不含平台资源身份/凭据/应用身份。
    expect(JSON.stringify(view)).not.toContain('oc_visible_group')
    expect(JSON.stringify(view)).not.toContain('fixture-app-key')
    expect(node.checks).toHaveLength(1)
    expect(node.checks[0]).toMatchObject({
      platform: 'feishu',
      kind: 'group',
      resourceKey: 'oc_visible_group',
      credentialSlot: 'feishu-app',
    })
    expect(JSON.stringify(node.checks[0])).not.toContain('secret')

    // Team 可见：另一成员能读同一来源。
    const listAsBob = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/sources`,
    })
    expect(listAsBob.statusCode).toBe(200)
    expect(listAsBob.json().data).toHaveLength(1)
    expect(listAsBob.json().data[0].id).toBe(view.id)

    const detailAsBob = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/sources/${view.id}`,
    })
    expect(detailAsBob.statusCode).toBe(200)

    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, view.id))
    expect(audits.map((row) => row.action)).toEqual(['bound'])
    expect(JSON.stringify(audits)).not.toContain('oc_visible_group')
    expect(JSON.stringify(audits)).not.toContain('fixture-app-key')

    const events = (await listTeamEvents(database.db)).filter(
      (row) => row.type === 'source.changed',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      sourceId: view.id,
      projectId,
      status: 'active',
    })
  })

  it('rejects a node that does not advertise the capability', async () => {
    const device = await pair(bob, 'bob-node-1')
    const node = await connectNode(device, 'bob-node-1', [])

    const created = await bind(bob, device.deviceId)
    expect(created.statusCode).toBe(400)
    expect(created.json().error.code).toBe('SOURCE_UNSUPPORTED')
    expect(node.checks).toHaveLength(0)
    expect(await sourceCount()).toBe(0)
  })

  it('rejects binding through another member’s collector node as not found', async () => {
    const bobDevice = await pair(bob, 'bob-node-2')
    await connectNode(bobDevice, 'bob-node-2')

    const created = await bind(alice, bobDevice.deviceId)
    expect(created.statusCode).toBe(404)
    expect(created.json().error.code).toBe('NOT_FOUND')
    expect(await sourceCount()).toBe(0)
  })

  it('maps denied and not_found to the same 403 and persists nothing', async () => {
    const device = await pair(alice, 'alice-node-2')
    const node = await connectNode(device, 'alice-node-2')

    for (const mode of ['denied', 'not_found'] as const) {
      node.mode = mode
      const created = await bind(alice, device.deviceId)
      expect(created.statusCode).toBe(403)
      expect(created.json().error.code).toBe('SOURCE_NOT_READABLE')
    }
    expect(await sourceCount()).toBe(0)
  })

  it('is idempotent per key and rejects a second active binding of the same resource', async () => {
    const device = await pair(alice, 'alice-node-3')
    await connectNode(device, 'alice-node-3')
    const key = idemKey()

    const first = await bind(alice, device.deviceId, { resourceKey: 'oc_same_resource' }, key)
    expect(first.statusCode).toBe(201)
    const second = await bind(alice, device.deviceId, { resourceKey: 'oc_same_resource' }, key)
    expect(second.statusCode).toBe(201)
    expect(second.json().data.id).toBe(first.json().data.id)

    const duplicate = await bind(alice, device.deviceId, { resourceKey: 'oc_same_resource' })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('SOURCE_ALREADY_BOUND')
    expect(await sourceCount()).toBe(1)
  })

  it('lets only the binder/admin pause, resume and revoke; each transition bumps the generation', async () => {
    const device = await pair(alice, 'alice-node-4')
    const node = await connectNode(device, 'alice-node-4')
    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(201)
    const sourceId = created.json().data.id as string

    const denied = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/pause`,
      payload: {},
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('FORBIDDEN')

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/pause`,
      payload: {},
    })
    expect(paused.statusCode).toBe(200)
    expect(paused.json().data).toMatchObject({
      status: 'paused',
      authorizationGeneration: 2,
    })
    expect(paused.json().data.pausedAt).not.toBeNull()

    const checksBeforeResume = node.checks.length
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json().data).toMatchObject({
      status: 'active',
      permissionState: 'verified',
      authorizationGeneration: 3,
    })
    expect(resumed.json().data.pausedAt).toBeNull()
    expect(node.checks.length).toBe(checksBeforeResume + 1)

    const noReason = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/revoke`,
      payload: {},
    })
    expect(noReason.statusCode).toBe(400)
    expect(noReason.json().error.code).toBe('VALIDATION_FAILED')

    const revoked = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/revoke`,
      payload: { reason: '活动结束，停止同步' },
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json().data).toMatchObject({
      status: 'revoked',
      permissionState: 'denied',
      authorizationGeneration: 4,
      revokeReason: '活动结束，停止同步',
    })
    expect(revoked.json().data.revokedBy).toBe(alice.userId)
    expect(revoked.json().data.revokedAt).not.toBeNull()

    const events = (await listTeamEvents(database.db))
      .filter((row) => row.type === 'source.changed')
      .map((row) => row.payload as { status: string })
    expect(events.map((payload) => payload.status)).toEqual([
      'active',
      'paused',
      'active',
      'revoked',
    ])
  })

  it('allows rebinding the same external resource as a new row after revocation', async () => {
    const device = await pair(alice, 'alice-node-5')
    await connectNode(device, 'alice-node-5')
    const first = await bind(alice, device.deviceId, { resourceKey: 'oc_rebind' })
    expect(first.statusCode).toBe(201)
    const revoked = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${first.json().data.id}/revoke`,
      payload: { reason: '换一个采集者' },
    })
    expect(revoked.statusCode).toBe(200)

    const second = await bind(alice, device.deviceId, { resourceKey: 'oc_rebind' })
    expect(second.statusCode).toBe(201)
    expect(second.json().data.id).not.toBe(first.json().data.id)
    expect(second.json().data).toMatchObject({
      status: 'active',
      authorizationGeneration: 1,
    })
    expect(await sourceCount()).toBe(2)
  })

  it('rejects a second collector using the same app event stream while the lease is live', async () => {
    const device1 = await pair(alice, 'alice-node-6')
    const node1 = await connectNode(device1, 'alice-node-6')
    node1.appKey = 'shared-app-key'
    const device2 = await pair(alice, 'alice-node-7')
    const node2 = await connectNode(device2, 'alice-node-7')
    node2.appKey = 'shared-app-key'

    const first = await bind(alice, device1.deviceId, { resourceKey: 'oc_lease_a' })
    expect(first.statusCode).toBe(201)
    const second = await bind(alice, device2.deviceId, { resourceKey: 'oc_lease_b' })
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('SOURCE_LEASE_LOST')
    expect(await sourceCount()).toBe(1)
  })

  it('rejects binding when the collector node is offline', async () => {
    const device = await pair(alice, 'alice-node-8')
    const node = await connectNode(device, 'alice-node-8')
    node.socket.terminate()
    await waitForValue(
      async () => (nodeConnections.isOnline(device.deviceId) ? undefined : true),
      'collector socket detached',
    )

    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(409)
    expect(created.json().error.code).toBe('SOURCE_COLLECTOR_OFFLINE')
    expect(await sourceCount()).toBe(0)
  })

  it('reconciles verified → unknown after expiry and unknown → unavailable after 7 days', async () => {
    const device = await pair(alice, 'alice-node-9')
    await connectNode(device, 'alice-node-9')
    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(201)
    const sourceId = created.json().data.id as string

    // 时间模拟：直接改过期时刻，不制造业务状态。
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    const first = await reconcileSourcePermissions({ database, now })
    expect(first.expired).toBe(1)

    const unknown = await database.db
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.id, sourceId))
    expect(unknown[0]).toMatchObject({
      status: 'active',
      permissionState: 'unknown',
      authorizationGeneration: 2,
    })
    expect(unknown[0]?.permissionUnknownSince).not.toBeNull()

    // 时间模拟：把 unknown 起点推回 8 天前。
    await database.db
      .update(schema.projectSources)
      .set({ permissionUnknownSince: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.projectSources.id, sourceId))
    const second = await reconcileSourcePermissions({ database, now })
    expect(second.unavailable).toBe(1)

    const unavailable = await database.db
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.id, sourceId))
    expect(unavailable[0]).toMatchObject({
      status: 'unavailable',
      permissionState: 'unknown',
      authorizationGeneration: 3,
    })
    expect(unavailable[0]?.unavailableAt).not.toBeNull()

    const events = (await listTeamEvents(database.db))
      .filter((row) => row.type === 'source.changed')
      .map((row) => row.payload as { status: string; permissionState?: string })
    expect(events).toEqual([
      { sourceId, projectId, status: 'active' },
      { sourceId, projectId, status: 'active', permissionState: 'unknown' },
      { sourceId, projectId, status: 'unavailable', permissionState: 'unknown' },
    ])
  })

  it('requires a session for every source route', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/sources`,
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('AUTH_REQUIRED')
  })
})
