/**
 * Node 重启无孤儿恢复单测（P1-12；02 Task 12 Step 6、R8）。
 *
 * 判定基线：重启后对每个 active_runtime 记录——
 * - OS 探测三重匹配（pid 存活 + 进程启动时间一致 + cmdline 含 --run-id/--nonce）
 *   才终止进程组；任何一项不匹配绝不发信号；
 * - 处理后记录移除，恢复流程上报 RUNTIME_LOST（orphaned_after_node_restart）。
 * nonce 不匹配场景：直接篡改状态库记录（真路径，不设测试钩子）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RuntimeSupervisor } from '../src/supervisor/runtime-supervisor.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { SecretStore } from '../src/secret/store.js'
import type { RuntimeDriver, RuntimeStartSpec } from '../src/runtime-driver.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-recovery-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const LONG_SCRIPT = 'setInterval(() => {}, 1000)'

/** 真进程驱动：cmdline 带 --run-id/--nonce（与生产 DSH Runtime 同形）。 */
function realProcessDriver(): RuntimeDriver {
  return {
    async spawn(spec: RuntimeStartSpec, ctx) {
      const child = spawn(
        process.execPath,
        ['-e', LONG_SCRIPT, '--', '--run-id', spec.runId, '--nonce', spec.nonce],
        { cwd: ctx.cwd, env: ctx.env, stdio: 'ignore', detached: true },
      )
      child.unref()
      return {
        pid: child.pid ?? -1,
        exitPromise: new Promise<void>((resolve) => child.once('exit', () => resolve())),
      }
    },
  }
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function spec(runId: string): RuntimeStartSpec {
  return {
    runId,
    nonce: `nonce-${runId}`,
    workspaceId: 'ws',
    prompt: 'p',
    agent: {
      id: '00000000-0000-4000-8000-000000000001',
      profileRevisionId: '00000000-0000-4000-8000-000000000002',
      persona: 'p',
      provider: 'dsh',
      model: 'm',
      credentialSlot: 'api_key',
    },
    expectedProfileDigest: 'a'.repeat(64),
    expectedPluginPackDigest: 'b'.repeat(64),
  }
}

async function makeReadySupervisor(stateDbPath: string, runId: string): Promise<number> {
  const registry = new WorkspaceRegistry(
    join(root, `reg-${Math.random().toString(36).slice(2)}.sqlite`),
  )
  const dir = join(root, `ws-${runId}`)
  await mkdir(dir)
  const ws = await registry.register(dir, { name: runId })
  const first = new RuntimeSupervisor({
    driver: realProcessDriver(),
    registry,
    secrets: new SecretStore(join(root, `sec-${runId}.json`), {
      PROJECT311_DSH_SECRET_DSH_API_KEY: 'k',
    }),
    stateDbPath,
    capacity: 2,
    runtimeTimeoutMs: 60_000,
  })
  await first.start(spec(runId), { workspaceId: ws.id })
  const record = (await first.activeRuns()).find((r) => r.runId === runId)
  if (record === undefined) throw new Error('active run not recorded')
  return record.pid
}

function reopenedSupervisor(stateDbPath: string): RuntimeSupervisor {
  const supervisor = new RuntimeSupervisor({
    driver: realProcessDriver(),
    registry: new WorkspaceRegistry(
      join(root, `reg-reopen-${Math.random().toString(36).slice(2)}.sqlite`),
    ),
    secrets: new SecretStore(join(root, `sec-reopen-${Math.random().toString(36).slice(2)}.json`)),
    stateDbPath,
    capacity: 2,
    runtimeTimeoutMs: 60_000,
  })
  return supervisor
}

describe('Node 重启无孤儿恢复', () => {
  it('pid+启动时间+cmdline 三重匹配 → 终止进程组，记录移除，上报 orphaned_after_node_restart', async () => {
    const stateDb = join(root, `state-${Math.random().toString(36).slice(2)}.sqlite`)
    const runId = 'r-orphan-1'
    const childPid = await makeReadySupervisor(stateDb, runId)
    expect(await alive(childPid)).toBe(true)

    const second = reopenedSupervisor(stateDb)
    const lost: Array<{ runId: string; reason: string }> = []
    second.onLost((id, reason) => lost.push({ runId: id, reason }))

    await second.recoverOrphans()
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(await alive(childPid)).toBe(false) // 进程组确被终止
    expect(lost).toEqual([{ runId, reason: 'orphaned_after_node_restart' }])
    expect(await second.activeRuns()).toEqual([])
    second.close()
  })

  it('cmdline 不匹配（记录 nonce 被篡改）→ 绝不发信号，记录移除', async () => {
    const stateDb = join(root, `state-mismatch-${Math.random().toString(36).slice(2)}.sqlite`)
    const runId = 'r-orphan-2'
    const childPid = await makeReadySupervisor(stateDb, runId)

    // 篡改状态库里的 nonce：OS 探测 cmdline 与记录不一致 → 不允许发信号。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(stateDb)
    raw
      .prepare('update active_runtime set runtime_nonce = ? where run_id = ?')
      .run('tampered-nonce', runId)
    raw.close()

    const second = reopenedSupervisor(stateDb)
    const lost: Array<{ runId: string; reason: string }> = []
    second.onLost((id, reason) => lost.push({ runId: id, reason }))

    await second.recoverOrphans()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(await alive(childPid)).toBe(true) // 进程仍活着（未被误杀）
    expect(lost).toEqual([{ runId, reason: 'orphaned_after_node_restart' }]) // 仍上报 lost 交人工重跑
    expect(await second.activeRuns()).toEqual([])
    second.close()
  })
})
