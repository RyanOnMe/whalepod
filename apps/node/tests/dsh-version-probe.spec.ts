/**
 * 单元：Runtime 版本探针与「唯一装配规则」（#288）。
 *
 * 判定基线（fail-closed 方向）：探针只读 Runtime 打印的事实；拿不到可信版本就返回
 * null，由调用方（preflight）决定拒绝——探针层绝不猜、绝不兜底成别的字符串，也不把
 * 本机可控字符串（未过精确版本 schema）送上 Hub wire。
 * 覆盖：正常读回、非 JSON、零输出（旧 dist 形态）、形状/版本不合法、非零退出、超时
 *（pid 消失自证）、以及 probe → reported 的装配规则。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  probeDshDistributionVersion,
  resolveDshVersionFacts,
} from '../src/plugin/dsh-version-probe.js'

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

/** 进程是否还活着（测试窗口内 pid 不会复用）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

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

  it('零输出 + exit 0（旧 dist 不认识该 flag 的形态）→ null', async () => {
    const entry = stubEntry('process.exit(0)\n')
    await expect(probeDshDistributionVersion(entry)).resolves.toBeNull()
  })

  it('形状/版本不合法（缺 version / 空串 / 非精确版本）→ null', async () => {
    const missing = stubEntry('process.stdout.write(JSON.stringify({ dshName: "x" }) + "\\n")\n')
    await expect(probeDshDistributionVersion(missing)).resolves.toBeNull()
    const blank = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "x", dshVersion: "" }) + "\\n")\n',
    )
    await expect(probeDshDistributionVersion(blank)).resolves.toBeNull()
    // 本机可控串不能原样进 hub wire（node.hello / command.ack 拒绝消息）：
    // 不是精确版本的字符串按「不可知」处理。
    const notExact = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "x", dshVersion: "^0.1.0 rm -rf" }) + "\\n")\n',
    )
    await expect(probeDshDistributionVersion(notExact)).resolves.toBeNull()
  })

  it('非零退出 → null（即使打了一行 JSON）', async () => {
    const entry = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "@deepseek-ai/dsh", dshVersion: "0.1.0-rc.8" }) + "\\n")\nprocess.exit(3)\n',
    )
    await expect(probeDshDistributionVersion(entry)).resolves.toBeNull()
  })

  it('无输出且不退出 → 超时 null，且子进程真的被收掉（pid 消失）', async () => {
    // 探针接口不暴露 pid：让 stub 把 pid 写在自己旁边（同一 URL 解析规则），
    // 「收掉了」才是可证伪的断言——不能只凭「返回了 null」当证据。
    const entry = stubEntry(
      'import { writeFileSync } from "node:fs"\n' +
        'writeFileSync(new URL("stub.pid", import.meta.url), String(process.pid))\n' +
        'setInterval(() => {}, 1000)\n',
    )
    await expect(probeDshDistributionVersion(entry, { timeoutMs: 500 })).resolves.toBeNull()
    const pid = Number(readFileSync(join(entry, '..', 'stub.pid'), 'utf8'))
    expect(Number.isInteger(pid)).toBe(true)
    await expect(waitGone(pid)).resolves.toBe(true)
  })
})

describe('resolveDshVersionFacts（#288 的唯一装配规则）', () => {
  it('探针成功：probed 与 reported 都用探针值（声明的字符串不参与）', async () => {
    const entry = stubEntry(
      'process.stdout.write(JSON.stringify({ dshName: "@deepseek-ai/dsh", dshVersion: "0.1.0-rc.8" }) + "\\n")\n',
    )
    await expect(
      resolveDshVersionFacts(entry, { declared: '9.9.9', env: '8.8.8' }),
    ).resolves.toEqual({ probed: '0.1.0-rc.8', reported: '0.1.0-rc.8' })
  })

  it('探针失败：probed=null（闸 fail-closed），reported 按 声明 → 环境变量 → unmanaged', async () => {
    const entry = stubEntry('process.exit(0)\n')
    await expect(
      resolveDshVersionFacts(entry, { declared: '9.9.9', env: '8.8.8' }),
    ).resolves.toEqual({ probed: null, reported: '9.9.9' })
    await expect(resolveDshVersionFacts(entry, { env: '8.8.8' })).resolves.toEqual({
      probed: null,
      reported: '8.8.8',
    })
    await expect(resolveDshVersionFacts(entry)).resolves.toEqual({
      probed: null,
      reported: 'unmanaged',
    })
  })
})
