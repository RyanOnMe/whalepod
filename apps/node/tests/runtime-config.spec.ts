/**
 * runtime-config 单测（P1-17；02 Task 17 Step 5 的 Node 侧机器证据）。
 *
 * 判定基线：
 * - overlay 生成确定性：同输入产出同字节 yml（跨目录、跨次序）；
 * - entry configDigest 漂移拒绝（fail-closed，不写盘）；
 * - `node_modules/<name>` symlink 锚幂等：重复执行零副作用、dangling/错向自愈、
 *   真实目录占位即拒绝；
 * - overlay/marker 原子写：无 tmp 残留、内容幂等不重写；
 * - installedPackDigests：只上报 marker 校验通过的 64-hex pack 目录。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { pluginCordisEntry, type PluginManifest } from '@whalepod/protocol'
import { digestPluginCordisEntry } from '@whalepod/protocol/plugin-pack-digest'
import { PluginError, sriFor } from '../src/plugin/integrity.js'
import { digestLockfile, type PluginLockfile } from '../src/plugin/lockfile.js'
import { PackageStore } from '../src/plugin/package-store.js'
import { PluginInstaller } from '../src/plugin/installer.js'
import { buildTarGz } from '../src/plugin/tar.js'
import {
  PACK_MARKER_FILENAME,
  PACK_OVERLAY_FILENAME,
  buildPackOverlay,
  ensurePackOverlay,
  installedPackDigests,
  renderPackOverlayYaml,
} from '../src/plugin/runtime-config.js'

// ---------- 夹具 ----------

const tempDirs: string[] = []
function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-runtime-config-'))
  tempDirs.push(dir)
  return dir
}
/** 发布的包树是只读的（0o555）：清理前先恢复写权限再删。 */
function wipeTree(dir: string): void {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o755)
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    const st = lstatSync(child)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) wipeTree(child)
    else chmodSync(child, 0o644)
  }
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    wipeTree(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

const PACK_DIGEST = 'a'.repeat(64)
const PKG_NAME = '@whalepod/wp-fixed-time'
const PKG_VERSION = '0.1.0'

function fixtureTarball(): Buffer {
  return buildTarGz([
    {
      path: 'package/package.json',
      content: Buffer.from(JSON.stringify({ name: PKG_NAME, version: PKG_VERSION }), 'utf8'),
    },
    {
      path: 'package/index.js',
      content: Buffer.from('export const now = () => "2030-01-02"\n', 'utf8'),
    },
  ])
}

function makeLock(tarball: Buffer): PluginLockfile {
  return {
    schemaVersion: 1,
    package: { name: PKG_NAME, version: PKG_VERSION },
    dependencies: [
      {
        name: 'left-pad',
        version: '1.3.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: sriFor(
          buildTarGz([{ path: 'package/index.js', content: Buffer.from('// dep\n') }]),
        ),
      },
    ],
  }
}

function makeManifest(tarball: Buffer, lock: PluginLockfile): PluginManifest {
  return {
    schemaVersion: 1,
    name: PKG_NAME,
    version: PKG_VERSION,
    tarballUrl: 'https://registry.npmjs.org/@whalepod/wp-fixed-time/-/x-0.1.0.tgz',
    integrity: sriFor(tarball),
    dependencyLockDigest: digestLockfile(lock),
    dshCompatibility: '0.1.0-rc.8',
    entrypoint: 'index.js',
    capabilities: [],
    capabilityClass: 'declared',
    license: 'MIT',
    review: { status: 'reviewed', commit: 'b'.repeat(40), at: '2026-08-28T00:00:00.000Z' },
  }
}

/** 真装一包进 content store，拿真实 treeDigest/storePath（与 installer 同一条路径）。 */
async function installFixture(): Promise<{
  manifest: PluginManifest
  treeDigest: string
  storePath: string
  storeRoot: string
}> {
  const tarball = fixtureTarball()
  const lock = makeLock(tarball)
  const manifest = makeManifest(tarball, lock)
  const depTar = buildTarGz([{ path: 'package/index.js', content: Buffer.from('// dep\n') }])
  const storeRoot = join(mktemp(), 'store')
  const installer = new PluginInstaller({
    store: new PackageStore(storeRoot),
    fetchImpl: async (url) =>
      url === manifest.tarballUrl
        ? { status: 200, body: tarball }
        : url === lock.dependencies[0]!.resolved
          ? { status: 200, body: depTar }
          : { status: 404, body: Buffer.alloc(0) },
    allowedHosts: ['registry.npmjs.org'],
    maxTarballBytes: 8 * 1024 * 1024,
  })
  const installed = await installer.install(manifest, lock)
  return { manifest, treeDigest: installed.treeDigest, storePath: installed.path, storeRoot }
}

function expectSyncCode(fn: () => unknown, code: PluginError['code']): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError)
    expect((error as PluginError).code).toBe(code)
    return
  }
  throw new Error(`expected PluginError ${code}, but nothing was thrown`)
}

// ---------- overlay 生成 ----------

describe('overlay 生成', () => {
  it('确定性：同输入重复产出同字节；跨目录仅解析锚前缀随设备路径变化', async () => {
    const fixture = await installFixture()
    const configDigest = digestPluginCordisEntry(pluginCordisEntry(fixture.manifest))
    const packages = [
      {
        manifest: fixture.manifest,
        configDigest,
        treeDigest: fixture.treeDigest,
        storePath: fixture.storePath,
      },
    ]
    // 同 packsRoot 同输入：逐字节相同（overlay 幂等重写也命中此路径）。
    const packsRoot = mktemp()
    const first = buildPackOverlay({ packDigest: PACK_DIGEST, packsRoot, packages })
    const second = buildPackOverlay({ packDigest: PACK_DIGEST, packsRoot, packages })
    expect(second.overlayYaml).toBe(first.overlayYaml)
    expect(readFileSync(first.overlayPath, 'utf8')).toBe(first.overlayYaml)
    // 跨 packsRoot：把设备路径前缀归一后逐字节相同（确定性 = 输入 + 解析布局）。
    const otherRoot = mktemp()
    const other = buildPackOverlay({ packDigest: PACK_DIGEST, packsRoot: otherRoot, packages })
    const normalize = (yaml: string, root: string) => yaml.split(root).join('<packsRoot>')
    expect(normalize(other.overlayYaml, otherRoot)).toBe(normalize(first.overlayYaml, packsRoot))
    expect(first.overlayYaml).toContain('node_modules/@whalepod/wp-fixed-time/index.js')
  })

  it('overlay 是 PatchOptions 顶层数组：每包一条 insert 行 { id, name, config }', async () => {
    const fixture = await installFixture()
    const packsRoot = mktemp()
    const result = buildPackOverlay({
      packDigest: PACK_DIGEST,
      packsRoot,
      packages: [
        {
          manifest: fixture.manifest,
          configDigest: digestPluginCordisEntry(pluginCordisEntry(fixture.manifest)),
          treeDigest: fixture.treeDigest,
          storePath: fixture.storePath,
        },
      ],
    })
    // 注释头之外是纯 YAML 文档，能被独立解析回期望结构。
    const body = result.overlayYaml
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
    const parsed = parseDocument(body).toJS() as Array<{
      insert: Array<Record<string, unknown>>
    }>
    expect(parsed).toHaveLength(1)
    const row = parsed[0]!.insert[0]!
    expect(row).toMatchObject({ id: 'whalepod--wp-fixed-time', config: {} })
    expect(row['name']).toBe(
      join(packsRoot, PACK_DIGEST, 'node_modules', PKG_NAME, fixture.manifest.entrypoint),
    )
    // 解析锚所在目录即 resolutionBaseDir，overlay 就在其中。
    expect(result.resolutionBaseDir).toBe(join(packsRoot, PACK_DIGEST))
  })

  it('entry configDigest 漂移 → INTEGRITY_MISMATCH，且不落任何盘上产物', async () => {
    const fixture = await installFixture()
    const packsRoot = mktemp()
    const packages = [
      {
        manifest: fixture.manifest,
        configDigest: 'c'.repeat(64),
        treeDigest: fixture.treeDigest,
        storePath: fixture.storePath,
      },
    ]
    expectSyncCode(
      () => buildPackOverlay({ packDigest: PACK_DIGEST, packsRoot, packages }),
      'INTEGRITY_MISMATCH',
    )
    expect(existsSync(join(packsRoot, PACK_DIGEST))).toBe(false)
  })

  it('store 树缺失 → STORE_IO（本地存储被清后不静默生成 overlay）', async () => {
    const fixture = await installFixture()
    expectSyncCode(
      () =>
        buildPackOverlay({
          packDigest: PACK_DIGEST,
          packsRoot: mktemp(),
          packages: [
            {
              manifest: fixture.manifest,
              configDigest: digestPluginCordisEntry(pluginCordisEntry(fixture.manifest)),
              treeDigest: fixture.treeDigest,
              storePath: join(fixture.storeRoot, 'sha256', 'gone'),
            },
          ],
        }),
      'STORE_IO',
    )
  })

  it('renderPackOverlayYaml：行按 name 排序、长路径不折叠、每行可读', () => {
    const rows = [
      { id: 'b', name: '/x/node_modules/b/index.js', config: {} },
      { id: 'a', name: '/x/node_modules/a/dist/index.js', config: {} },
    ]
    const yaml = renderPackOverlayYaml(rows, PACK_DIGEST)
    const aIndex = yaml.indexOf('/x/node_modules/a/dist/index.js')
    const bIndex = yaml.indexOf('/x/node_modules/b/index.js')
    expect(aIndex).toBeGreaterThan(-1)
    expect(bIndex).toBeGreaterThan(aIndex)
    for (const line of yaml.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(160) // lineWidth 0：绝不折叠
    }
  })
})

// ---------- pack 目录布局（marker/锚/原子写） ----------

describe('pack 目录布局', () => {
  function recordsOf(fixture: Awaited<ReturnType<typeof installFixture>>) {
    return [
      {
        name: fixture.manifest.name,
        version: fixture.manifest.version,
        entrypoint: fixture.manifest.entrypoint,
        treeDigest: fixture.treeDigest,
        storePath: fixture.storePath,
      },
    ]
  }

  it('marker 落盘且幂等：重复 ensure 零漂移、锚仍指向 store、无 tmp 残留', async () => {
    const fixture = await installFixture()
    const packsRoot = mktemp()
    const input = { packDigest: PACK_DIGEST, packsRoot, packages: recordsOf(fixture) }
    const first = ensurePackOverlay(input)
    const anchor = join(packsRoot, PACK_DIGEST, 'node_modules', PKG_NAME)
    expect(readlinkSync(anchor)).toBe(fixture.storePath)
    const markerBefore = readFileSync(join(packsRoot, PACK_DIGEST, PACK_MARKER_FILENAME), 'utf8')
    const overlayBefore = readFileSync(first.overlayPath, 'utf8')

    const second = ensurePackOverlay(input)
    expect(second.overlayPath).toBe(first.overlayPath)
    expect(readFileSync(join(packsRoot, PACK_DIGEST, PACK_MARKER_FILENAME), 'utf8')).toBe(
      markerBefore,
    )
    expect(readFileSync(second.overlayPath, 'utf8')).toBe(overlayBefore)
    expect(readlinkSync(anchor)).toBe(fixture.storePath)
    const leftovers = readdirSync(join(packsRoot, PACK_DIGEST)).filter((n) => n.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('overlay 文件名固定，marker 记录逐包 store 回执（不含绝对路径）', async () => {
    const fixture = await installFixture()
    const packsRoot = mktemp()
    ensurePackOverlay({ packDigest: PACK_DIGEST, packsRoot, packages: recordsOf(fixture) })
    expect(existsSync(join(packsRoot, PACK_DIGEST, PACK_OVERLAY_FILENAME))).toBe(true)
    const marker = JSON.parse(
      readFileSync(join(packsRoot, PACK_DIGEST, PACK_MARKER_FILENAME), 'utf8'),
    ) as { schemaVersion: number; packDigest: string; packages: Array<Record<string, string>> }
    expect(marker.schemaVersion).toBe(1)
    expect(marker.packDigest).toBe(PACK_DIGEST)
    expect(marker.packages).toEqual([
      {
        name: fixture.manifest.name,
        version: fixture.manifest.version,
        entrypoint: fixture.manifest.entrypoint,
        treeDigest: fixture.treeDigest,
      },
    ])
  })

  it('dangling / 错向 symlink 自愈；真实目录占位 → STORE_IO', async () => {
    const fixture = await installFixture()
    const packsRoot = mktemp()
    const input = { packDigest: PACK_DIGEST, packsRoot, packages: recordsOf(fixture) }
    const anchor = join(packsRoot, PACK_DIGEST, 'node_modules', PKG_NAME)
    mkdirSync(join(anchor, '..'), { recursive: true })

    symlinkSync(join(fixture.storeRoot, 'sha256', 'vanished'), anchor) // dangling
    ensurePackOverlay(input)
    expect(readlinkSync(anchor)).toBe(fixture.storePath)

    unlinkSync(anchor)
    symlinkSync(fixture.storeRoot, anchor) // 错向
    ensurePackOverlay(input)
    expect(readlinkSync(anchor)).toBe(fixture.storePath)

    unlinkSync(anchor)
    mkdirSync(anchor) // 真实目录占位（外部篡改形态）
    expectSyncCode(() => ensurePackOverlay(input), 'STORE_IO')
  })

  it('marker 漂移按已验证期望重写；installedPackDigests 只报有效 pack 目录', async () => {
    const fixture = await installFixture()
    const packsRoot = mktemp()
    mkdirSync(join(packsRoot, PACK_DIGEST), { recursive: true })
    writeFileSync(
      join(packsRoot, PACK_DIGEST, PACK_MARKER_FILENAME),
      JSON.stringify({ schemaVersion: 1, packDigest: PACK_DIGEST, packages: [] }),
    )
    ensurePackOverlay({ packDigest: PACK_DIGEST, packsRoot, packages: recordsOf(fixture) })
    expect(installedPackDigests(packsRoot)).toEqual([PACK_DIGEST])

    // 损坏 marker / 非 hex 目录 / 缺目录：一律不上报。
    mkdirSync(join(packsRoot, 'f'.repeat(64)), { recursive: true })
    writeFileSync(join(packsRoot, 'f'.repeat(64), PACK_MARKER_FILENAME), 'not-json')
    mkdirSync(join(packsRoot, 'scratch'), { recursive: true })
    expect(installedPackDigests(packsRoot)).toEqual([PACK_DIGEST])
    expect(installedPackDigests(join(mktemp(), 'absent'))).toEqual([])
  })
})
