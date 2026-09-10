/**
 * CLI main() 级 argv 解析回归（PR #121 评审实录）。
 *
 * 发现面：workspace-cli.spec.ts 直调 runSecretSet/runWorkspaceCommand，绕过了
 * main() 的 positional 解析——`secret set <provider> <slot>` 的实现曾把
 * positionals[1] 当 provider、要求 'set' 在末尾，与 usage 串和权威规格
 * （02 计划 §secret）相反，用户照文档敲必然 EXIT=2 且不落盘。
 * 本 spec 走真人路径：spawn 真实 cli 组合根（tsx 直跑 src），逐字锁参数序。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TSX_CLI = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

const tmpDirs: string[] = []
afterEach(() => {
  // 取证纪律：tmp 目录随测随清，不留 /tmp。
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})
function mkStateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[], stateDir: string, stdinText = ''): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, join(REPO_ROOT, 'apps/node/src/cli.ts'), ...args, '--state-dir', stateDir],
      { cwd: REPO_ROOT, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => (stdout += String(c)))
    child.stderr?.on('data', (c) => (stderr += String(c)))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.stdin?.write(stdinText)
    child.stdin?.end()
  })
}

describe('cli main() argv 序（secret/workspace）', () => {
  it('secret set <provider> <slot>：按 usage/规格的参数序落盘 0600', async () => {
    const stateDir = mkStateDir('wp-cli-argv-')
    // 非 TTY 下 readHiddenLine 退化为管道行读（cli-commands.ts:17-23 的设计）。
    const r = await runCli(
      ['secret', 'set', 'deepseek-official', 'default'],
      stateDir,
      'sk-argv-test\n',
    )
    expect(r.code, `stderr: ${r.stderr.slice(-300)}`).toBe(0)
    expect(r.stdout).toContain('configured: deepseek-official/default')
    const stored = JSON.parse(readFileSync(join(stateDir, 'secrets.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >
    expect(stored['deepseek-official']?.default).toBe('sk-argv-test')
    expect(statSync(join(stateDir, 'secrets.json')).mode & 0o777).toBe(0o600)
  }, 30_000)

  it('secret 缺参：usage + exit 2，不落盘', async () => {
    const stateDir = mkStateDir('wp-cli-argv-')
    const r = await runCli(['secret', 'deepseek-official'], stateDir)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: whalepod-node secret set <provider> <slot>')
  }, 30_000)

  it('旧错序（set 在末尾）一律拒绝——钉住「正序唯一」，防未来兼容垫片静默放行', async () => {
    // 复审 M2 实录：双序兼容垫片变异下既有三例全绿——正序可用 ≠ 正序唯一。
    const stateDir = mkStateDir('wp-cli-argv-')
    const r = await runCli(
      ['secret', 'deepseek-official', 'default', 'set'],
      stateDir,
      'sk-old-order\n',
    )
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: whalepod-node secret set <provider> <slot>')
  }, 30_000)

  it('workspace add <path> --name <n>：main() 层 positional 同样走通', async () => {
    const stateDir = mkStateDir('wp-cli-argv-')
    const target = mkStateDir('wp-cli-ws-')
    const r = await runCli(['workspace', 'add', target, '--name', 'argv-ws'], stateDir)
    expect(r.code, `stderr: ${r.stderr.slice(-300)}`).toBe(0)
    const list = await runCli(['workspace', 'list'], stateDir)
    expect(list.stdout).toContain('argv-ws')
  }, 30_000)
})
