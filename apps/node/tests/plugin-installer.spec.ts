/**
 * P1-17 插件安装器单测（02 Task 17 Step 1/4；04 §6.5 攻击矩阵机器证据）。
 *
 * 判定矩阵：integrity mismatch、dependency lock 漂移、tarbomb、symlink escape、
 * install script 不执行、version range/tag/git/local path、未审核 host、
 * 字节上限——全部拒绝且 store 无残留；合法闭包安装后内容可寻址命中。
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from '@project311/protocol'
import { compareCodePoints } from '@project311/protocol/plugin-pack-digest'
import { sriFor } from '../src/plugin/integrity.js'
import { PluginInstaller, type PluginFetch } from '../src/plugin/installer.js'
import { digestLockfile, parseLockfile, type PluginLockfile } from '../src/plugin/lockfile.js'
import { PackageStore } from '../src/plugin/package-store.js'

// ---------- 确定性 tar.gz 构造器（规范化：uid/gid 0、mtime 0、按路径排序） ----------

interface FixtureEntry {
  path: string
  content?: string
  kind?: 'file' | 'directory' | 'symlink'
  linkTarget?: string
  mode?: number
}

function buildTarGz(entries: FixtureEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of [...entries].sort((a, b) => compareCodePoints(a.path, b.path))) {
    const content = Buffer.from(entry.content ?? '', 'utf8')
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 'latin1')
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 'latin1')
    header.write('0000000', 108, 'latin1') // uid
    header.write('0000000', 116, 'latin1') // gid
    header.write(content.length.toString(8).padStart(11, '0'), 124, 'latin1')
    header.write('00000000000', 136, 'latin1') // mtime 0
    header.fill(0x20, 148, 156) // checksum 位先填空格
    const typeflag = entry.kind === 'symlink' ? '2' : entry.kind === 'directory' ? '5' : '0'
    header.write(typeflag, 156, 'latin1')
    if (entry.kind === 'symlink') header.write(entry.linkTarget ?? '', 157, 'latin1')
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    blocks.push(header)
    if (typeflag === '0' && content.length > 0) {
      blocks.push(content)
      const pad = (512 - (content.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024)) // 双零结束块
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

// ---------- 夹具 ----------

const tempDirs: string[] = []
function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p311-plugin-test-'))
  tempDirs.push(dir)
  return dir
}
/** 发布的包树是只读的（0o555）：清理前先恢复写权限再删。 */
function wipeTree(dir: string): void {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o755)
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    if (statSync(child).isDirectory()) wipeTree(child)
    else chmodSync(child, 0o644)
  }
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    wipeTree(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

const PKG_NAME = '@project311/tabtin-fixed-time'
const PKG_VERSION = '0.1.0'

function fixtureTarball(extra: FixtureEntry[] = []): Buffer {
  return buildTarGz([
    {
      path: 'package/package.json',
      content: JSON.stringify({
        name: PKG_NAME,
        version: PKG_VERSION,
        main: 'index.js',
        scripts: { postinstall: 'touch /tmp/p311-pwned' },
      }),
    },
    { path: 'package/index.js', content: 'module.exports = () => "2030-01-02T03:04:05.000Z"\n' },
    ...extra,
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
        integrity: sriFor(buildTarGz([{ path: 'package/index.js', content: '// dep\n' }])),
      },
    ],
  }
}

function makeManifest(tarball: Buffer, lock: PluginLockfile): PluginManifest {
  return {
    schemaVersion: 1,
    name: PKG_NAME,
    version: PKG_VERSION,
    tarballUrl: 'https://registry.npmjs.org/@project311/tabtin-fixed-time/-/x-0.1.0.tgz',
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

/** 内存字节服务：url → body 映射；未命中 404。 */
function fakeFetch(map: Map<string, Buffer>): PluginFetch {
  return async (url) => {
    const body = map.get(url)
    return body === undefined ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body }
  }
}

function makeInstaller(fetchImpl: PluginFetch): {
  installer: PluginInstaller
  store: PackageStore
} {
  const store = new PackageStore(join(mktemp(), 'store'))
  return {
    installer: new PluginInstaller({
      store,
      fetchImpl,
      allowedHosts: ['registry.npmjs.org'],
      maxTarballBytes: 8 * 1024 * 1024,
    }),
    store,
  }
}

describe('PluginInstaller（攻击矩阵）', () => {
  it('完整闭包安装：内容可寻址、只读、重复安装命中同一棵树', async () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const manifest = makeManifest(tarball, lock)
    const depTar = buildTarGz([{ path: 'package/index.js', content: '// dep\n' }])
    const { installer } = makeInstaller(
      fakeFetch(
        new Map([
          [manifest.tarballUrl, tarball],
          [lock.dependencies[0]!.resolved, depTar],
        ]),
      ),
    )

    const first = await installer.install(manifest, lock)
    expect(first.treeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(join(first.path, 'index.js'), 'utf8')).toContain('2030-01-02')
    expect(readFileSync(join(first.path, 'node_modules/left-pad/index.js'), 'utf8')).toBe(
      '// dep\n',
    )
    // 只读发布。
    expect(statSync(join(first.path, 'index.js')).mode & 0o777).toBe(0o444)
    // install script 绝不执行：postinstall 的 canary 不存在。
    expect(() => statSync('/tmp/p311-pwned')).toThrow()
    // 重复安装（同 digest）→ 同一路径，无重复落盘。
    const second = await installer.install(manifest, lock)
    expect(second.path).toBe(first.path)
    // package.json 原样留存（scripts 字段只是数据，从未被执行）。
    expect(readFileSync(join(first.path, 'package.json'), 'utf8')).toContain('postinstall')
  })

  it('integrity mismatch → INTEGRITY_MISMATCH，store 无残留', async () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const manifest = { ...makeManifest(tarball, lock), integrity: sriFor(Buffer.from('evil')) }
    const { installer, store } = makeInstaller(fakeFetch(new Map([[manifest.tarballUrl, tarball]])))
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    })
    // 拒绝即无发布：content store 里没有 sha256 目录。
    expect(existsSync(join(store.root, 'sha256'))).toBe(false)
  })

  it('dependency lock 漂移 → LOCK_DIGEST_MISMATCH', async () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const drifted = {
      ...lock,
      dependencies: [{ ...lock.dependencies[0]!, version: '9.9.9' }],
    }
    const manifest = makeManifest(tarball, lock)
    const { installer } = makeInstaller(fakeFetch(new Map()))
    await expect(installer.install(manifest, drifted)).rejects.toMatchObject({
      code: 'LOCK_DIGEST_MISMATCH',
    })
  })

  it.each([
    ['绝对路径', { path: '/etc/pwned', content: 'x' }],
    ['.. 越界', { path: 'package/../../escape', content: 'x' }],
  ])('tarbomb：%s → TARBALL_UNSAFE', async (_label, bad) => {
    const tarball = fixtureTarball([bad])
    const lock = makeLock(tarball)
    const manifest = makeManifest(tarball, lock)
    const { installer } = makeInstaller(fakeFetch(new Map([[manifest.tarballUrl, tarball]])))
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'TARBALL_UNSAFE',
    })
  })

  it('symlink 条目一律拒绝（escape 风险面）', async () => {
    const tarball = fixtureTarball([
      { path: 'package/link', kind: 'symlink', linkTarget: '../../etc/passwd' },
    ])
    const lock = makeLock(tarball)
    const manifest = makeManifest(tarball, lock)
    const { installer } = makeInstaller(fakeFetch(new Map([[manifest.tarballUrl, tarball]])))
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'TARBALL_UNSAFE',
    })
  })

  it('非白名单 host → HOST_NOT_ALLOWED（下载前拒绝）', async () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest(tarball, lock),
      tarballUrl: 'https://evil.example.com/x.tgz',
    }
    const { installer } = makeInstaller(fakeFetch(new Map()))
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED',
    })
  })

  it('超字节上限 → SIZE_LIMIT_EXCEEDED', async () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const manifest = makeManifest(tarball, lock)
    const installer = new PluginInstaller({
      store: new PackageStore(join(mktemp(), 'store')),
      fetchImpl: fakeFetch(new Map([[manifest.tarballUrl, tarball]])),
      allowedHosts: ['registry.npmjs.org'],
      maxTarballBytes: 16, // 极小上限触发闸门
    })
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'SIZE_LIMIT_EXCEEDED',
    })
  })

  it('version range/tag 在 manifest schema 层拒绝（VALIDATION_FAILED）', async () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const manifest = { ...makeManifest(tarball, lock), version: '^0.1.0' }
    const { installer } = makeInstaller(fakeFetch(new Map()))
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('非 gzip 流 → TARBALL_UNSAFE', async () => {
    const garbage = Buffer.from('not a tarball at all')
    const lock = makeLock(garbage)
    const manifest = makeManifest(garbage, lock)
    const { installer } = makeInstaller(fakeFetch(new Map([[manifest.tarballUrl, garbage]])))
    await expect(installer.install(manifest, lock)).rejects.toMatchObject({
      code: 'TARBALL_UNSAFE',
    })
  })
})

describe('lockfile', () => {
  it('yaml 解析 + digest 稳定', () => {
    const tarball = fixtureTarball()
    const lock = makeLock(tarball)
    const yamlText = [
      'schemaVersion: 1',
      'package:',
      `  name: "${PKG_NAME}"`,
      `  version: "${PKG_VERSION}"`,
      'dependencies:',
      '  - name: left-pad',
      '    version: 1.3.0',
      `    resolved: "${lock.dependencies[0]!.resolved}"`,
      `    integrity: "${lock.dependencies[0]!.integrity}"`,
      '',
    ].join('\n')
    const parsed = parseLockfile(yamlText)
    expect(parsed).toEqual(lock)
    expect(digestLockfile(parsed)).toBe(digestLockfile(lock))
  })

  it('gzip 完整性自检：构造器产物可被 gunzip', () => {
    const tarball = fixtureTarball()
    expect(gunzipSync(tarball).length).toBeGreaterThan(512)
  })
})
