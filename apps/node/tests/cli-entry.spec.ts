/**
 * Node CLI 入口可执行性验收（#95）。
 *
 * 成因：`apps/node/package.json` 声明 `bin.project311-node → ./dist/cli.js`，但
 * `src/cli.ts` 只 `export async function main(argv)`、**文件结尾没有顶层调用**，
 * 于是装好的 `project311-node <任意子命令>` 加载模块、定义函数、exit 0 静默退出。
 * 仓库里从没有人真正执行过这个二进制（集成测手搓 WS 客户端、E2E/chain 在进程内
 * 装配模块），所以缺陷一路隐身到 #89 的组合根红测才被抓出。
 *
 * 判定基线：
 * - 直接执行**发布产物**（package.json 声明的 bin 目标，不是 src 的近似替身）；
 * - 未知子命令必须 usage + exit 2（真实退出码，不是静默 0）；
 * - 反向钉住保护条件：作为库 import 时**不得**自动跑 main（否则单测 import 即执行）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const NODE_PKG_DIR = join(REPO_ROOT, 'apps/node')

/** 从 package.json 读声明的 bin 目标——测的就是用户实际执行的那个文件。 */
function declaredBin(): string {
  const pkg = JSON.parse(readFileSync(join(NODE_PKG_DIR, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>
  }
  const target = pkg.bin?.['project311-node']
  if (target === undefined) throw new Error('package.json 未声明 bin.project311-node')
  return join(NODE_PKG_DIR, target)
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runCli(args: string[]): Promise<RunResult> {
  const bin = declaredBin()
  if (!existsSync(bin)) {
    throw new Error(
      `发布产物不存在：${bin}——单测前的 \`pnpm -r build\` 未执行（#35 陈旧 dist 陷阱）`,
    )
  }
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    // 兜底 kill 时限：入口若真常驻（正常 CLI 不该），判失败而不是把测试挂死。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI 入口未在 15s 内退出；stdout=${stdout.slice(0, 200)}`))
    }, 15_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('#95 project311-node 二进制必须真的执行 main', () => {
  it('无参数执行：输出 usage 并 exit 2（而非静默 exit 0）', async () => {
    const res = await runCli([])
    expect(res.stderr).toContain('usage: project311-node')
    expect(res.code).toBe(2)
  })

  it('未知子命令：同样 usage + exit 2（未知输入不得被当成成功）', async () => {
    const res = await runCli(['definitely-not-a-command'])
    expect(res.stderr).toContain('usage: project311-node')
    expect(res.code).toBe(2)
  })

  it('作为库 import 时不得自动执行 main（顶层调用的保护条件）', async () => {
    const bin = declaredBin()
    const res = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', `await import('${bin}');`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.once('exit', (code) => resolve({ code, stdout, stderr }))
      child.once('error', reject)
    })
    // import 路径上 main 若被无条件调用，会打出 usage 并以 2 退出。
    expect(res.stderr).not.toContain('usage: project311-node')
    expect(res.code).toBe(0)
  })
})
