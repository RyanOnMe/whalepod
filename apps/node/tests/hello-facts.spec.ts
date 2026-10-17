/**
 * #352：hello 事实装配面（gateway/hello-facts.ts）单测。
 *
 * 判的是「设备事实的刷新语义」本身，不含会话发送路径（那条在 session.spec.ts
 * 的 #352 组里用 FakeSocket 判，两个面各自可单点削弱）：
 * - `createHelloFacts`：pack digests 每次**读盘**（装/重建后立刻可见、半成品不上报）；
 *   DSH 版本重探，探针失败回落启动值（不谎报、不抛）。
 * - `refreshHelloAfterPreflight`：非 core-empty 装配成功后补发**一次**；core-empty
 *   不补发；ensure 异常原样穿透且不补发（刷新失败不改变 preflight 成败）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHelloFacts, refreshHelloAfterPreflight } from '../src/gateway/hello-facts.js'
import { PACK_MARKER_FILENAME } from '../src/plugin/runtime-config.js'
import { CORE_EMPTY_PACK_DIGEST } from '../src/plugin/plugin-preflight.js'

const dirs: string[] = []
function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-hello-facts-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 有效 pack 目录（marker 齐备且非空包清单）——installedPackDigests 的收录条件。 */
function installPack(packsRoot: string, packDigest: string): void {
  const dir = join(packsRoot, packDigest)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, PACK_MARKER_FILENAME),
    JSON.stringify({
      schemaVersion: 1,
      packDigest,
      packages: [
        {
          name: '@e2e/e2e-pack',
          version: '0.1.0',
          entrypoint: 'index.js',
          treeDigest: 'd'.repeat(64),
          dshCompatibility: '0.1.0-rc.8',
        },
      ],
    }),
  )
}

describe('#352 createHelloFacts', () => {
  it('pack digests 每次调用读盘：装了才出现、半成品（空清单）不上报', async () => {
    const stateDir = mktemp()
    const packsRoot = join(stateDir, 'plugin-packs')
    mkdirSync(packsRoot, { recursive: true })
    const digest = 'b'.repeat(64)
    const facts = createHelloFacts({
      stateDir,
      runtimeEntry: '/nonexistent/runtime-bin.js',
      startupDshVersion: '0.1.0-rc.8',
      probeDshVersion: async () => null,
    })

    // 装之前：空。
    expect((await facts()).pluginPackDigests).toEqual([])

    // 启动时冻结对象会永远停在空——本断言正是 #352 的判据。
    installPack(packsRoot, digest)
    expect((await facts()).pluginPackDigests).toEqual([digest])

    // 后续又装一个：同一进程内立刻可见（不重启、不重连）。
    const second = 'c'.repeat(64)
    installPack(packsRoot, second)
    expect((await facts()).pluginPackDigests).toEqual([second, digest].sort())

    // 空清单（core-empty 形态的半成品）不算已安装。
    const empty = join(packsRoot, 'e'.repeat(64))
    mkdirSync(empty, { recursive: true })
    writeFileSync(
      join(empty, PACK_MARKER_FILENAME),
      JSON.stringify({ schemaVersion: 1, packDigest: 'e'.repeat(64), packages: [] }),
    )
    expect((await facts()).pluginPackDigests).toEqual([second, digest].sort())
  })

  it('DSH 版本每次重探；探针失败或抛错一律回落启动值，不抛不谎报', async () => {
    const stateDir = mktemp()
    const probe = vi.fn<(entry: string) => Promise<string | null>>()
    const facts = createHelloFacts({
      stateDir,
      runtimeEntry: '/resolved/runtime-bin.js',
      startupDshVersion: '0.1.0-rc.8',
      probeDshVersion: probe,
    })

    probe.mockResolvedValueOnce('0.1.0-rc.9')
    expect((await facts()).dshDistributionVersion).toBe('0.1.0-rc.9')
    // 探针拿到的是 Runtime 入口（真 bin 探针，与启动锚同源）。
    expect(probe).toHaveBeenLastCalledWith('/resolved/runtime-bin.js')

    // 换版后没探到（null）→ 报启动值，不假报新版本。
    probe.mockResolvedValueOnce(null)
    expect((await facts()).dshDistributionVersion).toBe('0.1.0-rc.8')

    // 探针本身抛错 → 同样回落启动值，不穿透（hello 帧照发）。
    probe.mockRejectedValueOnce(new Error('spawn failed'))
    const soft = await facts()
    expect(soft.dshDistributionVersion).toBe('0.1.0-rc.8')
    // 平台/架构/Node 版本与进程事实一致（与刷新无关的常量，顺带钉住形状）。
    expect(soft.nodeVersion).toBe(process.version)
    expect(soft.architecture).toBe(process.arch)
  })
})

describe('#352 refreshHelloAfterPreflight', () => {
  it('非 core-empty：ensure 成功后补发一次；ensure 在前（补发看到的是装好的盘）', async () => {
    const order: string[] = []
    const resendHello = vi.fn(() => order.push('resend'))
    const wrapped = refreshHelloAfterPreflight({
      ensure: async (digest: string) => {
        order.push(`ensure:${digest}`)
        return { packages: 1 }
      },
      resendHello,
    })

    await expect(wrapped('a'.repeat(64))).resolves.toEqual({ packages: 1 })
    expect(resendHello).toHaveBeenCalledTimes(1)
    expect(order).toEqual([`ensure:${'a'.repeat(64)}`, 'resend'])
  })

  it('core-empty：装配成功也不补发（无落盘事实可刷，白跑一次探针）', async () => {
    const resendHello = vi.fn()
    const wrapped = refreshHelloAfterPreflight({
      ensure: async () => '{}',
      resendHello,
    })

    await wrapped(CORE_EMPTY_PACK_DIGEST)
    expect(resendHello).not.toHaveBeenCalled()
  })

  it('ensure 失败：异常原样穿透、不补发（补发不改变 preflight 成败）', async () => {
    const failure = new Error('pack digest mismatch')
    const resendHello = vi.fn()
    const wrapped = refreshHelloAfterPreflight({
      ensure: async () => {
        throw failure
      },
      resendHello,
    })

    await expect(wrapped('a'.repeat(64))).rejects.toBe(failure)
    expect(resendHello).not.toHaveBeenCalled()
  })
})
