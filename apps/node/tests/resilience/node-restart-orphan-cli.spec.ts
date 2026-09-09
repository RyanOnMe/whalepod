/**
 * R9 组合根回归（#118）：走**真实 cli start 子进程**——现有
 * node-restart-orphan.spec.ts 手工装配 RunManager（send 用闭包数组），
 * 恰好绕开 cli.ts 的模块级初始化顺序，因此抓不到「recoverOrphans 在
 * let sessionSend 初始化之前执行」的 TDZ 崩溃（alpha.2 狗食实录：
 * 孤儿+runFacts 齐全时启动即崩 `Cannot access 'sessionSend' before
 * initialization'`，一孤儿一崩）。
 *
 * 崩溃链实证（狗食 run3/4 孤儿三连崩 + 手工复现对照）：
 * recoverOrphans → emitLost → RunManager.reportLostSnapshot →
 * buildSnapshot **命中**（command spool 里有 run.start 事实）→
 * deps.send → cli.ts L190 闭包求值 sessionSend → L222 的 let 尚未执行 → TDZ。
 * 注意：只种 active_runtime 不种命令事实时 buildSnapshot 落空、send 不触发
 * （"lost snapshot skipped"），本测必须两件都种才是真红。
 *
 * 判定基线：
 * - 进程存活（不得 TDZ 崩）；
 * - stderr 出现孤儿 lost 审计行（send 闭包被调到的证据）；
 * - 孤儿行清除（绝不残留、绝不自动复活）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandStore } from '../../src/spool/command-store.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TSX_CLI = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 取一个确定已死的 pid：真 spawn 真杀，立即复用（窗口内 pid 复用概率可忽略）。 */
function deadPid(): number {
  const child = spawn(process.execPath, ['-e', 'setImmediate(() => process.exit(0))'], {
    stdio: 'ignore',
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('spawn failed')
  spawnSync('kill', ['-9', String(pid)])
  return pid
}

describe('R9-CLI：真实 cli start 遇孤儿不得崩（#118 TDZ 回归）', () => {
  it('死 pid 孤儿 + runFacts 齐全：lost 归因审计落 stderr、行清除、进程存活', async () => {
    const home = await mkdtemp(join(tmpdir(), 'p311-r9-cli-'))
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true })
    })
    const configDir = join(home, '.project311-node')
    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        hubUrl: 'http://127.0.0.1:1', // 不可达即可：recoverOrphans 先于会话建立
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        deviceToken: 'dt_test',
      }),
      { mode: 0o600 },
    )
    const runId = '11111111-1111-4111-8111-111111111111'
    // 种子一：命令事实（run.start 落 spool——让 buildSnapshot 命中、send 真触发）。
    const commandStore = new CommandStore(join(stateDir, 'commands.sqlite'))
    commandStore.record({
      commandId: '22222222-2222-4222-8222-222222222222',
      runId,
      type: 'run.start',
      payload: {
        commandId: '22222222-2222-4222-8222-222222222222',
        runId,
        taskId: '33333333-3333-4333-8333-333333333333',
        ownerUserId: '44444444-4444-4444-8444-444444444444',
        agent: {
          id: '55555555-5555-4555-8555-555555555555',
          profileRevisionId: '66666666-6666-4666-8666-666666666666',
          persona: 'test persona',
          provider: 'dsh',
          model: 'test-model',
          credentialSlot: 'api_key',
        },
        workspaceId: '77777777-7777-4777-8777-777777777777',
        expectedProfileDigest: 'a'.repeat(64),
        expectedPluginPackDigest: 'b'.repeat(64),
        prompt: 'do the thing',
      },
    })
    commandStore.close()
    // 种子二：active_runtime 行指向死 pid（三重匹配 → dead → 发 lost 走 send 闭包）。
    const pid = deadPid()
    const db = new DatabaseSync(join(stateDir, 'supervisor.sqlite'))
    db.exec(`create table if not exists active_runtime (
      run_id text primary key, pid integer not null, process_start_time text not null,
      pgid integer not null, runtime_nonce text not null, workspace_id text not null,
      started_at text not null, stderr_tail text)`)
    db.prepare(
      'insert into active_runtime (run_id, pid, process_start_time, pgid, runtime_nonce, workspace_id, started_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      runId,
      pid,
      '1970-01-01T00:00:00.000Z',
      pid,
      'nonce-dead',
      '77777777-7777-4777-8777-777777777777',
      new Date().toISOString(),
    )
    db.close()

    // 真人路径：pnpm exec tsx 的等价形态（直接跑 src，不吃 dist 陈旧的亏）。
    const child = spawn(
      process.execPath,
      [TSX_CLI, join(REPO_ROOT, 'apps/node/src/cli.ts'), 'start'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    cleanups.push(async () => {
      child.kill('SIGKILL')
    })
    let stderr = ''
    child.stderr?.on('data', (c) => {
      stderr += String(c)
    })
    let exitCode: number | null = null
    child.on('exit', (code) => {
      exitCode = code
    })

    // 孤儿处理在启动同步段（recoverOrphans 先于 WS 会话），5 秒足够定生死。
    await sleep(5000)

    expect(
      exitCode,
      `cli 进程在孤儿恢复期间退出（exit=${exitCode}）——stderr: ${stderr.slice(-400)}`,
    ).toBeNull()
    expect(stderr).toContain('orphaned runtime after node restart')
    // 评审 S1：绿测自证快照命中、send 已被驱动（skip 日志缺席），不靠红绿配对保鲜。
    expect(stderr).not.toContain('lost snapshot skipped')
    // 孤儿行已清（WAL 允许并发读）。
    const check = new DatabaseSync(join(stateDir, 'supervisor.sqlite'), { readOnly: true })
    const rows = check.prepare('select count(*) as n from active_runtime').get() as {
      n: number
    }
    check.close()
    expect(rows.n).toBe(0)
  }, 30_000)
})
