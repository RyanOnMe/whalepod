/**
 * P1-17 fixture 插件数据树验证（02 Task 17 Step 8；plugins/ 登记一致性）。
 *
 * 机器证据链：
 * 1. 确定性：apps/node buildTarGz 对 fixture 源码重打包 == 已提交 tarball 字节。
 * 2. 回环：unpackTarGz(已提交 tarball) 的文件集与 fixture 源逐字节一致（npm
 *    布局 package/ 前缀剥掉后）。
 * 3. catalog：过 PluginManifestSchema；integrity == 现算 tarball SRI。
 * 4. lockfile：apps/node parseLockfile 可解析；digestLockfile ==
 *    manifest.dependencyLockDigest（空闭包：dsh-tools 是 peerDependency）。
 * 5. Pack 锚：configDigest == digestPluginCordisEntry(pluginCordisEntry(manifest))、
 *    packDigest == digestPluginPack(...)（protocol 算法复算），且 manifest 与
 *    pack entry 的 integrity / dependencyLockDigest / entrypoint 三阶段同值。
 * 6. fixture 自证清白：index.js 无 fs/net/child_process import，外部 import
 *    只有宿主提供的 @deepseek-ai/dsh-tools（生态 peer 用法）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PluginManifestSchema, pluginCordisEntry } from '@project311/protocol'
// digest 算法从 protocol 源码引入（同 packages/protocol/tests 惯例；子路径导出
// @project311/protocol/plugin-pack-digest 目前会被 check-boundaries 全 specifier
// 匹配拒绝，dist 边界已由下方 parseLockfile → apps/node lockfile.js 传递覆盖）。
import {
  digestPluginCordisEntry,
  digestPluginPack,
} from '../../../packages/protocol/src/plugin-pack-digest.js'
import { digestLockfile, parseLockfile } from '../src/plugin/lockfile.js'
import { buildTarGz, unpackTarGz } from '../src/plugin/tar.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE_DIR = join(REPO_ROOT, 'plugins/fixtures/project311-fixed-time')
const TARBALL_PATH = join(REPO_ROOT, 'plugins/tarballs/project311-fixed-time-0.1.0.tgz')
const LOCK_PATH = join(REPO_ROOT, 'plugins/locks/project311-fixed-time@0.1.0.lock.yaml')
const CATALOG_PATH = join(REPO_ROOT, 'plugins/catalog/project311-fixed-time.json')
const PACK_PATH = join(REPO_ROOT, 'plugins/curated-pack.json')

/** fixture 源码文件全集（相对路径 → 字节），与生成脚本的收集口径一致。 */
function readFixtureFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      if (!statSync(abs).isFile()) continue
      files.set(prefix === '' ? name : `${prefix}/${name}`, readFileSync(abs))
    }
  }
  walk(FIXTURE_DIR, '')
  return files
}

/** fixture 源码重打包（npm 布局 package/ 前缀）——与 scripts/build-fixture-plugin.mts 同构。 */
function rebuildTarball(): Buffer {
  const entries = [...readFixtureFiles()].map(([path, content]) => ({
    path: `package/${path}`,
    content,
  }))
  return buildTarGz(entries)
}

function sha256Sri(content: Buffer): string {
  return `sha256-${createHash('sha256').update(content).digest('base64')}`
}

describe('fixture tarball（catalog/install/runtime 的 integrity 锚）', () => {
  it('buildTarGz 重打包 fixture 源 == 已提交 tarball 字节（确定性）', () => {
    expect(existsSync(TARBALL_PATH)).toBe(true)
    expect(rebuildTarball().equals(readFileSync(TARBALL_PATH))).toBe(true)
  })

  it('gzip 头平台字段已归一（mtime=0、XFL 随 level 固定、OS=3 Unix）', () => {
    // 跨平台字节级确定性的全部平台相关面：zlib 编译期 OS_CODE 在 macOS=19、
    // Linux=3，不归一则 catalog integrity 跨平台复算漂移（P1-17 CI 实证）。
    const header = rebuildTarball().subarray(0, 10)
    expect([...header.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08])
    expect(header.readUInt32LE(4)).toBe(0) // mtime
    expect(header[9]).toBe(3) // OS 归一为 Unix
  })

  it('unpackTarGz(已提交 tarball) 解出文件集与 fixture 源逐字节一致', () => {
    const entries = unpackTarGz(readFileSync(TARBALL_PATH))
    const files = readFixtureFiles()
    const unpacked = new Map<string, Buffer>()
    for (const entry of entries) {
      // npm tarball 根前缀：全部条目都必须带 package/。
      expect(entry.path.startsWith('package/')).toBe(true)
      expect(entry.kind).toBe('file')
      unpacked.set(entry.path.replace(/^package\//, ''), entry.content)
    }
    expect([...unpacked.keys()].sort()).toEqual([...files.keys()].sort())
    for (const [path, content] of unpacked) {
      expect(content.equals(files.get(path)!), `byte mismatch: ${path}`).toBe(true)
    }
  })

  it('catalog manifest 过 PluginManifestSchema 且 integrity == 现算 tarball SRI', () => {
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
    expect(manifest.name).toBe('project311-fixed-time')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.dshCompatibility).toBe('0.1.0-rc.8')
    expect(manifest.integrity).toBe(sha256Sri(rebuildTarball()))
  })
})

describe('fixture lockfile（install 阶段的 dependency lock 锚）', () => {
  it('parseLockfile 可解析且 digestLockfile == manifest.dependencyLockDigest', () => {
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
    const lock = parseLockfile(readFileSync(LOCK_PATH, 'utf8'))
    expect(lock.package).toEqual({ name: 'project311-fixed-time', version: '0.1.0' })
    // dsh-tools 是宿主提供的 peerDependency：安装闭包为空。
    expect(lock.dependencies).toEqual([])
    expect(digestLockfile(lock)).toBe(manifest.dependencyLockDigest)
  })
})

describe('curated pack（runtime 阶段的 pack digest 锚）', () => {
  const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8')) as {
    schemaVersion: number
    name: string
    packages: Array<{
      name: string
      version: string
      integrity: string
      dependencyLockDigest: string
      entrypoint: string
      configDigest: string
    }>
    packDigest: string
  }

  it('configDigest == digestPluginCordisEntry(pluginCordisEntry(manifest))', () => {
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
    expect(pack.packages).toHaveLength(1)
    const entry = pack.packages[0]!
    expect(entry.configDigest).toBe(digestPluginCordisEntry(pluginCordisEntry(manifest)))
  })

  it('packDigest == digestPluginPack（protocol 算法复算）', () => {
    const packDigest = digestPluginPack({ schemaVersion: 1, packages: pack.packages })
    expect(pack.packDigest).toBe(packDigest)
    expect(pack.schemaVersion).toBe(1)
    expect(pack.name).toBe('fixed-time')
  })

  it('三阶段 digest 锚：manifest 与 pack entry 复用同一 integrity/lock digest/entrypoint', () => {
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
    const entry = pack.packages[0]!
    expect(entry.name).toBe(manifest.name)
    expect(entry.version).toBe(manifest.version)
    expect(entry.integrity).toBe(manifest.integrity)
    expect(entry.dependencyLockDigest).toBe(manifest.dependencyLockDigest)
    expect(entry.entrypoint).toBe(manifest.entrypoint)
  })
})

describe('fixture 自证清白（unmodified plugin 的静态断言）', () => {
  const FORBIDDEN_SOURCE = /^(node:)?(fs|net|child_process)(\/|$)/

  /** 抓取一个 JS 源里全部 import/require 目标（static / dynamic / side-effect）。 */
  function importSpecifiers(rawSource: string): string[] {
    // 先剥注释：doc 注释里出现的 import('…') 示例不是代码。
    const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const specifiers: string[] = []
    for (const re of [
      /\bfrom\s+['"]([^'"]+)['"]/g, // import … from 'x' / export … from 'x'
      /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import 'x'
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // CJS require('x')
    ]) {
      for (const match of source.matchAll(re)) specifiers.push(match[1]!)
    }
    return specifiers
  }

  it('index.js 不含 fs/net/child_process import', () => {
    const source = readFileSync(join(FIXTURE_DIR, 'index.js'), 'utf8')
    const forbidden = importSpecifiers(source).filter((s) => FORBIDDEN_SOURCE.test(s))
    expect(forbidden, `forbidden imports: ${forbidden.join(', ')}`).toEqual([])
  })

  it('外部 import 只有宿主提供的 @deepseek-ai/dsh-tools；package.json 无运行时依赖', () => {
    const source = readFileSync(join(FIXTURE_DIR, 'index.js'), 'utf8')
    const external = importSpecifiers(source).filter(
      (s) => !s.startsWith('.') && !s.startsWith('/'),
    )
    expect(external).toEqual(['@deepseek-ai/dsh-tools'])

    const pkg = JSON.parse(readFileSync(join(FIXTURE_DIR, 'package.json'), 'utf8')) as {
      name: string
      version: string
      type: string
      main: string
      license: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(pkg.name).toBe('project311-fixed-time')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.type).toBe('module')
    expect(pkg.main).toBe('index.js')
    expect(pkg.license).toBe('Apache-2.0')
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.peerDependencies?.['@deepseek-ai/dsh-tools']).toBeDefined()
  })
})
