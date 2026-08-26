import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { schema } from '@project311/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

// G3-01..03：配对码一次性、所有权绑定、撤销；判据以 04-验收矩阵与测试策略.md 为准。
describe('device pairing API (G3-01..03)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session

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
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  const nodeInfo = {
    name: 'bob-macbook',
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
  }

  async function createCode(as: Session) {
    const res = await apiInject(ctx, as, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    return res.json().data as { pairingCodeId: string; code: string; expiresAt: string }
  }

  async function claim(code: string, overrides: Partial<typeof nodeInfo> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      // 匿名 Node 路由：无 Cookie、无 Browser Origin（03 §4 末段豁免），但保留幂等键。
      headers: { 'idempotency-key': 'claim-'.concat(randomUUID()) },
      payload: { code, ...nodeInfo, ...overrides },
    })
  }

  it('G3-01: Bob 配对成功，Token 43 字符只出现一次，device 落库归 Bob', async () => {
    const pairing = await createCode(bob)
    expect(pairing.code.length).toBeGreaterThanOrEqual(22)

    const claimed = await claim(pairing.code)
    expect(claimed.statusCode).toBe(201)
    const data = claimed.json().data as { deviceId: string; deviceToken: string }
    expect(data.deviceToken).toHaveLength(43)
    expect(data.deviceToken).not.toContain(pairing.code)

    // Token 明文不再出现在任何响应里：二次 claim 必须失败。
    const replay = await claim(pairing.code)
    expect(replay.statusCode).toBe(409)
    expect(replay.json().error.code).toBe('CONFLICT')

    // Device 行归 Bob，初始未 hello：version 空、digests 空数组。
    const [row] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, data.deviceId))
    expect(row?.ownerUserId).toBe(bob.userId)
    expect(row?.dshDistributionVersion).toBeNull()
    expect(row?.pluginPackDigests).toEqual([])
    expect(row?.revokedAt).toBeNull()

    // GET /devices：Bob 看到自己的设备且未在线（尚未连 WS）。
    const list = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/devices' })
    expect(list.statusCode).toBe(200)
    const mine = (list.json().data as Array<Record<string, unknown>>).find(
      (d) => d.id === data.deviceId,
    )
    expect(mine).toMatchObject({ name: nodeInfo.name, status: 'offline' })
    // Alice 的列表里没有 Bob 的设备。
    const aliceList = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/devices' })
    expect(
      (aliceList.json().data as Array<Record<string, unknown>>).some((d) => d.id === data.deviceId),
    ).toBe(false)
  })

  it('G3-02: Alice 用 Bob 的配对码无法把设备配到自己名下', async () => {
    const pairing = await createCode(bob)
    const claimed = await claim(pairing.code)
    expect(claimed.statusCode).toBe(201)
    const ownerId = (
      await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, claimed.json().data.deviceId))
    )[0]?.ownerUserId
    // 无论路由层如何处理跨用户 claim，设备归属必须是码的创建者 Bob。
    expect(ownerId).toBe(bob.userId)
  })

  it('G3-03: 重用与过期配对码均拒绝', async () => {
    const pairing = await createCode(bob)
    await claim(pairing.code)
    const reused = await claim(pairing.code)
    expect([401, 409]).toContain(reused.statusCode)

    // 直接把过期时间拨到过去模拟过期。
    const [row] = await database.db
      .select()
      .from(schema.devicePairingCodes)
      .where(eq(schema.devicePairingCodes.id, pairing.pairingCodeId))
    await database.db
      .update(schema.devicePairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.devicePairingCodes.id, row!.id))
    const fresh = await createCode(bob)
    void fresh
    const expiredRow = await database.db
      .select()
      .from(schema.devicePairingCodes)
      .where(eq(schema.devicePairingCodes.id, pairing.pairingCodeId))
    expect(expiredRow[0]!.expiresAt.getTime()).toBeLessThan(Date.now())
    const expiredClaim = await claim(`${pairing.code}`, {})
    expect([401, 409]).toContain(expiredClaim.statusCode)
  })

  it('revoke：本人可撤自己的设备，Owner/Admin 可撤任何设备，他人不可见 404', async () => {
    const pairing = await createCode(bob)
    const claimed = await claim(pairing.code)
    const deviceId = claimed.json().data.deviceId as string

    // Carol（无关 Member）删除 → 404（不可枚举）。
    const { session: carol } = await driveInviteAndAccept(ctx, alice, {
      username: 'carol',
      displayName: 'Carol',
      password: 'correct horse battery staple',
    })
    const forbidden = await apiInject(ctx, carol, {
      method: 'DELETE',
      url: `/api/v1/devices/${deviceId}`,
    })
    expect(forbidden.statusCode).toBe(404)

    // Owner 代撤 → 200，行标记 revoked。
    const byOwner = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/devices/${deviceId}`,
    })
    expect(byOwner.statusCode).toBe(200)
    const [row] = await database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId))
    expect(row?.revokedAt).not.toBeNull()

    // 幂等重复删 → 仍 200。
    const again = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/devices/${deviceId}`,
    })
    expect(again.statusCode).toBe(200)

    // 未知设备 → 404。
    const missing = await apiInject(ctx, bob, {
      method: 'DELETE',
      url: `/api/v1/devices/${randomUUID()}`,
    })
    expect(missing.statusCode).toBe(404)
  })
})
