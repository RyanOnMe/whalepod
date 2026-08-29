/**
 * P1-17 集成测试：GET /plugins/catalog（03 §4；02 Task 17 Step 7）。
 *
 * fixture catalog 在 tests/fixtures/plugin-catalog/（自含两份 reviewed + 一份
 * local-development + 一份 unreviewed 的小 manifest 与空闭包 lock），不依赖仓库根
 * plugins/（另一代理并行写入中）。驱动走真人同一条 HTTP 路径（Fastify inject）。
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import type { Database } from '@project311/db'
import { canonicalJson } from '@project311/protocol/plugin-pack-digest'
import type { PluginCatalogEntryView } from '@project311/protocol'
import { buildApp } from '../src/app.js'
import type { HubConfig } from '../src/config.js'
import {
  apiInject,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  type AuditEvent,
  type Session,
  type TestApp,
} from './helpers.js'

const FIXTURE_CATALOG_DIR = fileURLToPath(new URL('./fixtures/plugin-catalog', import.meta.url))

// fixture 自证：lock 文件为空闭包，dependencyLockDigest 必须等于同算法现算值
// （digestLockfile = 排序依赖闭包 canonical JSON 的 SHA-256，见 apps/node lockfile.ts）。
function lockDigest(name: string, version: string): string {
  return createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, package: { name, version }, dependencies: [] }))
    .digest('hex')
}

/** 捕获 hub 审计事件（component=hub.audit 的结构化日志行），与 helpers 同源约定。 */
class AuditCollector extends Writable {
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

/**
 * 与 helpers.createTestApp 同构，但注入 fixture catalog 目录——不改共享 helpers.ts
 * （并行代理也在动它）；本目录的两个 spec 各持同一份本地构造器。
 */
async function createPluginTestApp(
  database: Database,
  options: { readonly catalogDir: string; readonly pluginDevMode?: boolean },
): Promise<TestApp> {
  const origin = 'http://localhost:4242'
  const dir = await mkdtemp(join(tmpdir(), 'p311-hub-plugin-test-'))
  const setupTokenPath = join(dir, 'setup-token')
  const setupToken = randomBytes(32).toString('base64url')
  await writeFile(setupTokenPath, setupToken, { mode: 0o600 })
  const auditStream = new AuditCollector()
  const config: HubConfig = {
    publicOrigin: origin,
    databaseUrl: '',
    setupTokenPath,
    host: '127.0.0.1',
    port: 0,
    pluginCatalogDir: options.catalogDir,
    ...(options.pluginDevMode ? { pluginDevMode: true } : {}),
  }
  const app: FastifyInstance = await buildApp({
    config,
    database,
    logger: { level: 'info', stream: auditStream },
  })
  return {
    app,
    database,
    origin,
    setupToken,
    setupTokenPath,
    auditEvents: auditStream.events,
    config,
    close: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('plugin catalog API (P1-17)', () => {
  let database: Database
  let ctx: TestApp
  let owner: Session
  let member: Session

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createPluginTestApp(database, { catalogDir: FIXTURE_CATALOG_DIR })
    owner = await driveSetup(ctx)
    const invited = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    member = invited.session
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('Member 可读 catalog，条目含 exact version/integrity/license/review commit/capabilities', async () => {
    const res = await apiInject(ctx, member, { method: 'GET', url: '/api/v1/plugins/catalog' })
    expect(res.statusCode).toBe(200)
    const entries = res.json().data as PluginCatalogEntryView[]
    // 稳定排序（name 字典序）：dev-sandbox / echo / fixed-time / unreviewed。
    expect(entries.map((e) => e.name)).toEqual([
      'p311-dev-sandbox',
      'p311-echo',
      'p311-fixed-time',
      'p311-unreviewed',
    ])

    const fixedTime = entries.find((e) => e.name === 'p311-fixed-time')
    expect(fixedTime).toBeDefined()
    expect(fixedTime?.version).toBe('0.1.0') // 精确版本
    expect(fixedTime?.integrity).toMatch(/^sha256-[A-Za-z0-9+/]+={0,2}$/) // SRI 全文下发（短摘要 Web 自截）
    expect(fixedTime?.license).toBe('MIT')
    expect(fixedTime?.review.status).toBe('reviewed')
    expect(fixedTime?.review.commit).toMatch(/^[a-f0-9]{40}$/) // review commit
    expect(fixedTime?.capabilities).toEqual(['workspace.read']) // 声明能力
    expect(fixedTime?.dshCompatibility).toBe('0.1.0-rc.8')
    expect(fixedTime?.tarballUrl).toMatch(/^https:/)

    // fixture 自证：manifest 登记的闭包 digest 与 lock 原文同算法现算一致。
    expect(fixedTime?.dependencyLockDigest).toBe(lockDigest('p311-fixed-time', '0.1.0'))

    const echo = entries.find((e) => e.name === 'p311-echo')
    expect(echo?.capabilities).toEqual(['workspace.read', 'workspace.write', 'network.egress'])
    expect(echo?.license).toBe('Apache-2.0')
  })

  it('Owner 与 Member 读到同一份 catalog（GET 无特权差异）', async () => {
    const ownerRes = await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/plugins/catalog' })
    const memberRes = await apiInject(ctx, member, {
      method: 'GET',
      url: '/api/v1/plugins/catalog',
    })
    expect(ownerRes.statusCode).toBe(200)
    expect(memberRes.statusCode).toBe(200)
    expect(memberRes.json().data).toEqual(ownerRes.json().data)
  })

  it('未认证请求被拒（401）', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/catalog',
      headers: { origin: ctx.origin, 'idempotency-key': 'a'.repeat(16) },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('AUTH_REQUIRED')
  })
})
