/**
 * P1-17 installer 传输面测试（review M3/M4 的机器证据）：
 *
 * - M3 重定向：3xx 逐跳跟随且**每一跳**过 host 白名单（初始 URL 白名单不能
 *   因一次 302 失效）；跳数上限按白名单同码 fail-closed；Location 是攻击者
 *   可控串，错误消息不回显。
 * - M4 体积闸：readCappedBody 流式超限即抛（不收满无界 body）；gunzip
 *   maxOutputLength 截断 gzip bomb（压缩体在 8MiB 上限内、解压超 64MiB 照拒）。
 */
import { gzipSync } from 'node:zlib'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from '@whalepod/protocol'
import { sriFor } from '../src/plugin/integrity.js'
import {
  DEFAULT_MAX_TARBALL_BYTES,
  MAX_TARBALL_REDIRECTS,
  PluginInstaller,
  readCappedBody,
  type PluginFetch,
} from '../src/plugin/installer.js'
import { digestLockfile, type PluginLockfile } from '../src/plugin/lockfile.js'
import { PackageStore } from '../src/plugin/package-store.js'
import { buildTarGz, MAX_UNCOMPRESSED_TAR_BYTES, unpackTarGz } from '../src/plugin/tar.js'

const tempDirs: string[] = []
function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-installer-limits-'))
  tempDirs.push(dir)
  return dir
}
/** 发布的包树是只读的（0o444/0o555）：清理前先恢复写权限再删。 */
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

const PKG_NAME = 'wp-limits-fixture'
const PKG_VERSION = '0.1.0'
const ROOT_URL = `https://registry.npmjs.org/${PKG_NAME}/-/${PKG_NAME}-${PKG_VERSION}.tgz`

function makeManifestAndLock(
  tarball: Buffer,
  url = ROOT_URL,
): {
  manifest: PluginManifest
  lock: PluginLockfile
} {
  const lock: PluginLockfile = {
    schemaVersion: 1,
    package: { name: PKG_NAME, version: PKG_VERSION },
    dependencies: [],
  }
  const manifest: PluginManifest = {
    schemaVersion: 1,
    name: PKG_NAME,
    version: PKG_VERSION,
    tarballUrl: url,
    integrity: sriFor(tarball),
    dependencyLockDigest: digestLockfile(lock),
    dshCompatibility: '0.1.0-rc.8',
    entrypoint: 'index.js',
    capabilities: [],
    capabilityClass: 'declared',
    license: 'MIT',
    review: { status: 'reviewed', commit: 'b'.repeat(40), at: '2026-08-28T00:00:00.000Z' },
  }
  return { manifest, lock }
}

function makeInstaller(fetchImpl: PluginFetch): PluginInstaller {
  return new PluginInstaller({
    store: new PackageStore(join(mktemp(), 'store')),
    fetchImpl,
    allowedHosts: ['registry.npmjs.org', 'cdn.npmjs.org'],
    maxTarballBytes: DEFAULT_MAX_TARBALL_BYTES,
  })
}

const GOOD_TARBALL = buildTarGz([{ path: 'package/index.js', content: Buffer.from('export {}\n') }])

describe('M3 重定向逐跳白名单', () => {
  it('302 到白名单内 host（registry→CDN）跟随成功', async () => {
    const { manifest, lock } = makeManifestAndLock(GOOD_TARBALL)
    const cdnUrl = 'https://cdn.npmjs.org/x.tgz'
    const fetchImpl: PluginFetch = async (url) =>
      url === ROOT_URL
        ? { status: 302, location: cdnUrl, body: Buffer.alloc(0) }
        : { status: 200, body: GOOD_TARBALL }
    const result = await makeInstaller(fetchImpl).install(manifest, lock)
    expect(result.treeDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('相对 Location 按当前 URL 解析并跟随', async () => {
    const { manifest, lock } = makeManifestAndLock(GOOD_TARBALL)
    const finalUrl = 'https://registry.npmjs.org/final/x.tgz'
    const fetchImpl: PluginFetch = async (url) =>
      url === ROOT_URL
        ? { status: 301, location: '/final/x.tgz', body: Buffer.alloc(0) }
        : url === finalUrl
          ? { status: 200, body: GOOD_TARBALL }
          : { status: 404, body: Buffer.alloc(0) }
    const result = await makeInstaller(fetchImpl).install(manifest, lock)
    expect(result.treeDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('302 到白名单外 host → HOST_NOT_ALLOWED，且消息不回显 Location', async () => {
    const { manifest, lock } = makeManifestAndLock(GOOD_TARBALL)
    const evil = 'https://evil.example.com/x.tgz'
    const fetchImpl: PluginFetch = async () => ({
      status: 302,
      location: evil,
      body: Buffer.alloc(0),
    })
    const error = await makeInstaller(fetchImpl)
      .install(manifest, lock)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'HOST_NOT_ALLOWED' })
    expect(String((error as Error).message)).not.toContain('evil.example.com')
  })

  it('重定向链超 MAX_TARBALL_REDIRECTS → HOST_NOT_ALLOWED（环 fail-closed）', async () => {
    const { manifest, lock } = makeManifestAndLock(GOOD_TARBALL)
    let hops = 0
    const fetchImpl: PluginFetch = async () => {
      hops += 1
      return { status: 302, location: ROOT_URL, body: Buffer.alloc(0) }
    }
    await expect(makeInstaller(fetchImpl).install(manifest, lock)).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED',
    })
    expect(hops).toBe(MAX_TARBALL_REDIRECTS + 1)
  })

  it('3xx 无 Location → STORE_IO（无法跟随，不带状态细节外泄）', async () => {
    const { manifest, lock } = makeManifestAndLock(GOOD_TARBALL)
    const fetchImpl: PluginFetch = async () => ({ status: 302, body: Buffer.alloc(0) })
    await expect(makeInstaller(fetchImpl).install(manifest, lock)).rejects.toMatchObject({
      code: 'STORE_IO',
    })
  })
})

describe('M4 体积闸', () => {
  it('readCappedBody：超限即抛 SIZE_LIMIT_EXCEEDED，不收满无界 body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 无限生产者的切片：第一道超限就必须抛，后续 chunk 不应再被消费。
        controller.enqueue(new Uint8Array(64))
        controller.enqueue(new Uint8Array(65))
      },
    })
    await expect(readCappedBody(stream, 100)).rejects.toMatchObject({
      code: 'SIZE_LIMIT_EXCEEDED',
    })
  })

  it('readCappedBody：恰好在上限内通过；null 源给空 Buffer', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100))
        controller.close()
      },
    })
    expect((await readCappedBody(stream, 100)).length).toBe(100)
    expect((await readCappedBody(null, 1)).length).toBe(0)
  })

  it('gzip bomb：压缩体远小于上限、解压超 64MiB → TARBALL_UNSAFE', () => {
    const bomb = buildTarGz([
      {
        path: 'package/big.bin',
        content: Buffer.alloc(MAX_UNCOMPRESSED_TAR_BYTES + 1, 0x41),
      },
    ])
    // 前提自证：压缩体确实在 8MiB tarball 上限内（安装路径会走到解包）。
    expect(bomb.length).toBeLessThan(DEFAULT_MAX_TARBALL_BYTES)
    expect(() => unpackTarGz(bomb)).toThrow(
      expect.objectContaining({ code: 'TARBALL_UNSAFE' }) as object,
    )
  })

  it('gzip bomb 经 install 全链路被拒（SRI 合法也救不了）', async () => {
    const bomb = buildTarGz([
      {
        path: 'package/big.bin',
        content: Buffer.alloc(MAX_UNCOMPRESSED_TAR_BYTES + 1, 0x41),
      },
    ])
    const { manifest, lock } = makeManifestAndLock(bomb)
    const fetchImpl: PluginFetch = async () => ({ status: 200, body: bomb })
    await expect(makeInstaller(fetchImpl).install(manifest, lock)).rejects.toMatchObject({
      code: 'TARBALL_UNSAFE',
    })
  })

  it('坏 gzip 流 → TARBALL_UNSAFE（not a gzip stream 固定话术）', () => {
    expect(() => unpackTarGz(gzipSync('').subarray(0, 4))).toThrow(
      expect.objectContaining({ code: 'TARBALL_UNSAFE' }) as object,
    )
  })
})
