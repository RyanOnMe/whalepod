/**
 * G1-01 / G1-02：首次 Setup 与重复 Setup。
 * 安全用例：错误 Setup Token、速率限制、Cookie 属性、明文不落库。
 * P1-17 M10：core-empty pack digest 断代幂等迁移（旧算法 sha256('[]') 行在
 * POST /setup 入口被原地修复为现算值；已迁移时 no-op）。
 */
import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import {
  CORE_EMPTY_MIGRATION_LOCK_KEY,
  CORE_EMPTY_PACK_DIGEST,
  migrateCoreEmptyPackDigest,
  MigrationLockTimeoutError,
} from '../src/modules/team/commands.js'
import {
  createTestApp,
  createTestDatabase,
  driveSetup,
  extractSessionCookie,
  idemKey,
  resetDatabase,
} from './helpers.js'
import type { TestApp } from './helpers.js'

let database: Database
let ctx: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  ctx = await createTestApp(database)
})

beforeEach(async () => {
  await resetDatabase(database)
  // Setup Token 是一次性文件：成功 setup 会消费掉，每个用例重建。
  const { writeFile } = await import('node:fs/promises')
  await writeFile(ctx.setupTokenPath, ctx.setupToken, { mode: 0o600 })
})

afterAll(async () => {
  await ctx.close()
  await database.close()
})

describe('GET /api/v1/setup/status', () => {
  it('匿名返回 initialized=false，setup 后变为 true', async () => {
    const before = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    expect(before.statusCode).toBe(200)
    expect(before.json()).toEqual({ ok: true, data: { initialized: false } })

    await driveSetup(ctx)

    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    expect(after.json()).toEqual({ ok: true, data: { initialized: true } })
  })
})

describe('POST /api/v1/setup（G1-01）', () => {
  it('创建唯一 Team、Owner 与 Session，Cookie 带安全属性', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(201)
    const envelope = response.json()
    expect(envelope.ok).toBe(true)
    expect(envelope.data.teamId).toMatch(/^[0-9a-f-]{36}$/)
    expect(envelope.data.userId).toMatch(/^[0-9a-f-]{36}$/)

    const setCookie = response.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')
    expect(cookieHeader).toContain('project311_session=')
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Lax')
    expect(cookieHeader).toContain('Path=/')

    // 三张表记录（G1-01）：team / user_account / team_member
    const teams = await database.sql`select * from team`
    const users = await database.sql`select * from user_account`
    const members = await database.sql`select * from team_member`
    expect(teams).toHaveLength(1)
    expect(users).toHaveLength(1)
    expect(members).toHaveLength(1)
    expect(teams[0]?.name).toBe('Acme')
    expect(members[0]?.role).toBe('owner')

    // Setup 事务同时创建不可变 core-empty Plugin Pack（02 Task 5 Step 3）
    const packs = await database.sql`select * from plugin_pack`
    expect(packs).toHaveLength(1)
    expect(packs[0]?.name).toBe('core-empty')
    expect(packs[0]?.installations).toEqual([])
    expect(packs[0]?.pack_digest).toMatch(/^[0-9a-f]{64}$/)

    // 密码存 Argon2id PHC；Session 只存 token hash（32 字节 SHA-256），明文不分库
    const passwordHash = users[0]?.password_hash as string
    expect(passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(passwordHash).not.toContain('correct horse battery staple')
    const sessions = await database.sql`select * from auth_session`
    expect(sessions).toHaveLength(1)
    const tokenHash = sessions[0]?.token_hash as Buffer
    expect(tokenHash.byteLength).toBe(32)
    const plainToken = extractSessionCookie(setCookie).split('=')[1]
    expect(tokenHash.toString('utf8')).not.toBe(plainToken)
    expect(tokenHash.toString('base64url')).not.toBe(plainToken)
  })

  it('setup 成功后一次性 Setup Token 文件被消费', async () => {
    await driveSetup(ctx)
    await expect(access(ctx.setupTokenPath)).rejects.toThrow()
  })

  it('并发两个 setup：恰一个 201 一个 409，只有一条 team 记录', async () => {
    const make = (username: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
        payload: {
          setupToken: ctx.setupToken,
          teamName: 'Acme',
          username,
          displayName: username,
          password: 'correct horse battery staple',
        },
      })
    const [a, b] = await Promise.all([make('alice'), make('alicia')])
    const statuses = [a.statusCode, b.statusCode].sort()
    expect(statuses).toEqual([201, 409])
    const loser = a.statusCode === 409 ? a : b
    expect(loser.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from team`).toHaveLength(1)
    expect(await database.sql`select * from user_account`).toHaveLength(1)
  })

  it('审计：setup 成功记录 actor/action/outcome/requestId', async () => {
    await driveSetup(ctx)
    const entry = ctx.auditEvents.find(
      (event) => event.action === 'setup' && event.outcome === 'success',
    )
    expect(entry).toBeDefined()
    expect(entry?.actor).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry?.requestId).toBeDefined()
  })
})

describe('POST /api/v1/setup（G1-02 与拒绝路径）', () => {
  it('再次调用 /setup 返回 409 CONFLICT，不新增记录', async () => {
    await driveSetup(ctx)
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Evil',
        username: 'mallory',
        displayName: 'Mallory',
        password: 'whatever password',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from team`).toHaveLength(1)
    expect(await database.sql`select * from user_account`).toHaveLength(1)
  })

  it('错误 Setup Token 返回 401 INVALID_CREDENTIALS，不创建任何记录', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: 'wrong-token',
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS')
    expect(await database.sql`select * from team`).toHaveLength(0)
  })

  it('多余 body 字段被严格模式拒绝（400 VALIDATION_FAILED）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
        isAdmin: true,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('非法 username 被拒绝（400）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'Alice Upper',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('错误响应不泄露 SQL/路径，形态为统一 envelope', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { setupToken: 'x' },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(typeof body.error.requestId).toBe('string')
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/|select |insert /i)
  })
})

describe('core-empty pack digest 断代迁移（P1-17 M10）', () => {
  /** 重试 setup 的完整 body：已初始化实例在 token 校验前就 409，token 值无关紧要。 */
  function retrySetup() {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
  }

  async function coreEmptyRow(): Promise<{ id: string; pack_digest: string } | undefined> {
    const rows = await database.sql<{ id: string; pack_digest: string }[]>`
      select id, pack_digest from plugin_pack where name = 'core-empty'`
    return rows[0]
  }

  it('旧算法 digest（sha256("[]")）在重试 /setup 时被原地迁移为现算值', async () => {
    await driveSetup(ctx)
    const legacy = createHash('sha256').update('[]').digest('hex')
    // 旧算法值自证（review 记载的断代锚点）：installation id 数组 digest 的定值。
    expect(legacy).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
    const before = await coreEmptyRow()
    expect(before?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST) // 初始落库即新算法

    // 模拟旧 dev 库：把行打回旧算法值，再触发升级期最自然的入口——重试 setup。
    await database.sql`update plugin_pack set pack_digest = ${legacy} where name = 'core-empty'`
    const retry = await retrySetup()
    // 常规 409 照旧（实例已初始化）；但 M10 迁移在初始化检查之前已发生（routes 顺序）。
    expect(retry.statusCode).toBe(409)
    expect(retry.json().error.code).toBe('CONFLICT')

    const after = await coreEmptyRow()
    expect(after?.id).toBe(before?.id) // 原地 UPDATE，非删除重建
    expect(after?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST)
    expect(after?.pack_digest).not.toBe(legacy)
    // 常量与协议现算一致（防常量漂移）：core-empty 空闭包的 digestPluginPack 定值。
    expect(CORE_EMPTY_PACK_DIGEST).toBe(digestPluginPack({ schemaVersion: 1, packages: [] }))
  })

  it('已是现算值时迁移为 no-op：返回 false，行不变', async () => {
    await driveSetup(ctx)
    const before = await coreEmptyRow()
    expect(before?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST)
    const migrated = await migrateCoreEmptyPackDigest(database)
    expect(migrated).toBe(false)
    const after = await coreEmptyRow()
    expect(after?.id).toBe(before?.id)
    expect(after?.pack_digest).toBe(before?.pack_digest)
  })

  it('未知 digest 值同样被迁移（直调返回 true），重复触发安全', async () => {
    await driveSetup(ctx)
    await database.sql`update plugin_pack set pack_digest = ${'e'.repeat(64)} where name = 'core-empty'`
    expect(await migrateCoreEmptyPackDigest(database)).toBe(true)
    expect((await coreEmptyRow())?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST)
    // 幂等：第二遍是 no-op。
    expect(await migrateCoreEmptyPackDigest(database)).toBe(false)
  })

  it('并发双跑迁移：两调用都成功，迁移恰好执行一次（#55）', async () => {
    // 独立 TestApp：driveSetup 的每 IP 限流预算与日志捕获不占共享 ctx 账本。
    const local = await createTestApp(database)
    try {
      await driveSetup(local)
      const legacy = createHash('sha256').update('[]').digest('hex')
      // 多轮放大交错窗口：每轮把行打回旧算法值后同时发射两个迁移调用。
      for (let round = 0; round < 5; round++) {
        await database.sql`update plugin_pack set pack_digest = ${legacy} where name = 'core-empty'`
        const [a, b] = await Promise.allSettled([
          migrateCoreEmptyPackDigest(database),
          migrateCoreEmptyPackDigest(database),
        ])
        // 都成功：并发不得以 dup key / 序列化失败等形式冒出来。
        if (a.status === 'rejected' || b.status === 'rejected') {
          throw new Error(`并发迁移调用失败（round ${round}）：${String(a.reason ?? b.reason)}`)
        }
        // 恰好一次：只有一个调用观察到旧值并完成迁移，另一个等锁后见现算值返回 false。
        expect([a.value, b.value].filter(Boolean)).toHaveLength(1)
        const after = await coreEmptyRow()
        expect(after?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST)
      }
    } finally {
      await local.close()
    }
  })

  it('并发两个 /setup 重试（遗留旧 digest 行）：都 409，恰好一条迁移告警（#55）', async () => {
    const local = await createTestApp(database)
    try {
      await driveSetup(local)
      const legacy = createHash('sha256').update('[]').digest('hex')
      await database.sql`update plugin_pack set pack_digest = ${legacy} where name = 'core-empty'`
      // 已初始化实例重试 setup 在 token 校验前就 409，token 值无关紧要。
      const retry = () =>
        local.app.inject({
          method: 'POST',
          url: '/api/v1/setup',
          headers: { origin: local.origin, 'idempotency-key': idemKey() },
          payload: {
            setupToken: local.setupToken,
            teamName: 'Acme',
            username: 'alice',
            displayName: 'Alice',
            password: 'correct horse battery staple',
          },
        })
      const warnsBefore = local.warnEvents.filter((e) => e.component === 'hub.setup').length
      const [ra, rb] = await Promise.all([retry(), retry()])
      expect(ra.statusCode).toBe(409)
      expect(rb.statusCode).toBe(409)
      const after = await coreEmptyRow()
      expect(after?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST)
      // 告警计数确定：并发场景下迁移告警恰好一条（无锁时两条 SELECT 都读到旧值 → 双告警）。
      const warnsAfter = local.warnEvents.filter((e) => e.component === 'hub.setup').length
      expect(warnsAfter - warnsBefore).toBe(1)
    } finally {
      await local.close()
    }
  })

  it('advisory lock 等锁超时：fail-fast 且报错可归因，释放后照常迁移恰好一次（#55 N2）', async () => {
    const local = await createTestApp(database)
    try {
      await driveSetup(local)
      const legacy = createHash('sha256').update('[]').digest('hex')
      await database.sql`update plugin_pack set pack_digest = ${legacy} where name = 'core-empty'`
      // 病态持锁者：独占连接持同一 key 的会话级锁，直到本用例结束才放。
      const holder = await database.sql.reserve()
      try {
        await holder`select pg_advisory_lock(${CORE_EMPTY_MIGRATION_LOCK_KEY})`
        await expect(
          migrateCoreEmptyPackDigest(database, { lockTimeoutMs: 150 }),
        ).rejects.toBeInstanceOf(MigrationLockTimeoutError)
        // 超时事务整体回滚、无副作用：行仍是旧值。
        expect((await coreEmptyRow())?.pack_digest).toBe(legacy)
      } finally {
        await holder`select pg_advisory_unlock(${CORE_EMPTY_MIGRATION_LOCK_KEY})`
        holder.release()
      }
      // 锁释放后迁移照常完成恰好一次（超时的败者无需补偿）。
      expect(await migrateCoreEmptyPackDigest(database)).toBe(true)
      expect((await coreEmptyRow())?.pack_digest).toBe(CORE_EMPTY_PACK_DIGEST)
    } finally {
      await local.close()
    }
  })
})

describe('Setup 速率限制', () => {
  it('每 IP 超过窗口配额后返回 429', async () => {
    const limited = await createTestApp(database, { rateLimit: { anonymousMax: 2 } })
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/setup',
          headers: { origin: limited.origin, 'idempotency-key': idemKey() },
          payload: {
            setupToken: 'wrong-token',
            teamName: 'Acme',
            username: 'alice',
            displayName: 'Alice',
            password: 'correct horse battery staple',
          },
        })
      expect((await attempt()).statusCode).toBe(401)
      expect((await attempt()).statusCode).toBe(401)
      const blocked = await attempt()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().error.code).toBe('FORBIDDEN')
      const audit = limited.auditEvents.find(
        (event) => event.action === 'setup' && event.outcome === 'rate_limited',
      )
      expect(audit).toBeDefined()
    } finally {
      await limited.close()
    }
  })
})

describe('Cookie Secure 属性', () => {
  it('public origin 为 https 时 Cookie 带 Secure', async () => {
    const secure = await createTestApp(database, { origin: 'https://hub.example.com' })
    try {
      const response = await secure.app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        headers: { origin: secure.origin, 'idempotency-key': idemKey() },
        payload: {
          setupToken: secure.setupToken,
          teamName: 'Acme',
          username: 'alice',
          displayName: 'Alice',
          password: 'correct horse battery staple',
        },
      })
      expect(response.statusCode).toBe(201)
      expect(response.headers['set-cookie']).toContain('Secure')
    } finally {
      await secure.close()
    }
  })

  it('localhost origin 允许无 Secure（开发分支）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(response.headers['set-cookie']).not.toContain('Secure')
  })
})
