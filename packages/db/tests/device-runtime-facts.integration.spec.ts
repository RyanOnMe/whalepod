import { eq } from 'drizzle-orm'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/index.js'
import { insertMember, insertTeam, insertUser } from '../src/index.js'
import { devices } from '../src/schema/index.js'
import { catchPgError, createTestDatabase, resetDatabase } from './helpers.js'

// #37（03 §6.2 node.hello）：device 表的运行时事实列。
// 配对建行时两者未知：version 可空、digests 空数组；hello 之后回填并可重读，
// digests 必须是 JSON 数组（CHECK 兜底）。
describe('device runtime facts columns (#37)', () => {
  let database: Database
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  async function seedPairedDevice(): Promise<string> {
    const teamId = randomUUID()
    const userId = randomUUID()
    await insertTeam(database.db, { id: teamId, name: `team-${randomUUID().slice(0, 8)}` })
    await insertUser(database.db, {
      id: userId,
      username: `user-${randomUUID().slice(0, 8)}`,
      displayName: 'Seed',
      passwordHash: '$argon2id$placeholder$placeholder',
    })
    await insertMember(database.db, { teamId, userId, role: 'owner' })
    const deviceId = randomUUID()
    await database.db.insert(devices).values({
      id: deviceId,
      ownerUserId: userId,
      name: `dev-${randomUUID().slice(0, 8)}`,
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: randomBytes(32),
      capabilities: {},
    })
    return deviceId
  }

  it('pairing-time row starts with null version and empty digests', async () => {
    const deviceId = await seedPairedDevice()
    const [row] = await database.db.select().from(devices).where(eq(devices.id, deviceId))
    expect(row?.dshDistributionVersion).toBeNull()
    expect(row?.pluginPackDigests).toEqual([])
  })

  it('hello-shaped facts persist and round-trip', async () => {
    const deviceId = await seedPairedDevice()
    await database.db
      .update(devices)
      .set({
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: ['a'.repeat(64), 'b'.repeat(64)],
        lastSeenAt: new Date(),
      })
      .where(eq(devices.id, deviceId))
    const [row] = await database.db.select().from(devices).where(eq(devices.id, deviceId))
    expect(row?.dshDistributionVersion).toBe('0.1.0-rc.8')
    expect(row?.pluginPackDigests).toEqual(['a'.repeat(64), 'b'.repeat(64)])
  })

  it('rejects non-array digests with CHECK violation 23514', async () => {
    const deviceId = await seedPairedDevice()
    const pg = await catchPgError(
      database.db
        .update(devices)
        // jsonb 对象：合法 JSON 但不是数组，应被 device_plugin_pack_digests_array 拒绝。
        .set({ pluginPackDigests: {} as unknown as string[] })
        .where(eq(devices.id, deviceId)),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('device_plugin_pack_digests_array')
  })
})
