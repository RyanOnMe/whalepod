/**
 * 探针：`--print-dsh-version` 一次性模式（#288）。
 *
 * Node 的「敏感不兼容禁启动」preflight 需要真实的本机 DSH 版本，而唯一能给出它的
 * 进程是 Runtime 本身（唯一允许 import @deepseek-ai/* 的一侧）。判据：真 bin 带该
 * flag 启动后 stdout 恰一行 JSON（**不是协议帧**）、退出码 0、版本等于 boot 锚树里
 * 的 @deepseek-ai/dsh 版本；不需要 replay overlay、不读 stdin、不 boot DSH。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const BIN = join(REPO_ROOT, 'apps/runtime/src/bin.ts')

interface ProbeResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

async function runProbe(): Promise<ProbeResult> {
  const child = spawn(process.execPath, ['--import', 'tsx', BIN, '--print-dsh-version'], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  // 不写 stdin、不关 stdin：探针模式必须自己收敛退出（真实 Node 调用方不发任何帧）。
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', (exitCode) => resolve(exitCode))
  })
  return { stdout, stderr, code }
}

describe('probe: --print-dsh-version（#288）', () => {
  it('恰一行 JSON、退出 0、版本与 boot 锚树一致', { timeout: 60_000 }, async () => {
    const result = await runProbe()
    expect(result.code).toBe(0)
    const lines = result.stdout.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] ?? '') as { dshName: string; dshVersion: string }
    const require = createRequire(join(REPO_ROOT, 'packages/runtime-dsh/src/index.ts'))
    const packageJson = JSON.parse(
      readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
    ) as { name: string; version: string }
    expect(parsed.dshName).toBe(packageJson.name)
    expect(parsed.dshVersion).toBe(packageJson.version)
  })
})
