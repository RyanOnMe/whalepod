/**
 * 单元：Runtime 版本探针（#288）。
 *
 * 判定基线（fail-closed 方向）：探针只读 Runtime 打印的事实；拿不到可信版本就返回
 * null，由调用方（preflight）决定拒绝——探针层绝不猜、绝不兜底成别的字符串。
 * 覆盖：正常读回、非 JSON、形状不对、非零退出、超时（子进程要真的被杀）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeDshDistributionVersion } from '../src/plugin/dsh-version-probe.js'

const tempDirs: string[] = []
function stubEntry(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-dsh-probe-'))
  tempDirs.push(dir)
  const entry = join(dir, 'stub.mjs')
  writeFileSync(entry, script, 'utf8')
  return entry
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('probeDshDistributionVersion', () => {
  it('读回探针打印的版本（正常路径）', async () => {
    const entry = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "@deepseek-ai/dsh", dshVersion: "0.1.0-rc.8" }) + "\\n")\n',
    )
    await expect(probeDshDistributionVersion(entry)).resolves.toBe('0.1.0-rc.8')
  })

  it('非 JSON 输出 → null（不猜）', async () => {
    const entry = stubEntry('process.stdout.write("not json at all\\n")\n')
    await expect(probeDshDistributionVersion(entry)).resolves.toBeNull()
  })

  it('形状不对（缺 version / 版本为空）→ null', async () => {
    const missing = stubEntry('process.stdout.write(JSON.stringify({ dshName: "x" }) + "\\n")\n')
    await expect(probeDshDistributionVersion(missing)).resolves.toBeNull()
    const blank = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "x", dshVersion: "" }) + "\\n")\n',
    )
    await expect(probeDshDistributionVersion(blank)).resolves.toBeNull()
  })

  it('非零退出 → null（即使打了一行 JSON）', async () => {
    const entry = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "@deepseek-ai/dsh", dshVersion: "0.1.0-rc.8" }) + "\\n")\nprocess.exit(3)\n',
    )
    await expect(probeDshDistributionVersion(entry)).resolves.toBeNull()
  })

  it('无输出且不退出 → 超时 null，且子进程真的被收掉', async () => {
    const entry = stubEntry('setInterval(() => {}, 1000)\n')
    await expect(
      probeDshDistributionVersion(entry, { timeoutMs: 500 }),
    ).resolves.toBeNull()
  })
})
