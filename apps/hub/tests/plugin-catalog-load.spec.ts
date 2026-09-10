/**
 * P1-17 loadPluginCatalog fail-closed 直接测试（M7；02 Task 17 Step 3）。
 *
 * loadPluginCatalog 是 exported 纯 fs 函数（无 DB 依赖）：用 node:fs mkdtemp 造
 * 临时 catalog 目录，逐分支锚定错误形态——非法 JSON、schema 拒绝（version 用
 * range）、name@version 重复、lock 缺失、lock 为空必须 rejects；catalog 目录整体
 * 缺失 = 空 catalog（安装面关闭）。每个拒绝用例同时锚「绝对路径不进错误信息」
 * 红线（错误只含 catalog 相对名）。
 *
 * 文件名不带 .integration：本 spec 归 unit 项目（根 vitest.config.ts 的 projects
 * 划分按 .integration 后缀分流）；happy path 的 HTTP/DB 语义由
 * plugin-catalog.integration.spec.ts 覆盖，这里只做 loader 级自证。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPluginCatalog } from '../src/modules/plugin/catalog.js'

const FIXTURE_CATALOG_DIR = fileURLToPath(new URL('./fixtures/plugin-catalog', import.meta.url))

interface ManifestOverrides {
  readonly name?: string
  readonly version?: string
}

/** 合法 manifest 基线（与 tests/fixtures/plugin-catalog 同构），按用例覆写 name/version。 */
function makeManifest(overrides: ManifestOverrides = {}): Record<string, unknown> {
  const name = overrides.name ?? 'wp-load'
  return {
    schemaVersion: 1,
    name,
    version: overrides.version ?? '1.0.0',
    tarballUrl: `https://catalog.fixtures.whalepod.test/tarballs/${name}.tgz`,
    integrity: 'sha256-4IvnqPfKwrbojO+9mMW4g9ZCNSTU7wMCTDkLbI+5BU0=',
    dependencyLockDigest: 'a'.repeat(64),
    dshCompatibility: '0.1.0',
    entrypoint: 'dist/index.js',
    capabilities: ['workspace.read'],
    capabilityClass: 'declared',
    license: 'MIT',
    review: {
      status: 'reviewed',
      commit: 'a'.repeat(40),
      at: '2026-08-01T00:00:00.000Z',
    },
  }
}

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wp-catalog-load-'))
  tempDirs.push(dir)
  return dir
}

/** 造一个 catalog 根目录：key 形如 'catalog/x.json' 或 'locks/x@1.0.0.lock.yaml'。 */
async function seedCatalog(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir()
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return dir
}

/** 断言 loader rejects、错误形态匹配正则，且 message 不含本机绝对路径（红线）。 */
async function expectCatalogReject(dir: string, messagePattern: RegExp): Promise<void> {
  let caught: unknown
  try {
    await loadPluginCatalog(dir)
  } catch (error) {
    caught = error
  }
  expect(caught, 'loadPluginCatalog 应当 rejects，但 resolved 了').toBeInstanceOf(Error)
  const error = caught as Error
  expect(error.message).toMatch(messagePattern)
  expect(error.message).not.toContain(tmpdir())
}

describe('loadPluginCatalog fail-closed（P1-17 M7）', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  it('非法 JSON manifest → rejects，错误点名 catalog 相对文件名', async () => {
    const dir = await seedCatalog({
      'catalog/wp-broken.json': '{ "schemaVersion": 1, ',
      'locks/wp-broken@1.0.0.lock.yaml': 'schemaVersion: 1\n',
    })
    await expectCatalogReject(dir, /^plugin catalog 文件不是合法 JSON：catalog\/wp-broken\.json$/)
  })

  it('schema 非法（version 用 range ^1.0.0）→ rejects，点名字段与原因', async () => {
    const dir = await seedCatalog({
      'catalog/wp-range.json': JSON.stringify(
        makeManifest({ name: 'wp-range', version: '^1.0.0' }),
        null,
        2,
      ),
      'locks/wp-range@1.0.0.lock.yaml': 'schemaVersion: 1\n',
    })
    await expectCatalogReject(
      dir,
      /^plugin catalog 清单校验失败：catalog\/wp-range\.json —— version version must be exact semver/,
    )
  })

  it('两个文件重复登记同 name@version → rejects（按文件序点名后者）', async () => {
    const dir = await seedCatalog({
      'catalog/wp-dup-a.json': JSON.stringify(makeManifest({ name: 'wp-dup' }), null, 2),
      'catalog/wp-dup-b.json': JSON.stringify(makeManifest({ name: 'wp-dup' }), null, 2),
      'locks/wp-dup@1.0.0.lock.yaml': 'schemaVersion: 1\n',
    })
    await expectCatalogReject(
      dir,
      /^plugin catalog 重复登记：wp-dup@1\.0\.0（catalog\/wp-dup-b\.json）$/,
    )
  })

  it('manifest 存在但对应 lock 缺失 → rejects，点名缺失的 lock 相对路径', async () => {
    const dir = await seedCatalog({
      'catalog/wp-nolock.json': JSON.stringify(makeManifest({ name: 'wp-nolock' }), null, 2),
      // 故意只放别的包的 lock：wp-nolock@1.0.0.lock.yaml 缺失。
      'locks/wp-other@1.0.0.lock.yaml': 'schemaVersion: 1\n',
    })
    await expectCatalogReject(
      dir,
      /^plugin catalog 不完整：locks\/wp-nolock@1\.0\.0\.lock\.yaml 缺失（catalog\/wp-nolock\.json 声明了该包）$/,
    )
  })

  it('lock 文件为空（纯空白）→ rejects', async () => {
    const dir = await seedCatalog({
      'catalog/wp-emptylock.json': JSON.stringify(makeManifest({ name: 'wp-emptylock' }), null, 2),
      'locks/wp-emptylock@1.0.0.lock.yaml': '   \n\t\n',
    })
    await expectCatalogReject(
      dir,
      /^plugin catalog lock 文件为空：locks\/wp-emptylock@1\.0\.0\.lock\.yaml$/,
    )
  })

  it('catalog 目录整体缺失 → resolves 为空 catalog（dirMissing=true，安装面关闭）', async () => {
    const dir = await makeTempDir() // 不创建 catalog/ 子目录
    const catalog = await loadPluginCatalog(dir)
    expect(catalog.manifests).toEqual([])
    expect(catalog.dirMissing).toBe(true)
    expect(catalog.get('wp-load', '1.0.0')).toBeUndefined()
    expect(catalog.lockfile('wp-load', '1.0.0')).toBeUndefined()
  })

  it('catalog 目录存在但无 manifest → 空 manifests 且 dirMissing=false（与目录缺失区分）', async () => {
    const dir = await seedCatalog({ 'locks/wp-ghost@1.0.0.lock.yaml': 'schemaVersion: 1\n' })
    // 显式创建空 catalog/ 目录：readdir 成功（无 .json）与 ENOENT 是两条分支。
    await mkdir(join(dir, 'catalog'))
    const catalog = await loadPluginCatalog(dir)
    expect(catalog.manifests).toEqual([])
    expect(catalog.dirMissing).toBe(false)
  })

  it('happy path 自证：仓库 fixture catalog 可加载（命中 get/lockfile、稳定排序）', async () => {
    const catalog = await loadPluginCatalog(FIXTURE_CATALOG_DIR)
    expect(catalog.dirMissing).toBe(false)
    const keys = catalog.manifests.map((m) => `${m.name}@${m.version}`)
    // 不写死全量清单（fixture 可能并行增补），只锚「包含已知包 + 稳定排序」不变量。
    expect(keys).toContain('wp-echo@0.2.1')
    expect(keys).toContain('wp-fixed-time@0.1.0')
    expect(keys).toEqual([...keys].sort())
    expect(catalog.get('wp-echo', '0.2.1')?.entrypoint).toBe('dist/echo.js')
    expect(catalog.get('wp-echo', '9.9.9')).toBeUndefined()
    expect(catalog.lockfile('wp-echo', '0.2.1')).toContain('wp-echo')
  })
})
