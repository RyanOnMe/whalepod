/**
 * Hub integration spec 的统一入口与驱动助手。
 *
 * 与 packages/db/tests/helpers.ts 同源（迁移应用 + 复位 + DATABASE_URL 检查），
 * 但只依赖 @project311/db 的公开导出，不跨包引用测试内部文件。
 * 所有驱动走 Fastify inject（真人同一条 HTTP 路径）；DB 断言走 raw SQL。
 */
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { createDatabase } from '@project311/db'
import type { Database } from '@project311/db'
import { buildApp } from '../src/app.js'
import type { HubConfig } from '../src/config.js'

const MIGRATIONS_DIR = new URL('../../../packages/db/migrations/', import.meta.url).pathname
const MIGRATION_TABLE = '_schema_migrations'
const MIGRATION_LOCK_KEY = 20260825

export async function applyMigrations(database: Database): Promise<void> {
  await database.sql`
    create table if not exists ${database.sql(MIGRATION_TABLE)} (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    throw new Error('packages/db/migrations 缺少迁移文件（期望 0001_phase1.sql）')
  }
  for (const file of files) {
    const ddl = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    await database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
      const applied = await sql<{ name: string }[]>`
        select name from ${sql(MIGRATION_TABLE)} where name = ${file}
      `
      if (applied.length > 0) return
      await sql.unsafe(ddl)
      await sql`insert into ${sql(MIGRATION_TABLE)} ${sql({ name: file })}`
    })
  }
}

export async function resetDatabase(database: Database): Promise<void> {
  const rows = await database.sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> ${MIGRATION_TABLE}
  `
  if (rows.length === 0) return
  const list = rows.map(({ tablename }) => `"${tablename}"`).join(', ')
  await database.sql.unsafe(`truncate table ${list} restart identity cascade`)
}

export async function createTestDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL 未设置：integration 测试须经 scripts/with-test-postgres.mts 运行')
  }
  const database = createDatabase({ connectionString: url, max: 4 })
  await applyMigrations(database)
  return database
}

/** 捕获 hub 审计事件（component=hub.audit 的结构化日志行）。 */
export interface AuditEvent {
  component: string
  action: string
  actor: string
  outcome: string
  requestId: string
}

class AuditStream extends Writable {
  readonly events: AuditEvent[] = []

  _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const entry = JSON.parse(trimmed) as { component?: string } & AuditEvent
        if (entry.component === 'hub.audit') this.events.push(entry)
      } catch {
        // 非 JSON 行（启动横幅等）忽略
      }
    }
    callback()
  }
}

export interface TestApp {
  readonly app: FastifyInstance
  readonly database: Database
  readonly origin: string
  readonly setupToken: string
  readonly setupTokenPath: string
  readonly auditEvents: AuditEvent[]
  readonly config: HubConfig
  close(): Promise<void>
}

export interface TestAppOptions {
  /** 默认 http://localhost:4242（Secure=false 分支）；换 https origin 走 Secure=true 分支。 */
  readonly origin?: string
  readonly rateLimit?: HubConfig['rateLimit']
}

export async function createTestApp(
  database: Database,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const origin = options.origin ?? 'http://localhost:4242'
  const dir = await mkdtemp(join(tmpdir(), 'p311-hub-test-'))
  const setupTokenPath = join(dir, 'setup-token')
  const setupToken = randomBytes(32).toString('base64url')
  await writeFile(setupTokenPath, setupToken, { mode: 0o600 })
  const audit = new AuditStream()
  const config: HubConfig = {
    publicOrigin: origin,
    databaseUrl: '',
    setupTokenPath,
    host: '127.0.0.1',
    port: 0,
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
  }
  const app = await buildApp({
    config,
    database,
    logger: { level: 'info', stream: audit },
  })
  return {
    app,
    database,
    origin,
    setupToken,
    setupTokenPath,
    auditEvents: audit.events,
    config,
    close: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 驱动助手：全部走 HTTP inject，不抄近道。
// ---------------------------------------------------------------------------

export interface Session {
  readonly cookie: string
  readonly userId: string
}

export function idemKey(): string {
  return randomBytes(16).toString('hex')
}

/** 从 set-cookie 头提取 project311_session 的 Cookie 请求头值。 */
export function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (header === undefined) throw new Error('response 缺少 set-cookie')
  const pair = header.split(';')[0]
  if (pair === undefined || !pair.startsWith('project311_session=')) {
    throw new Error(`set-cookie 不含 project311_session：${header}`)
  }
  return pair
}

/** G1-01 驱动：完成首次 Setup，返回 Owner 会话。 */
export async function driveSetup(ctx: TestApp, username = 'alice'): Promise<Session> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      setupToken: ctx.setupToken,
      teamName: 'Acme',
      username,
      displayName: 'Alice',
      password: 'correct horse battery staple',
    },
  })
  if (response.statusCode !== 201) {
    throw new Error(`setup 失败：${response.statusCode} ${response.body}`)
  }
  const body = response.json() as { ok: true; data: { userId: string } }
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: body.data.userId }
}

/** 登录驱动。 */
export async function driveLogin(
  ctx: TestApp,
  username: string,
  password: string,
): Promise<Session> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: { username, password },
  })
  if (response.statusCode !== 200) {
    throw new Error(`login 失败：${response.statusCode} ${response.body}`)
  }
  const body = response.json() as { ok: true; data: { userId: string } }
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: body.data.userId }
}

/** G1-03 驱动：actor 创建邀请，新用户接受邀请，返回新会话与邀请 Token。 */
export async function driveInviteAndAccept(
  ctx: TestApp,
  actor: Session,
  invitee: { username: string; displayName: string; password: string },
  role: 'admin' | 'member' = 'member',
): Promise<{ session: Session; inviteToken: string; inviteId: string }> {
  const createResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/invites',
    headers: {
      origin: ctx.origin,
      'idempotency-key': idemKey(),
      cookie: actor.cookie,
    },
    payload: { role },
  })
  if (createResponse.statusCode !== 201) {
    throw new Error(`create invite 失败：${createResponse.statusCode} ${createResponse.body}`)
  }
  const created = createResponse.json() as {
    ok: true
    data: { inviteId: string; token: string }
  }
  const acceptResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/invites/accept',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      token: created.data.token,
      username: invitee.username,
      displayName: invitee.displayName,
      password: invitee.password,
    },
  })
  if (acceptResponse.statusCode !== 201) {
    throw new Error(`accept invite 失败：${acceptResponse.statusCode} ${acceptResponse.body}`)
  }
  const accepted = acceptResponse.json() as { ok: true; data: { userId: string } }
  return {
    session: {
      cookie: extractSessionCookie(acceptResponse.headers['set-cookie']),
      userId: accepted.data.userId,
    },
    inviteToken: created.data.token,
    inviteId: created.data.inviteId,
  }
}
