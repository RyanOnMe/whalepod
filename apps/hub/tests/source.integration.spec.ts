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
import { runSourceReconcileTick } from '../src/modules/source/tick.js'
import { nodeSourceCollector } from '../src/modules/source/collector.js'
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
  let carol: Session
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
    carol = (
      await driveInviteAndAccept(
        ctx,
        alice,
        {
          username: 'carol',
          displayName: 'Carol',
          password: 'correct horse battery staple',
        },
        'admin',
      )
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

  async function waitForCapabilities(
    deviceId: string,
    capabilities: readonly string[],
    label: string,
  ): Promise<void> {
    await waitForValue(async () => {
      const row = await getDeviceById(database.db, deviceId)
      const raw = (row?.capabilities as { sourceCapabilities?: unknown } | undefined)
        ?.sourceCapabilities
      return Array.isArray(raw) && JSON.stringify(raw) === JSON.stringify(capabilities)
        ? true
        : undefined
    }, `${label} hello capability persisted`)
  }

  async function sendHello(
    node: FakeSourceNode,
    deviceId: string,
    capabilities: readonly string[],
    label: string,
  ): Promise<void> {
    node.hello(deviceId, capabilities)
    await waitForCapabilities(deviceId, capabilities, label)
  }

  async function connectNode(
    device: { deviceId: string; deviceToken: string },
    label: string,
    capabilities: readonly string[] = [FEISHU_GROUP],
  ): Promise<FakeSourceNode> {
    const socket = await connect(device.deviceToken)
    const node = new FakeSourceNode(socket, label)
    nodes.push(node)
    await sendHello(node, device.deviceId, capabilities, label)
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

  async function sourceRow(sourceId: string) {
    const [row] = await database.db
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.id, sourceId))
    return row
  }

  async function leaseRow(appKey: string) {
    const [row] = await database.db
      .select()
      .from(schema.sourceCollectionLeases)
      .where(eq(schema.sourceCollectionLeases.appKey, appKey))
    return row
  }

  function reconcile(now = new Date()) {
    // 与 server 10s tick 同一个入口；重新加整轮守卫会让慢重验用例变红。
    return runSourceReconcileTick({ database, collector: nodeSourceCollector, now })
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
    expect(audits.map((row) => row.action)).toEqual(['bound', 'lease_changed'])
    expect(JSON.stringify(audits)).not.toContain('oc_visible_group')
    expect(JSON.stringify(audits)).not.toContain('fixture-app-key')

    const events = (await listTeamEvents(database.db)).filter(
      (row) => row.type === 'source.changed',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      sourceId: view.id,
      projectId,
      status: 'active',
    })
    expect(typeof (events[0]?.payload as { changedAt?: unknown }).changedAt).toBe('string')
    expect(JSON.stringify(events)).not.toContain('oc_visible_group')
    expect(JSON.stringify(events)).not.toContain('fixture-app-key')
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
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(audits.map((row) => row.action)).toEqual([
      'bound',
      'lease_changed',
      'paused',
      'lease_changed',
      'resumed',
      'lease_changed',
      'revoked',
      'lease_changed',
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

    // 旧租约过期也不能静默换采集者：A 仍活跃，必须先撤销/暂停。
    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sourceCollectionLeases.appKey, 'shared-app-key'))
    const expired = await bind(alice, device2.deviceId, { resourceKey: 'oc_lease_c' })
    expect(expired.statusCode).toBe(409)
    expect(expired.json().error.code).toBe('SOURCE_LEASE_LOST')
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

  it('revalidates an online source and renews the collector lease', async () => {
    const device = await pair(alice, 'alice-node-9')
    const node = await connectNode(device, 'alice-node-9')
    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(201)
    const sourceId = created.json().data.id as string
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))

    const result = await reconcile(now)
    expect(result).toMatchObject({
      revalidated: 1,
      unknown: 0,
      unavailable: 0,
      leasesRenewed: 1,
      leasesExpired: 0,
    })
    const row = await sourceRow(sourceId)
    expect(row).toMatchObject({
      status: 'active',
      permissionState: 'verified',
      authorizationGeneration: 2,
    })
    expect(row?.permissionExpiresAt?.getTime()).toBeGreaterThan(now.getTime())
    const lease = await leaseRow(node.appKey)
    expect(lease?.expiresAt.getTime()).toBeGreaterThan(now.getTime())
    // bind 一次 + 重验一次；重验没有额外写绕过 Node 的捷径。
    expect(node.checks).toHaveLength(2)
  })

  it('revalidates a paused source without resuming it', async () => {
    const device = await pair(alice, 'alice-node-34')
    const node = await connectNode(device, 'alice-node-34')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    const checks = node.checks.length

    const result = await reconcile(now)
    expect(result).toMatchObject({ revalidated: 1, unknown: 0, unavailable: 0 })
    const row = await sourceRow(sourceId)
    expect(row).toMatchObject({
      status: 'paused',
      permissionState: 'verified',
      authorizationGeneration: 3,
    })
    expect(row?.pausedAt).not.toBeNull()
    expect(row?.permissionExpiresAt?.getTime()).toBeGreaterThan(now.getTime())
    expect(node.checks).toHaveLength(checks + 1)
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (audit) =>
          audit.action === 'permission_changed' &&
          (audit.payload as { reason?: string }).reason === 'revalidated',
      ),
    ).toBe(true)
    const events = (await listTeamEvents(database.db)).filter(
      (event) => event.type === 'source.changed',
    )
    expect(events.at(-1)?.payload).toMatchObject({
      sourceId,
      projectId,
      status: 'paused',
    })
  })

  it('marks a paused source unavailable when revalidation is denied', async () => {
    const device = await pair(alice, 'alice-node-35')
    const node = await connectNode(device, 'alice-node-35')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    node.mode = 'denied'

    const result = await reconcile(now)
    expect(result).toMatchObject({ revalidated: 0, unknown: 0, unavailable: 1 })
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'denied',
      authorizationGeneration: 3,
    })
  })

  it('turns an unverifiable source unknown and unavailable after 7 days', async () => {
    const device = await pair(alice, 'alice-node-10')
    const node = await connectNode(device, 'alice-node-10')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    // 同一连接重新 hello，但不再声明来源能力：在线但无法验证。
    await sendHello(node, device.deviceId, [], 'alice-node-10 downgraded')

    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    const first = await reconcile(now)
    expect(first.unknown).toBe(1)
    const unknown = await sourceRow(sourceId)
    expect(unknown).toMatchObject({
      status: 'active',
      permissionState: 'unknown',
      authorizationGeneration: 2,
    })
    expect(unknown?.permissionUnknownSince).not.toBeNull()

    await database.db
      .update(schema.projectSources)
      .set({ permissionUnknownSince: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.projectSources.id, sourceId))
    const second = await reconcile(now)
    expect(second.unavailable).toBe(1)
    const unavailable = await sourceRow(sourceId)
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      permissionState: 'unknown',
      authorizationGeneration: 3,
    })
    expect(unavailable?.unavailableAt).not.toBeNull()
  })

  it('marks the source unavailable when its collector device is revoked', async () => {
    const device = await pair(alice, 'alice-node-11')
    await connectNode(device, 'alice-node-11')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string

    const revoke = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/devices/${device.deviceId}`,
    })
    expect(revoke.statusCode).toBe(200)
    await waitForValue(
      async () => (nodeConnections.isOnline(device.deviceId) ? undefined : true),
      'collector disconnected after revoke',
    )

    const result = await reconcile()
    expect(result.unavailable).toBe(1)
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      authorizationGeneration: 2,
    })
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'unavailable' &&
          (row.payload as { reason?: string }).reason === 'collector_revoked',
      ),
    ).toBe(true)
  })

  it('marks the source unavailable when the collector stays offline past the lease', async () => {
    const device = await pair(alice, 'alice-node-12')
    const node = await connectNode(device, 'alice-node-12')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string

    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sourceCollectionLeases.appKey, node.appKey))
    node.socket.terminate()
    await waitForValue(
      async () => (nodeConnections.isOnline(device.deviceId) ? undefined : true),
      'collector disconnected',
    )

    const result = await reconcile()
    expect(result).toMatchObject({ unavailable: 1, leasesExpired: 1, leasesRenewed: 0 })
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      authorizationGeneration: 2,
    })
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'unavailable' &&
          (row.payload as { reason?: string }).reason === 'collector_offline',
      ),
    ).toBe(true)

    // 下一轮：没有活跃来源，过期租约释放并补审计。
    const second = await reconcile()
    expect(second.leasesReleased).toBe(1)
    expect(await leaseRow(node.appKey)).toBeUndefined()
    const released = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      released.some(
        (row) =>
          row.action === 'lease_changed' &&
          (row.payload as { event?: string; reason?: string }).event === 'released' &&
          (row.payload as { reason?: string }).reason === 'no_active_source',
      ),
    ).toBe(true)
  })

  it('resume denied marks unavailable; offline keeps paused; a changed appKey is rejected', async () => {
    const device = await pair(alice, 'alice-node-13')
    const node = await connectNode(device, 'alice-node-13')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string

    const pass = (path: string) =>
      apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/sources/${sourceId}/${path}`,
        payload: {},
      })

    expect((await pass('pause')).statusCode).toBe(200)
    node.mode = 'denied'
    const denied = await pass('resume')
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('SOURCE_NOT_READABLE')
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'denied',
      authorizationGeneration: 3,
    })

    // 新来源：offline 与 appKey 变化都不改变暂停态。
    node.mode = 'readable'
    const second = await bind(alice, device.deviceId)
    const secondId = second.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${secondId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)

    node.socket.terminate()
    await waitForValue(
      async () => (nodeConnections.isOnline(device.deviceId) ? undefined : true),
      'collector disconnected',
    )
    const offline = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${secondId}/resume`,
      payload: {},
    })
    expect(offline.statusCode).toBe(409)
    expect(offline.json().error.code).toBe('SOURCE_COLLECTOR_OFFLINE')
    expect(await sourceRow(secondId)).toMatchObject({ status: 'paused' })
  })

  it('lets an admin manage another member’s source; a member replay stays forbidden', async () => {
    const device = await pair(alice, 'alice-node-14')
    await connectNode(device, 'alice-node-14')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    const key = idemKey()

    const paused = await apiInject(ctx, carol, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/pause`,
      payload: {},
      idempotencyKey: key,
    })
    expect(paused.statusCode).toBe(200)

    // 同一 key 字符串由另一成员提交：命令 key 按 actor 收窄，仍走不了别人的回执。
    const replay = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/pause`,
      payload: {},
      idempotencyKey: key,
    })
    expect(replay.statusCode).toBe(403)
    expect(replay.json().error.code).toBe('FORBIDDEN')

    const resumed = await apiInject(ctx, carol, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
    })
    expect(resumed.statusCode).toBe(200)
  })

  it('replays a bind receipt after pause and collector offline without a second RPC', async () => {
    const device = await pair(alice, 'alice-node-15')
    const node = await connectNode(device, 'alice-node-15')
    const key = idemKey()
    const first = await bind(alice, device.deviceId, { resourceKey: 'oc_replay_bind' }, key)
    expect(first.statusCode).toBe(201)
    const sourceId = first.json().data.id as string

    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    node.socket.terminate()
    await waitForValue(
      async () => (nodeConnections.isOnline(device.deviceId) ? undefined : true),
      'collector disconnected',
    )

    const replay = await bind(alice, device.deviceId, { resourceKey: 'oc_replay_bind' }, key)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data.id).toBe(sourceId)
    // 回执先于 RPC：重放不会再要求 Node 做一次权限检查。
    expect(node.checks).toHaveLength(1)
  })

  it('rejects autoExtraction=true until ADR-0026 and malformed ids before PostgreSQL', async () => {
    const device = await pair(alice, 'alice-node-16')
    await connectNode(device, 'alice-node-16')

    const extraction = await bind(alice, device.deviceId, { autoExtraction: true })
    expect(extraction.statusCode).toBe(400)
    expect(extraction.json().error.code).toBe('SOURCE_UNSUPPORTED')
    expect(await sourceCount()).toBe(0)

    const badSource = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/sources/not-a-uuid',
    })
    expect(badSource.statusCode).toBe(400)
    expect(badSource.json().error.code).toBe('VALIDATION_FAILED')

    const badProject = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid/sources',
    })
    expect(badProject.statusCode).toBe(400)
  })

  it('refuses resume when the collector app identity changed', async () => {
    const device = await pair(alice, 'alice-node-17')
    const node = await connectNode(device, 'alice-node-17')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string

    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    node.appKey = 'rotated-app-key'
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
    })
    expect(resumed.statusCode).toBe(409)
    expect(resumed.json().error.code).toBe('SOURCE_LEASE_LOST')
    const row = await sourceRow(sourceId)
    expect(row).toMatchObject({ status: 'paused', appKey: 'fixture-app-key' })
  })

  it('does not fail a concurrent same-key bind with a 500', async () => {
    const device = await pair(alice, 'alice-node-18')
    await connectNode(device, 'alice-node-18')
    const key = idemKey()
    const [first, second] = await Promise.all([
      bind(alice, device.deviceId, { resourceKey: 'oc_concurrent' }, key),
      bind(alice, device.deviceId, { resourceKey: 'oc_concurrent' }, key),
    ])
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.json().data.id).toBe(first.json().data.id)
    expect(await sourceCount()).toBe(1)
  })

  it('marks a paused source unavailable when its collector device is revoked', async () => {
    const device = await pair(alice, 'alice-node-27')
    await connectNode(device, 'alice-node-27')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)

    const revoke = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/devices/${device.deviceId}`,
    })
    expect(revoke.statusCode).toBe(200)
    await waitForValue(
      async () => (nodeConnections.isOnline(device.deviceId) ? undefined : true),
      'collector disconnected after revoke',
    )

    const result = await reconcile()
    expect(result.unavailable).toBe(1)
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      authorizationGeneration: 3,
    })
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'unavailable' &&
          (row.payload as { reason?: string }).reason === 'collector_revoked',
      ),
    ).toBe(true)
  })

  it('does not renew an expired lease; an online collector’s sources become unavailable', async () => {
    const device = await pair(alice, 'alice-node-19')
    const node = await connectNode(device, 'alice-node-19')
    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(201)
    const sourceId = created.json().data.id as string

    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sourceCollectionLeases.appKey, node.appKey))

    const first = await reconcile()
    expect(first).toMatchObject({
      unavailable: 1,
      leasesExpired: 1,
      leasesRenewed: 0,
    })
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      authorizationGeneration: 2,
    })
    // 过期租约原样保留到下一轮，不静默续期、不换发代次。
    expect((await leaseRow(node.appKey))?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'unavailable' &&
          (row.payload as { reason?: string }).reason === 'collector_lease_expired',
      ),
    ).toBe(true)
  })

  it('marks a source unavailable when revalidation is explicitly denied', async () => {
    const device = await pair(alice, 'alice-node-20')
    const node = await connectNode(device, 'alice-node-20')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    node.mode = 'denied'

    const result = await reconcile(now)
    expect(result).toMatchObject({ unavailable: 1, unknown: 0, revalidated: 0 })
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'denied',
      authorizationGeneration: 2,
    })
    expect(node.checks).toHaveLength(2)
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'permission_changed' &&
          (row.payload as { reason?: string }).reason === 'revalidation_denied',
      ),
    ).toBe(true)
  })

  it('marks a source unavailable when the collector app identity changes during revalidation', async () => {
    const device = await pair(alice, 'alice-node-21')
    const node = await connectNode(device, 'alice-node-21')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    node.appKey = 'rotated-app-key'

    const result = await reconcile(now)
    expect(result).toMatchObject({ unavailable: 1, unknown: 0, revalidated: 0 })
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'unknown',
      authorizationGeneration: 2,
    })
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'permission_changed' &&
          (row.payload as { reason?: string }).reason === 'app_key_changed',
      ),
    ).toBe(true)
  })

  it('expires a paused unknown source after the grace period', async () => {
    const device = await pair(alice, 'alice-node-22')
    const node = await connectNode(device, 'alice-node-22')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    await sendHello(node, device.deviceId, [], 'alice-node-22 downgraded')

    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, sourceId))
    expect((await reconcile(now)).unknown).toBe(1)

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/pause`,
      payload: {},
    })
    expect(paused.statusCode).toBe(200)
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'paused',
      permissionState: 'unknown',
    })

    await database.db
      .update(schema.projectSources)
      .set({ permissionUnknownSince: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.projectSources.id, sourceId))
    const expired = await reconcile(now)
    expect(expired.unavailable).toBe(1)
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'unknown',
      authorizationGeneration: 4,
    })
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'permission_changed' &&
          (row.payload as { reason?: string }).reason === 'permission_unknown_too_long',
      ),
    ).toBe(true)
  })

  it('replays a successful resume as a view, not as a wrapper', async () => {
    const device = await pair(alice, 'alice-node-23')
    const node = await connectNode(device, 'alice-node-23')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)

    const key = idemKey()
    const checks = node.checks.length
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data).toMatchObject({ status: 'active', authorizationGeneration: 3 })
    expect(first.json().data.view).toBeUndefined()

    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
      idempotencyKey: key,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toEqual(first.json().data)
    expect(replay.json().data.view).toBeUndefined()
    // 回执先于 RPC：重放不再要求 Node 重验。
    expect(node.checks).toHaveLength(checks + 1)
  })

  it('replays a denied resume as 403, not as a 200 denied wrapper', async () => {
    const device = await pair(alice, 'alice-node-24')
    const node = await connectNode(device, 'alice-node-24')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    node.mode = 'denied'

    const key = idemKey()
    const checks = node.checks.length
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(403)
    expect(first.json().error.code).toBe('SOURCE_NOT_READABLE')
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'denied',
    })

    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
      idempotencyKey: key,
    })
    expect(replay.statusCode).toBe(403)
    expect(replay.json().error.code).toBe('SOURCE_NOT_READABLE')
    expect(replay.json().data).toBeUndefined()
    expect(node.checks).toHaveLength(checks + 1)
  })

  it('does not 500 when two devices race for a previously unleased app', async () => {
    const device1 = await pair(alice, 'alice-node-25')
    const node1 = await connectNode(device1, 'alice-node-25')
    node1.appKey = 'race-app-key'
    const device2 = await pair(alice, 'alice-node-26')
    const node2 = await connectNode(device2, 'alice-node-26')
    node2.appKey = 'race-app-key'

    const [first, second] = await Promise.all([
      bind(alice, device1.deviceId, { resourceKey: 'oc_race_a' }),
      bind(alice, device2.deviceId, { resourceKey: 'oc_race_b' }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b)
    expect(statuses).toEqual([201, 409])
    const loser = first.statusCode === 409 ? first : second
    expect(loser.json().error.code).toBe('SOURCE_LEASE_LOST')
    expect(await sourceCount()).toBe(1)
  })

  it('refuses bind and resume on an expired lease while another source is active', async () => {
    const device = await pair(alice, 'alice-node-28')
    const node = await connectNode(device, 'alice-node-28')
    const first = await bind(alice, device.deviceId, { resourceKey: 'oc_expired_a' })
    expect(first.statusCode).toBe(201)
    const firstId = first.json().data.id as string
    const second = await bind(alice, device.deviceId, { resourceKey: 'oc_expired_b' })
    expect(second.statusCode).toBe(201)
    const secondId = second.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${secondId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)

    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sourceCollectionLeases.appKey, node.appKey))

    // 旧租约过期 + 仍有活跃来源：同设备绑定/恢复都不能把中断续过去。
    const third = await bind(alice, device.deviceId, { resourceKey: 'oc_expired_c' })
    expect(third.statusCode).toBe(409)
    expect(third.json().error.code).toBe('SOURCE_LEASE_LOST')
    expect(await sourceCount()).toBe(2)

    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${secondId}/resume`,
      payload: {},
    })
    expect(resumed.statusCode).toBe(409)
    expect(resumed.json().error.code).toBe('SOURCE_LEASE_LOST')
    expect(await sourceRow(secondId)).toMatchObject({ status: 'paused' })
    expect(await sourceRow(firstId)).toMatchObject({ status: 'active', authorizationGeneration: 1 })

    const swept = await reconcile()
    expect(swept).toMatchObject({ unavailable: 1, leasesExpired: 1, leasesRenewed: 0 })
    expect(await sourceRow(firstId)).toMatchObject({
      status: 'unavailable',
      authorizationGeneration: 2,
    })
    expect(await sourceRow(secondId)).toMatchObject({ status: 'paused' })

    const released = await reconcile()
    expect(released.leasesReleased).toBe(1)
    expect(await leaseRow(node.appKey)).toBeUndefined()
  })

  it('refreshes device liveness when the collector answers a permission check', async () => {
    const device = await pair(alice, 'alice-node-36')
    const node = await connectNode(device, 'alice-node-36')
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.devices.id, device.deviceId))

    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(201)
    // 权限检查的应答刷新 lastSeenAt，随后续租仍应发生。
    const result = await reconcile()
    expect(result).toMatchObject({ leasesRenewed: 1, unavailable: 0 })
  })

  it('does not renew a lease when the collector heartbeat is stale', async () => {
    const device = await pair(alice, 'alice-node-29')
    const node = await connectNode(device, 'alice-node-29')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    const before = (await leaseRow(node.appKey))?.expiresAt.getTime() ?? 0

    // Open socket + 10 分钟无心跳：模拟挂起/睡死的 Node，不得靠 socket OPEN 续租。
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.devices.id, device.deviceId))

    const first = await reconcile()
    expect(first).toMatchObject({ leasesRenewed: 0, leasesExpired: 0, unavailable: 0 })
    expect((await leaseRow(node.appKey))?.expiresAt.getTime()).toBe(before)
    expect(await sourceRow(sourceId)).toMatchObject({ status: 'active' })

    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sourceCollectionLeases.appKey, node.appKey))
    const second = await reconcile()
    expect(second).toMatchObject({ unavailable: 1, leasesExpired: 1, leasesRenewed: 0 })
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      authorizationGeneration: 2,
    })
    const audits = await database.db
      .select()
      .from(schema.sourceAuditEvents)
      .where(eq(schema.sourceAuditEvents.sourceId, sourceId))
    expect(
      audits.some(
        (row) =>
          row.action === 'unavailable' &&
          (row.payload as { reason?: string }).reason === 'collector_offline',
      ),
    ).toBe(true)
  })

  it('does not shorten a live lease when binding another source on the same device', async () => {
    const device = await pair(alice, 'alice-node-37')
    const node = await connectNode(device, 'alice-node-37')
    expect((await bind(alice, device.deviceId, { resourceKey: 'oc_clamp_a' })).statusCode).toBe(201)
    const long = new Date(Date.now() + 120_000)
    const futureRenewal = new Date(Date.now() + 60_000)
    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: long, renewedAt: futureRenewal })
      .where(eq(schema.sourceCollectionLeases.appKey, node.appKey))

    const second = await bind(alice, device.deviceId, { resourceKey: 'oc_clamp_b' })
    expect(second.statusCode).toBe(201)
    const lease = await leaseRow(node.appKey)
    expect(lease?.expiresAt.getTime()).toBe(long.getTime())
    expect(lease?.renewedAt.getTime()).toBe(futureRenewal.getTime())
  })

  it('rotates an expired idle lease to a new collector', async () => {
    const firstDevice = await pair(alice, 'alice-node-38')
    const firstNode = await connectNode(firstDevice, 'alice-node-38')
    firstNode.appKey = 'idle-app-key'
    const first = await bind(alice, firstDevice.deviceId, { resourceKey: 'oc_idle_a' })
    expect(first.statusCode).toBe(201)
    const firstId = first.json().data.id as string
    const oldLease = await leaseRow('idle-app-key')
    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sourceCollectionLeases.appKey, 'idle-app-key'))

    const swept = await reconcile()
    expect(swept).toMatchObject({ unavailable: 1, leasesExpired: 1 })
    expect(await sourceRow(firstId)).toMatchObject({ status: 'unavailable' })
    expect(await leaseRow('idle-app-key')).toBeDefined()

    const secondDevice = await pair(alice, 'alice-node-39')
    const secondNode = await connectNode(secondDevice, 'alice-node-39')
    secondNode.appKey = 'idle-app-key'
    const second = await bind(alice, secondDevice.deviceId, { resourceKey: 'oc_idle_b' })
    expect(second.statusCode).toBe(201)
    const rotated = await leaseRow('idle-app-key')
    expect(rotated).toMatchObject({
      deviceId: secondDevice.deviceId,
      generation: (oldLease?.generation ?? 0) + 1,
    })
    expect(rotated?.leaseToken).not.toBe(oldLease?.leaseToken)
    expect(rotated?.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('never shortens an existing lease when renewing', async () => {
    const device = await pair(alice, 'alice-node-33')
    const node = await connectNode(device, 'alice-node-33')
    const created = await bind(alice, device.deviceId)
    expect(created.statusCode).toBe(201)
    const long = new Date(Date.now() + 120_000)
    await database.db
      .update(schema.sourceCollectionLeases)
      .set({ expiresAt: long })
      .where(eq(schema.sourceCollectionLeases.appKey, node.appKey))

    const result = await reconcile()
    expect(result.leasesRenewed).toBe(1)
    expect((await leaseRow(node.appKey))?.expiresAt.getTime()).toBe(long.getTime())
  })

  it('keeps renewing leases while a slow permission revalidation is running', async () => {
    const device = await pair(alice, 'alice-node-30')
    const node = await connectNode(device, 'alice-node-30')
    const due = await bind(alice, device.deviceId, { resourceKey: 'oc_slow_due' })
    const healthy = await bind(alice, device.deviceId, { resourceKey: 'oc_slow_healthy' })
    expect(due.statusCode).toBe(201)
    expect(healthy.statusCode).toBe(201)
    const dueId = due.json().data.id as string
    const healthyId = healthy.json().data.id as string
    const now = new Date()
    await database.db
      .update(schema.projectSources)
      .set({ permissionExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.projectSources.id, dueId))
    node.mode = 'silent'
    const checks = node.checks.length

    const slow = reconcile(now)
    await waitForValue(
      async () => (node.checks.length > checks ? true : undefined),
      'silent permission revalidation dispatched',
    )
    const leaseBefore = await leaseRow(node.appKey)
    const fast = await reconcile(new Date(now.getTime() + 5_000))
    expect(fast).toMatchObject({ leasesRenewed: 1, unknown: 0, unavailable: 0 })
    expect((await leaseRow(node.appKey))?.expiresAt.getTime()).toBeGreaterThan(
      leaseBefore?.expiresAt.getTime() ?? 0,
    )
    expect(await sourceRow(healthyId)).toMatchObject({
      status: 'active',
      permissionState: 'verified',
    })

    const slowResult = await slow
    expect(slowResult.unknown).toBe(1)
    expect(await sourceRow(dueId)).toMatchObject({
      status: 'active',
      permissionState: 'unknown',
    })
  }, 20_000)

  it('returns 403 to both concurrent denied resumes with the same key', async () => {
    const device = await pair(alice, 'alice-node-31')
    const node = await connectNode(device, 'alice-node-31')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    node.mode = 'denied'
    const key = idemKey()
    const [first, second] = await Promise.all([
      apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/sources/${sourceId}/resume`,
        payload: {},
        idempotencyKey: key,
      }),
      apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/sources/${sourceId}/resume`,
        payload: {},
        idempotencyKey: key,
      }),
    ])
    expect(first.statusCode).toBe(403)
    expect(second.statusCode).toBe(403)
    expect(first.json().error.code).toBe('SOURCE_NOT_READABLE')
    expect(second.json().error.code).toBe('SOURCE_NOT_READABLE')
    expect(await sourceRow(sourceId)).toMatchObject({
      status: 'unavailable',
      permissionState: 'denied',
      authorizationGeneration: 3,
    })
  })

  it('replays an already-active resume as the same view without another RPC', async () => {
    const device = await pair(alice, 'alice-node-32')
    const node = await connectNode(device, 'alice-node-32')
    const created = await bind(alice, device.deviceId)
    const sourceId = created.json().data.id as string
    const key = idemKey()
    const checks = node.checks.length
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data).toMatchObject({ status: 'active', authorizationGeneration: 1 })

    // 先暂停：如果 no-op 没写回执，同一 key 会重新走 RPC 把来源恢复。
    expect(
      (
        await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/sources/${sourceId}/pause`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200)

    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/resume`,
      payload: {},
      idempotencyKey: key,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toEqual(first.json().data)
    expect(await sourceRow(sourceId)).toMatchObject({ status: 'paused' })
    expect(node.checks).toHaveLength(checks)
  })

  it('requires a session for every source route', async () => {
    const sourceId = randomUUID()
    const routes: Array<{
      method: 'GET' | 'POST'
      url: string
      payload?: Record<string, unknown>
    }> = [
      { method: 'GET', url: `/api/v1/projects/${projectId}/sources` },
      { method: 'POST', url: `/api/v1/projects/${projectId}/sources`, payload: {} },
      { method: 'GET', url: `/api/v1/sources/${sourceId}` },
      { method: 'POST', url: `/api/v1/sources/${sourceId}/pause`, payload: {} },
      { method: 'POST', url: `/api/v1/sources/${sourceId}/resume`, payload: {} },
      { method: 'POST', url: `/api/v1/sources/${sourceId}/revoke`, payload: { reason: 'test' } },
    ]
    for (const route of routes) {
      const res = await ctx.app.inject({
        method: route.method,
        url: route.url,
        headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
        ...(route.payload !== undefined ? { payload: route.payload } : {}),
      })
      expect(res.statusCode, route.url).toBe(401)
      expect(res.json().error.code).toBe('AUTH_REQUIRED')
    }
  })
})
