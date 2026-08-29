/**
 * P1-17 集成测试：POST /plugins/installations、POST /plugin-packs、
 * GET /node/plugin-packs/:packDigest（03 §4；02 Task 17 Step 5/7）。
 *
 * 覆盖：Admin 安装快照、幂等重装、G1-05（Member POST → 403 + audit denied）、
 * unreviewed/local-development 准入、不可变 Pack（digest 确定性、name 冲突 409）、
 * 同名包多版本早拒绝（M9，专用 fixture plugin-catalog-multi）、
 * Device Token descriptor（pack/lock/config 三处 digest 一致）、catalog 篡改
 * fail-closed。fixture catalog 自含于 tests/fixtures/plugin-catalog/（不依赖仓库根
 * plugins/）；lock digest 在测试内按 digestLockfile 同算法现算自证。
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { schema } from '@project311/db'
import type { Database } from '@project311/db'
import { pluginCordisEntry } from '@project311/protocol'
import type {
  PluginInstallationView,
  PluginPackDescriptor,
  PluginPackView,
} from '@project311/protocol'
import { digestPluginCordisEntry } from '@project311/protocol/plugin-pack-digest'
import { canonicalJson, digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import { buildApp } from '../src/app.js'
import type { HubConfig } from '../src/config.js'
import { hashToken } from '../src/modules/auth/token.js'
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
// 同名多版本专用 fixture（p311-echo@0.2.0 与 @0.2.1 并存；M9）。不放主 fixture：
// plugin-catalog.integration.spec.ts 锚定了主 catalog 的全量条目清单，加第二版本
// 会打破该断言——多版本 fixture 自含一个目录，互不影响。
const DUAL_VERSION_CATALOG_DIR = fileURLToPath(
  new URL('./fixtures/plugin-catalog-multi', import.meta.url),
)

// fixture 自证：lock 文件为空闭包，dependencyLockDigest 必须等于同算法现算值
// （digestLockfile = 排序依赖闭包 canonical JSON 的 SHA-256，见 apps/node lockfile.ts）。
// 与 plugin-catalog.integration.spec.ts 各持同一份本地实现（不改共享 helpers.ts）。
function lockDigest(name: string, version: string): string {
  return createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, package: { name, version }, dependencies: [] }))
    .digest('hex')
}

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

describe('plugin pack API (P1-17)', () => {
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

  async function installPackage(
    session: Session,
    name: string,
    version: string,
  ): Promise<PluginInstallationView> {
    const res = await apiInject(ctx, session, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name, version },
    })
    if (res.statusCode !== 201) {
      throw new Error(`install ${name}@${version} 失败：${res.statusCode} ${res.body}`)
    }
    return res.json().data as PluginInstallationView
  }

  async function createPackAs(
    session: Session,
    name: string,
    installationIds: string[],
  ): Promise<PluginPackView> {
    const res = await apiInject(ctx, session, {
      method: 'POST',
      url: '/api/v1/plugin-packs',
      payload: { name, installationIds },
    })
    if (res.statusCode !== 201) {
      throw new Error(`create pack ${name} 失败：${res.statusCode} ${res.body}`)
    }
    return res.json().data as PluginPackView
  }

  /** 直插一台已知 Token 的设备（真实配对流程属 P1-09 的测试域，此处只补 descriptor 鉴权前提）。 */
  async function seedDeviceToken(
    ownerUserId: string,
    options: { revoked?: boolean } = {},
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    await database.db.insert(schema.devices).values({
      id: randomUUID(),
      ownerUserId,
      name: `dev-${randomUUID().slice(0, 8)}`,
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: hashToken(token),
      capabilities: {},
      ...(options.revoked ? { revokedAt: new Date() } : {}),
    })
    return token
  }

  /** 两个 reviewed 安装 + 一个不可变 Pack（descriptor 用例的公共前提）。 */
  async function buildDescriptorPack(): Promise<{
    packDigest: string
    installations: PluginInstallationView[]
  }> {
    const echo = await installPackage(owner, 'p311-echo', '0.2.1')
    const fixed = await installPackage(owner, 'p311-fixed-time', '0.1.0')
    const pack = await createPackAs(owner, 'descriptor-pack', [fixed.id, echo.id])
    return { packDigest: pack.packDigest, installations: [echo, fixed] }
  }

  function descriptorInject(
    app: FastifyInstance,
    token: string,
    packDigest: string,
  ): ReturnType<FastifyInstance['inject']> {
    // 不带 Origin、不带 Cookie：/node/** 只认 Device Token（03 §4 末段）。
    return app.inject({
      method: 'GET',
      url: `/api/v1/node/plugin-packs/${packDigest}`,
      headers: { authorization: `Device ${token}` },
    })
  }

  it('Admin 安装 curated 包：201，manifest 字段快照入行', async () => {
    const res = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name: 'p311-fixed-time', version: '0.1.0' },
    })
    expect(res.statusCode).toBe(201)
    const installation = res.json().data as PluginInstallationView
    expect(installation.packageName).toBe('p311-fixed-time')
    expect(installation.packageVersion).toBe('0.1.0')
    expect(installation.trust).toBe('curated')
    expect(installation.capabilityClass).toBe('declared')
    expect(installation.capabilities).toEqual(['workspace.read'])
    expect(installation.status).toBe('installed')
    expect(installation.installedBy).toBe(owner.userId)

    const [row] = await database.db.select().from(schema.pluginInstallations)
    expect(row?.packageName).toBe('p311-fixed-time')
    expect(row?.dependencyLockDigest).toBe(lockDigest('p311-fixed-time', '0.1.0'))
    expect(row?.installedBy).toBe(owner.userId)
  })

  it('同 name+version 重复安装返回已有行（200 + 同 id，不产生第二行）', async () => {
    const first = await installPackage(owner, 'p311-echo', '0.2.1')
    const res = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name: 'p311-echo', version: '0.2.1' },
    })
    expect(res.statusCode).toBe(200)
    const second = res.json().data as PluginInstallationView
    expect(second.id).toBe(first.id)
    const rows = await database.db.select().from(schema.pluginInstallations)
    expect(rows).toHaveLength(1)
  })

  it('Member POST installation → 403 FORBIDDEN + audit denied（G1-05），不落行', async () => {
    const res = await apiInject(ctx, member, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name: 'p311-fixed-time', version: '0.1.0' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    const denied = ctx.auditEvents.find(
      (e) => e.action === 'plugin.install' && e.outcome === 'denied' && e.actor === member.userId,
    )
    expect(denied).toBeDefined()
    const rows = await database.db.select().from(schema.pluginInstallations)
    expect(rows).toHaveLength(0)
  })

  it('unreviewed 清单不可安装（403 PLUGIN_UNREVIEWED）', async () => {
    const res = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name: 'p311-unreviewed', version: '0.0.3' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('PLUGIN_UNREVIEWED')
  })

  it('catalog 外的包不可安装（404）', async () => {
    const res = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name: 'p311-ghost', version: '1.0.0' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  it('local-development 清单：dev mode 关闭拒绝，显式开启后可装且 trust=unreviewed', async () => {
    const off = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugins/installations',
      payload: { name: 'p311-dev-sandbox', version: '0.0.1' },
    })
    expect(off.statusCode).toBe(403)
    expect(off.json().error.code).toBe('PLUGIN_UNREVIEWED')

    const devCtx = await createPluginTestApp(database, {
      catalogDir: FIXTURE_CATALOG_DIR,
      pluginDevMode: true,
    })
    try {
      // owner 会话在同一数据库（ctx 签发的 cookie 对 devCtx 同样有效）。
      const on = await apiInject(devCtx, owner, {
        method: 'POST',
        url: '/api/v1/plugins/installations',
        payload: { name: 'p311-dev-sandbox', version: '0.0.1' },
      })
      expect(on.statusCode).toBe(201)
      expect(on.json().data.trust).toBe('unreviewed')
    } finally {
      await devCtx.close()
    }
  })

  it('创建不可变 Pack：entries 按 name 排序展开，digest 可复算，configDigest 正确', async () => {
    const echo = await installPackage(owner, 'p311-echo', '0.2.1')
    const fixed = await installPackage(owner, 'p311-fixed-time', '0.1.0')
    // 反序输入：组装必须按 package name 重排（03 §2.5）。
    const res = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugin-packs',
      payload: { name: 'curated-base', installationIds: [fixed.id, echo.id] },
    })
    expect(res.statusCode).toBe(201)
    const pack = res.json().data as PluginPackView
    expect(pack.name).toBe('curated-base')
    expect(pack.createdBy).toBe(owner.userId)
    expect(pack.entries.map((e) => e.entry.name)).toEqual(['p311-echo', 'p311-fixed-time'])
    expect(pack.installations).toEqual([echo.id, fixed.id])
    expect(pack.entries[0]?.installation.id).toBe(echo.id)

    const recomputed = digestPluginPack({
      schemaVersion: 1,
      packages: pack.entries.map(({ entry }) => entry),
    })
    expect(pack.packDigest).toBe(recomputed)
    for (const { entry } of pack.entries) {
      expect(entry.configDigest).toBe(
        digestPluginCordisEntry(
          pluginCordisEntry({
            name: entry.name,
            version: entry.version,
            entrypoint: entry.entrypoint,
          }),
        ),
      )
    }
  })

  it('digest 确定性：同输入、不同 name 的 Pack 得同一 pack_digest', async () => {
    const echo = await installPackage(owner, 'p311-echo', '0.2.1')
    const fixed = await installPackage(owner, 'p311-fixed-time', '0.1.0')
    const packA = await createPackAs(owner, 'pack-alpha', [echo.id, fixed.id])
    const packB = await createPackAs(owner, 'pack-beta', [fixed.id, echo.id])
    expect(packA.name).toBe('pack-alpha')
    expect(packB.name).toBe('pack-beta')
    expect(packB.packDigest).toBe(packA.packDigest)
  })

  it('Pack name 冲突 → 409 CONFLICT（不可变，不提供更新）', async () => {
    const fixed = await installPackage(owner, 'p311-fixed-time', '0.1.0')
    await createPackAs(owner, 'solo-pack', [fixed.id])
    const res = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugin-packs',
      payload: { name: 'solo-pack', installationIds: [fixed.id] },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('CONFLICT')
  })

  it('unreviewed installation 不能进普通 Pack（03 §2.5；409 PLUGIN_UNREVIEWED）', async () => {
    const devCtx = await createPluginTestApp(database, {
      catalogDir: FIXTURE_CATALOG_DIR,
      pluginDevMode: true,
    })
    try {
      const installOn = async (name: string, version: string) => {
        const res = await apiInject(devCtx, owner, {
          method: 'POST',
          url: '/api/v1/plugins/installations',
          payload: { name, version },
        })
        if (res.statusCode !== 201) {
          throw new Error(`install ${name} 失败：${res.statusCode} ${res.body}`)
        }
        return res.json().data as PluginInstallationView
      }
      const fixed = await installOn('p311-fixed-time', '0.1.0')
      const dev = await installOn('p311-dev-sandbox', '0.0.1')
      expect(dev.trust).toBe('unreviewed')
      const res = await apiInject(devCtx, owner, {
        method: 'POST',
        url: '/api/v1/plugin-packs',
        payload: { name: 'mixed-pack', installationIds: [fixed.id, dev.id] },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('PLUGIN_UNREVIEWED')
    } finally {
      await devCtx.close()
    }
  })

  it('同名包两个版本各自可安装，但不能进同一 Pack（M9：400 VALIDATION_FAILED）', async () => {
    // 同一 packageName 的两个版本（不同 installation）会让 digest 输入依赖排序
    // 稳定性、Node preflight 也无条件拒重名 descriptor → Hub 侧必须早拒绝。
    const dualCtx = await createPluginTestApp(database, { catalogDir: DUAL_VERSION_CATALOG_DIR })
    try {
      const install = async (version: string): Promise<PluginInstallationView> => {
        const res = await apiInject(dualCtx, owner, {
          method: 'POST',
          url: '/api/v1/plugins/installations',
          payload: { name: 'p311-echo', version },
        })
        if (res.statusCode !== 201) {
          throw new Error(`install p311-echo@${version} 失败：${res.statusCode} ${res.body}`)
        }
        return res.json().data as PluginInstallationView
      }
      // 前提自证：两个版本各自安装成功，是两个独立 installation 行。
      const older = await install('0.2.0')
      const newer = await install('0.2.1')
      expect(older.id).not.toBe(newer.id)
      expect(older.packageVersion).toBe('0.2.0')
      expect(newer.packageVersion).toBe('0.2.1')

      const res = await apiInject(dualCtx, owner, {
        method: 'POST',
        url: '/api/v1/plugin-packs',
        payload: { name: 'same-name-pack', installationIds: [older.id, newer.id] },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_FAILED')
      expect(res.json().error.message).toBe(
        'pack cannot include two installations of the same package',
      )
      // 拒绝即无半成品：库中只剩 setup 创建的 core-empty 一个 Pack。
      const packs = await database.db.select().from(schema.pluginPacks)
      expect(packs).toHaveLength(1)
      expect(packs[0]?.name).toBe('core-empty')
    } finally {
      await dualCtx.close()
    }
  })

  it('不存在的 installation id → 404；重复 id → 400', async () => {
    const missing = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugin-packs',
      payload: { name: 'ghost-pack', installationIds: [randomUUID()] },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('NOT_FOUND')

    const fixed = await installPackage(owner, 'p311-fixed-time', '0.1.0')
    const duplicate = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/plugin-packs',
      payload: { name: 'dupe-pack', installationIds: [fixed.id, fixed.id] },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('Member POST pack → 403 FORBIDDEN + audit denied（G1-05）', async () => {
    const res = await apiInject(ctx, member, {
      method: 'POST',
      url: '/api/v1/plugin-packs',
      payload: { name: 'member-pack', installationIds: [randomUUID()] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    const denied = ctx.auditEvents.find(
      (e) => e.action === 'plugin.pack' && e.outcome === 'denied' && e.actor === member.userId,
    )
    expect(denied).toBeDefined()
  })

  it('Member 可读 Pack 列表（entries 展开安装详情）', async () => {
    const echo = await installPackage(owner, 'p311-echo', '0.2.1')
    const fixed = await installPackage(owner, 'p311-fixed-time', '0.1.0')
    const created = await createPackAs(owner, 'curated-base', [echo.id, fixed.id])
    const res = await apiInject(ctx, member, { method: 'GET', url: '/api/v1/plugin-packs' })
    expect(res.statusCode).toBe(200)
    const packs = res.json().data as PluginPackView[]
    const pack = packs.find((p) => p.id === created.id)
    expect(pack).toBeDefined()
    expect(pack?.entries.map((e) => e.entry.name)).toEqual(['p311-echo', 'p311-fixed-time'])
    expect(pack?.entries[0]?.installation.installedBy).toBe(owner.userId)
    // core-empty（Setup 创建，空闭包）同列表可见且 digest 与新算法一致。
    const coreEmpty = packs.find((p) => p.name === 'core-empty')
    expect(coreEmpty?.packDigest).toBe(digestPluginPack({ schemaVersion: 1, packages: [] }))
  })

  describe('GET /node/plugin-packs/:packDigest（Device Token）', () => {
    it('取 descriptor：pack/lock/config 三处 digest 一致，lockfile 原文下发', async () => {
      const token = await seedDeviceToken(owner.userId)
      const { packDigest, installations } = await buildDescriptorPack()
      const res = await descriptorInject(ctx.app, token, packDigest)
      expect(res.statusCode).toBe(200)
      const descriptor = res.json().data as PluginPackDescriptor
      expect(descriptor.schemaVersion).toBe(1)
      expect(descriptor.packDigest).toBe(packDigest)
      expect(descriptor.name).toBe('descriptor-pack')
      expect(descriptor.packages).toHaveLength(2)

      // pack digest：从 descriptor 的 manifest 独立重建 entry 并复算。
      const entries = descriptor.packages.map(({ manifest }) => ({
        name: manifest.name,
        version: manifest.version,
        integrity: manifest.integrity,
        dependencyLockDigest: manifest.dependencyLockDigest,
        entrypoint: manifest.entrypoint,
        configDigest: digestPluginCordisEntry(pluginCordisEntry(manifest)),
      }))
      expect(digestPluginPack({ schemaVersion: 1, packages: entries })).toBe(packDigest)

      // lock digest：manifest 登记 === 安装行 === fixture 算法现算；lockfile 是 fixture 原文。
      for (const pkg of descriptor.packages) {
        const installation = installations.find((i) => i.packageName === pkg.manifest.name)
        expect(installation).toBeDefined()
        expect(pkg.manifest.dependencyLockDigest).toBe(installation?.dependencyLockDigest)
        expect(pkg.manifest.dependencyLockDigest).toBe(
          lockDigest(pkg.manifest.name, pkg.manifest.version),
        )
        const fixtureLock = await readFile(
          join(
            FIXTURE_CATALOG_DIR,
            'locks',
            `${pkg.manifest.name}@${pkg.manifest.version}.lock.yaml`,
          ),
          'utf8',
        )
        expect(pkg.lockfile).toBe(fixtureLock)
      }

      // config digest：descriptor 的 manifest 与 GET /plugin-packs 视图的 entry 一致。
      const viewRes = await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/plugin-packs' })
      const viewPack = (viewRes.json().data as PluginPackView[]).find(
        (p) => p.packDigest === packDigest,
      )
      expect(viewPack).toBeDefined()
      for (const pkg of descriptor.packages) {
        const viewEntry = viewPack?.entries.find((e) => e.entry.name === pkg.manifest.name)
        expect(viewEntry?.entry.configDigest).toBe(
          digestPluginCordisEntry(pluginCordisEntry(pkg.manifest)),
        )
      }

      // descriptor 不含 secret、不含本机绝对路径（catalog 相对内容之外无任何主机信息）。
      const text = JSON.stringify(descriptor)
      expect(text).not.toContain('/Users/')
      expect(text).not.toContain(tmpdir())
    })

    it('缺失/伪造 Token → 401，已撤销设备 → 401', async () => {
      const noToken = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/node/plugin-packs/${'a'.repeat(64)}`,
      })
      expect(noToken.statusCode).toBe(401)
      expect(noToken.json().error.code).toBe('INVALID_CREDENTIALS')

      const forged = await descriptorInject(
        ctx.app,
        randomBytes(32).toString('base64url'),
        'a'.repeat(64),
      )
      expect(forged.statusCode).toBe(401)

      const revokedToken = await seedDeviceToken(owner.userId, { revoked: true })
      const revoked = await descriptorInject(ctx.app, revokedToken, 'a'.repeat(64))
      expect(revoked.statusCode).toBe(401)
      expect(revoked.json().error.code).toBe('INVALID_CREDENTIALS')
    })

    it('未知 digest 与非法 digest 同作 404（不泄露存在性）', async () => {
      const token = await seedDeviceToken(owner.userId)
      const unknown = await descriptorInject(ctx.app, token, 'f'.repeat(64))
      expect(unknown.statusCode).toBe(404)
      expect(unknown.json().error.code).toBe('NOT_FOUND')
      const malformed = await descriptorInject(ctx.app, token, 'zz-not-a-digest')
      expect(malformed.statusCode).toBe(404)
      expect(malformed.json().error.code).toBe('NOT_FOUND')
    })

    it('catalog entrypoint 被篡改后 descriptor 拒发（重启加载漂移 catalog = digest 漂移 → 404）', async () => {
      const token = await seedDeviceToken(owner.userId)
      const { packDigest } = await buildDescriptorPack()
      const manifestPath = join(FIXTURE_CATALOG_DIR, 'catalog', 'p311-fixed-time.json')
      const original = await readFile(manifestPath, 'utf8')
      try {
        const tampered = {
          ...(JSON.parse(original) as Record<string, unknown>),
          entrypoint: 'dist/tampered.js',
        }
        await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`)
        // 重启语义：Hub 重新加载 catalog 后，pack digest 复算不一致即拒发。
        const driftedCtx = await createPluginTestApp(database, { catalogDir: FIXTURE_CATALOG_DIR })
        try {
          const res = await descriptorInject(driftedCtx.app, token, packDigest)
          expect(res.statusCode).toBe(404)
          expect(res.json().error.code).toBe('NOT_FOUND')
        } finally {
          await driftedCtx.close()
        }
      } finally {
        await writeFile(manifestPath, original)
      }
      // fixture 还原自证：同一 digest 重新可解析（拒发源于 catalog 漂移，而非 Pack 本身）。
      const restoredCtx = await createPluginTestApp(database, { catalogDir: FIXTURE_CATALOG_DIR })
      try {
        const res = await descriptorInject(restoredCtx.app, token, packDigest)
        expect(res.statusCode).toBe(200)
      } finally {
        await restoredCtx.close()
      }
    })

    it('catalog integrity 被篡改后拒发：快照失配 409，GET /plugin-packs 同拒', async () => {
      const token = await seedDeviceToken(owner.userId)
      const { packDigest } = await buildDescriptorPack()
      const manifestPath = join(FIXTURE_CATALOG_DIR, 'catalog', 'p311-echo.json')
      const original = await readFile(manifestPath, 'utf8')
      try {
        const tampered = {
          ...(JSON.parse(original) as Record<string, unknown>),
          integrity: 'sha256-' + 'B'.repeat(43) + '=',
        }
        await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`)
        const driftedCtx = await createPluginTestApp(database, { catalogDir: FIXTURE_CATALOG_DIR })
        try {
          const res = await descriptorInject(driftedCtx.app, token, packDigest)
          expect(res.statusCode).toBe(409)
          expect(res.json().error.code).toBe('PLUGIN_PACK_MISMATCH')

          const viewRes = await apiInject(driftedCtx, owner, {
            method: 'GET',
            url: '/api/v1/plugin-packs',
          })
          expect(viewRes.statusCode).toBe(409)
          expect(viewRes.json().error.code).toBe('PLUGIN_PACK_MISMATCH')
        } finally {
          await driftedCtx.close()
        }
      } finally {
        await writeFile(manifestPath, original)
      }
    })
  })
})
