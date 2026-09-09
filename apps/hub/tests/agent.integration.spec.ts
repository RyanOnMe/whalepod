import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { schema } from '@project311/db'
import { computeProfileDigest } from '../src/modules/agent/index.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  type TestApp,
} from './helpers.js'

async function coreEmptyPackId(database: Database): Promise<string> {
  const [pack] = await database.db
    .select({ id: schema.pluginPacks.id })
    .from(schema.pluginPacks)
    .where(eq(schema.pluginPacks.name, 'core-empty'))
  if (pack === undefined) throw new Error('core-empty pack not seeded')
  return pack.id
}

const profile = {
  persona: 'You are a careful builder.',
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  credentialSlot: 'default',
  pluginPackId: 'PLACEHOLDER',
} as const

// Agent 与不可变 Profile Revision（02 Task 6 Step 4/7）。
describe('agent API', () => {
  let database: Database
  let ctx: TestApp
  let packId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function freshPackId(): Promise<string> {
    return coreEmptyPackId(database)
  }

  it('creates an Agent with revision 1 and a recomputable digest', async () => {
    const alice = await driveSetup(ctx)
    packId = await freshPackId()
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Builder', description: 'builds things', ...profile, pluginPackId: packId },
    })
    expect(res.statusCode).toBe(201)
    const agent = res.json().data
    expect(agent.currentRevisionId).not.toBeNull()
    expect(agent.currentRevision.revision).toBe(1)
    expect(agent.revisions).toHaveLength(1)
    const expected = computeProfileDigest({ ...profile, pluginPackId: packId })
    expect(agent.currentRevision.profileDigest).toBe(expected)
  })

  it('forbids a member from creating an agent', async () => {
    const alice = await driveSetup(ctx)
    packId = await freshPackId()
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const res = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Nope', ...profile, pluginPackId: packId },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  it('appends revisions with monotonic numbers and recomputable digests (no gap)', async () => {
    const alice = await driveSetup(ctx)
    packId = await freshPackId()
    const created = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Rev', ...profile, pluginPackId: packId },
    })
    const agentId = created.json().data.id
    const digest1 = created.json().data.currentRevision.profileDigest

    // 同字段新 Revision：revision 2，digest 不变（同语义输入 → 同 digest）。
    const same = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/agents/${agentId}/revisions`,
      payload: { ...profile, pluginPackId: packId },
    })
    expect(same.statusCode).toBe(201)
    expect(same.json().data.revision).toBe(2)
    expect(same.json().data.profileDigest).toBe(digest1)

    // 改 model：revision 3，digest 变。
    const changed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/agents/${agentId}/revisions`,
      payload: { ...profile, pluginPackId: packId, model: 'deepseek-reasoner' },
    })
    expect(changed.json().data.revision).toBe(3)
    expect(changed.json().data.profileDigest).not.toBe(digest1)

    // 连续性：revision 号 1/2/3 无间隔；digest 可由公开函数重算。
    const detail = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/agents/${agentId}` })
    const revisions = detail.json().data.revisions
    expect(revisions.map((r: { revision: number }) => r.revision)).toEqual([1, 2, 3])
    expect(detail.json().data.currentRevisionId).toBe(changed.json().data.id)
    expect(computeProfileDigest({ ...profile, pluginPackId: packId })).toBe(digest1)
    expect(
      computeProfileDigest({ ...profile, pluginPackId: packId, model: 'deepseek-reasoner' }),
    ).toBe(changed.json().data.profileDigest)
  })

  it('rejects an unknown plugin pack and a duplicate name', async () => {
    const alice = await driveSetup(ctx)
    packId = await freshPackId()
    const unknownPack = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'A', ...profile, pluginPackId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(unknownPack.statusCode).toBe(404)

    await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Dup', ...profile, pluginPackId: packId },
    })
    const dup = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Dup', ...profile, pluginPackId: packId },
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('CONFLICT')
  })

  it('does not create a second agent on idempotency replay', async () => {
    const alice = await driveSetup(ctx)
    packId = await freshPackId()
    const key = idemKey()
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Idem', ...profile, pluginPackId: packId },
      idempotencyKey: key,
    })
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Idem', ...profile, pluginPackId: packId },
      idempotencyKey: key,
    })
    expect(replay.json().data.id).toBe(first.json().data.id)
    const list = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/agents' })
    expect(list.json().data).toHaveLength(1)
  })
})
