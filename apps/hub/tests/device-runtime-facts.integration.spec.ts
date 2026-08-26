import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { insertMember, insertTeam, insertUser, schema } from '@project311/db'
import { getDeviceDshDistributionVersion } from '../src/modules/run/index.js'
import { createTestDatabase, resetDatabase, seedRunChainForUser } from './helpers.js'

// #37：dshDistributionVersionFor 的真实实现——读 device.dsh_distribution_version。
// 缺行或尚未 hello（null）→ undefined，routes 据此映射 DEVICE_OFFLINE（语义不变）。
describe('deviceDshDistributionVersion (#37)', () => {
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

  it('returns undefined before hello reports, then the reported version', async () => {
    // seedRunChainForUser 的 pack/agent/device 全部外键到 user，先建真实用户。
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

    const { deviceId } = await seedRunChainForUser(database.db, userId)
    // 配对态（未 hello）：可空列 → undefined。
    expect(await getDeviceDshDistributionVersion(database.db, deviceId)).toBeUndefined()
    // hello 回填后读到真实发行版版本。
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: '0.1.0-rc.8' })
      .where(eq(schema.devices.id, deviceId))
    expect(await getDeviceDshDistributionVersion(database.db, deviceId)).toBe('0.1.0-rc.8')
    // 未知设备 → undefined（不可枚举）。
    expect(
      await getDeviceDshDistributionVersion(database.db, '00000000-0000-4000-8000-000000000000'),
    ).toBeUndefined()
  })
})
