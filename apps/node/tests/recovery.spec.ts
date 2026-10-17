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
import { killProcessGroup } from '../src/supervisor/process.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { SecretStore } from '../src/secret/store.js'
import type { RuntimeDriver, RuntimeStartSpec } from '../src/runtime-driver.js'

let root: string

/** 全 spec 的探针 pid（含失败路径）：afterAll 兜底回收，见 reapQuietly 注释。 */
const spawnedProbePids: number[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-recovery-'))
})

afterAll(async () => {
  for (const pid of spawnedProbePids) await reapQuietly(pid)
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
    // RuntimeDriver 的必填方法：与生产同源（进程组 SIGTERM，升级策略由 supervisor 管）。
    async terminate(handle) {
      await killProcessGroup(handle.pid, 'SIGTERM')
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

/** 取一个确定已死的 pid：真 spawn 一个立即退出的进程并等它被回收（pid 复用概率可忽略）。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('spawn failed')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return pid
}

/** #256：轮询到条件成立或超时（等待异步回收不得用固定 sleep 猜时长）。 */
async function waitForValue<T>(
  probe: () => Promise<T | undefined>,
  describe: string,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error(`${describe}（等待上限 ${timeoutMs}ms，判据是条件成立而不是固定时长）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * #305：**负向判据的收尾**。为证明「未发信号 / 未被误杀」而故意留活的探针进程，断言完
 * 必须自己回收——否则每跑一次这份 spec 就在开发机上留一个 `setInterval` 空转的 node
 * 进程（CI 一次性 runner 随 job 消失，掩盖了这类累积）。按 pid 精确 SIGKILL（不用
 * `pkill -f` 之类宽匹配），并把「真的没了」作为收尾判据。
 */
async function reap(pid: number): Promise<void> {
  killQuietly(pid)
  await waitForValue(async () => ((await alive(pid)) ? undefined : true), '探针进程未被回收', 2_000)
  expect(await alive(pid)).toBe(false)
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已退出：ESRCH 视为成功。
  }
}

/**
 * 失败路径的收尾兜底（#305 评审 P2）：断言失败或用例超时是最需要收尾的场景，
 * 但那条路径走不到用例末尾的 `reap()`——所以探针 pid 一注册就交给 afterAll 兜底。
 */
async function reapQuietly(pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  killQuietly(pid)
  await waitForValue(
    async () => ((await alive(pid)) ? undefined : true),
    '探针进程未被回收',
    2_000,
  ).catch(() => {
    // 兜底回收失败不再抛：失败原因仲裁交给主断言，残留由 scripts/check-stray-runtimes.sh 兜。
  })
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

async function makeReadySupervisor(
  stateDbPath: string,
  runId: string,
  /** #356：spawn 时记入 active_runtime 的 DSH 版本（缺省 = 不记，既有用例语义）。 */
  dshDistributionVersion?: string,
): Promise<number> {
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
      WHALEPOD_DSH_SECRET_DSH_API_KEY: 'k',
    }),
    stateDbPath,
    capacity: 2,
    runtimeTimeoutMs: 60_000,
    ...(dshDistributionVersion === undefined ? {} : { dshDistributionVersion }),
  })
  await first.start(spec(runId), { workspaceId: ws.id })
  const record = (await first.activeRuns()).find((r) => r.runId === runId)
  if (record === undefined) throw new Error('active run not recorded')
  spawnedProbePids.push(record.pid)
  return record.pid
}

function reopenedSupervisor(
  stateDbPath: string,
  /** #356：本次启动的探针版本；`null` = cli 的「探不到」形态，与「未注入」是两回事。 */
  dshDistributionVersion?: string | null,
): RuntimeSupervisor {
  const supervisor = new RuntimeSupervisor({
    driver: realProcessDriver(),
    registry: new WorkspaceRegistry(
      join(root, `reg-reopen-${Math.random().toString(36).slice(2)}.sqlite`),
    ),
    secrets: new SecretStore(join(root, `sec-reopen-${Math.random().toString(36).slice(2)}.json`)),
    stateDbPath,
    capacity: 2,
    runtimeTimeoutMs: 60_000,
    ...(dshDistributionVersion === undefined ? {} : { dshDistributionVersion }),
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
    // #256：等进程真的消失（可观察条件），不猜 400ms 够不够。
    await waitForValue(async () => ((await alive(childPid)) ? undefined : true), '孤儿进程未被终止')

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
    // #256 保留静默窗（负向判据）：要证的是「未发信号」——recoverOrphans 已 await，
    // 但异步误杀会在其后才生效，必须留一个有界窗口观察「进程仍活着」。
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(await alive(childPid)).toBe(true) // 进程仍活着（未被误杀）
    expect(lost).toEqual([{ runId, reason: 'orphaned_after_node_restart' }]) // 仍上报 lost 交人工重跑
    expect(await second.activeRuns()).toEqual([])
    second.close()

    // #305：负向判据许下的活口由本用例负责收回（断言「没被杀」之后自己杀）。
    await reap(childPid)
  })

  // ---- #356：换版后的孤儿归因（专用失败码的左侧操作数）----

  it('#356：spawn 版本 != 本次启动版本（升级/回滚形态）→ version_changed_after_node_restart', async () => {
    const stateDb = join(root, `state-vc-${Math.random().toString(36).slice(2)}.sqlite`)
    const runId = 'r-orphan-vc'
    const childPid = await makeReadySupervisor(stateDb, runId, '0.1.0-rc.8')

    // 重启前换版：本次启动探针报的是旧版本（回滚）——归因必须是「版本换了」。
    const second = reopenedSupervisor(stateDb, '0.1.0-rc.7')
    const lost: Array<{ runId: string; reason: string }> = []
    second.onLost((id, reason) => lost.push({ runId: id, reason }))

    await second.recoverOrphans()
    await waitForValue(async () => ((await alive(childPid)) ? undefined : true), '孤儿进程未被终止')

    expect(lost).toEqual([{ runId, reason: 'version_changed_after_node_restart' }])
    expect(await second.activeRuns()).toEqual([])
    second.close()
  })

  it('#356 负控：版本没变 → 仍是 orphaned_after_node_restart（不许把普通重启谎报成换版）', async () => {
    const stateDb = join(root, `state-same-${Math.random().toString(36).slice(2)}.sqlite`)
    const runId = 'r-orphan-same'
    const childPid = await makeReadySupervisor(stateDb, runId, '0.1.0-rc.8')

    const second = reopenedSupervisor(stateDb, '0.1.0-rc.8')
    const lost: Array<{ runId: string; reason: string }> = []
    second.onLost((id, reason) => lost.push({ runId: id, reason }))

    await second.recoverOrphans()
    await waitForValue(async () => ((await alive(childPid)) ? undefined : true), '孤儿进程未被终止')

    expect(lost).toEqual([{ runId, reason: 'orphaned_after_node_restart' }])
    second.close()
  })

  it('#356 负控：任一侧版本未知 → 退回通用归因（探针失败不谎报换版）', async () => {
    // 情形一：spawn 时没记版本（旧库/未注入），本次启动探针成功。
    const stateDbA = join(root, `state-unk-a-${Math.random().toString(36).slice(2)}.sqlite`)
    const runIdA = 'r-orphan-unk-a'
    const pidA = await makeReadySupervisor(stateDbA, runIdA)
    const secondA = reopenedSupervisor(stateDbA, '0.1.0-rc.8')
    const lostA: Array<{ runId: string; reason: string }> = []
    secondA.onLost((id, reason) => lostA.push({ runId: id, reason }))
    await secondA.recoverOrphans()
    await waitForValue(async () => ((await alive(pidA)) ? undefined : true), '孤儿进程未被终止')
    expect(lostA).toEqual([{ runId: runIdA, reason: 'orphaned_after_node_restart' }])
    secondA.close()

    // 情形二：记了版本，但本次启动探针失败——cli 传的是 **probed（null）**，与
    // 情形一的「未注入（undefined）」是两种形态，都要判（评审 A-P2：只钉 undefined
    // 时，把判定里的 null 分支删掉也全绿）。
    const stateDbB = join(root, `state-unk-b-${Math.random().toString(36).slice(2)}.sqlite`)
    const runIdB = 'r-orphan-unk-b'
    const pidB = await makeReadySupervisor(stateDbB, runIdB, '0.1.0-rc.8')
    const secondB = reopenedSupervisor(stateDbB, null)
    const lostB: Array<{ runId: string; reason: string }> = []
    secondB.onLost((id, reason) => lostB.push({ runId: id, reason }))
    await secondB.recoverOrphans()
    await waitForValue(async () => ((await alive(pidB)) ? undefined : true), '孤儿进程未被终止')
    expect(lostB).toEqual([{ runId: runIdB, reason: 'orphaned_after_node_restart' }])
    secondB.close()
  })

  it('#356：早已 dead 的孤儿 + 版本不同 → 仍是通用归因（Run 死于那次崩溃，换版是事后的事）', async () => {
    const stateDb = join(root, `state-dead-vc-${Math.random().toString(36).slice(2)}.sqlite`)
    // 真死 pid（spawn 后等 exit 被回收）→ probeOrphan 必判 dead；别拿「活 pid + 1970 启动
    // 时间」冒充 dead——那是 mismatch，两条分支的语义不同（评审抓到的记账错）。
    const dead = await deadPid()
    const { DatabaseSync } = await import('node:sqlite')
    const seeded = new DatabaseSync(stateDb)
    seeded.exec(`create table active_runtime (
      run_id text primary key, pid integer not null, process_start_time text not null,
      pgid integer not null, runtime_nonce text not null, workspace_id text not null,
      started_at text not null, stderr_tail text, dsh_version text)`)
    seeded
      .prepare(
        'insert into active_runtime (run_id, pid, process_start_time, pgid, runtime_nonce, workspace_id, started_at, stderr_tail, dsh_version) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'r-dead-vc',
        dead,
        '1970-01-01T00:00:00.000Z',
        dead,
        'no-such-nonce',
        'w',
        new Date().toISOString(),
        null,
        '0.1.0-rc.8',
      )
    seeded.close()

    const second = reopenedSupervisor(stateDb, '0.1.0-rc.7')
    const lost: Array<{ runId: string; reason: string }> = []
    second.onLost((id, reason) => lost.push({ runId: id, reason }))
    await second.recoverOrphans()

    expect(lost).toEqual([{ runId: 'r-dead-vc', reason: 'orphaned_after_node_restart' }])
    second.close()
  })

  it('#356：旧状态库（无 dsh_version 列）补列后照常恢复——不因缺列崩，也不谎报换版', async () => {
    const stateDb = join(root, `state-legacy-${Math.random().toString(36).slice(2)}.sqlite`)
    // 用引入本列之前的 DDL 建库并塞一行（模拟升级 Node 后的既有状态库）。
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(stateDb)
    legacy.exec(`create table active_runtime (
      run_id text primary key, pid integer not null, process_start_time text not null,
      pgid integer not null, runtime_nonce text not null, workspace_id text not null,
      started_at text not null, stderr_tail text)`)
    legacy
      .prepare(
        'insert into active_runtime (run_id, pid, process_start_time, pgid, runtime_nonce, workspace_id, started_at, stderr_tail) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'r-orphan-legacy',
        999_999_999,
        '1970-01-01T00:00:00.000Z',
        999_999_999,
        'n',
        'w',
        new Date().toISOString(),
        null,
      )
    legacy.close()

    const second = reopenedSupervisor(stateDb, '0.1.0-rc.8') // 打开即触发补列
    // 判据落在「补列本身」：删掉迁移块这条必须红——恢复流程本身碰不到该列（select *
    // 读得到 undefined、delete/activeRuns 都不点名列），只有 spawn 的 INSERT 才会碰到
    // （见下一条用例），所以「打开后列在」需要显式断言（上一轮评审抓到的假判据）。
    {
      const { DatabaseSync } = await import('node:sqlite')
      const inspect = new DatabaseSync(stateDb)
      const columns = inspect.prepare('pragma table_info(active_runtime)').all() as unknown as {
        name: string
      }[]
      inspect.close()
      expect(columns.map((column) => column.name)).toContain('dsh_version')
    }
    const lost: Array<{ runId: string; reason: string }> = []
    second.onLost((id, reason) => lost.push({ runId: id, reason }))
    await second.recoverOrphans()

    // 死 pid（探测必 dead）→ 不发信号、记录移除；版本列缺失值 = 未知 → 通用归因。
    expect(lost).toEqual([{ runId: 'r-orphan-legacy', reason: 'orphaned_after_node_restart' }])
    expect(await second.activeRuns()).toEqual([])
    second.close()
  })

  it('#356：旧状态库（无 dsh_version 列）上直接 spawn → 补列让 INSERT 可用（绕过迁移即红）', async () => {
    const stateDb = join(root, `state-legacy-spawn-${Math.random().toString(36).slice(2)}.sqlite`)
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(stateDb)
    legacy.exec(`create table active_runtime (
      run_id text primary key, pid integer not null, process_start_time text not null,
      pgid integer not null, runtime_nonce text not null, workspace_id text not null,
      started_at text not null, stderr_tail text)`)
    legacy.close()

    // 判据顺序有意：**先断言补列发生、再 spawn**。迁移被绕过时在无进程阶段就红——否则
    // `start()` 会先 spawn 再 INSERT，INSERT 抛错时 makeReadySupervisor 还没登记 pid，
    // 这条失败路径会漏一个孤儿探针（两轮评审都点到；#305 的同一类账）。
    const opening = reopenedSupervisor(stateDb, '0.1.0-rc.8')
    {
      const inspect = new DatabaseSync(stateDb)
      const columns = inspect.prepare('pragma table_info(active_runtime)').all() as unknown as {
        name: string
      }[]
      inspect.close()
      expect(columns.map((column) => column.name)).toContain('dsh_version')
    }
    opening.close()

    // 补列生效后 spawn：本段验的是**绿态**——INSERT（点名列 dsh_version）跑得通、
    // 且记下的版本值正确。「没有补列就会抛 no column named dsh_version」那条红点
    // 由上面的 pragma 断言承担（它在 spawn 之前，失败路径不留孤儿探针）。
    const runId = 'r-legacy-spawn'
    const pid = await makeReadySupervisor(stateDb, runId, '0.1.0-rc.8')
    expect(await alive(pid)).toBe(true)

    const inspect = new DatabaseSync(stateDb)
    const row = inspect
      .prepare('select dsh_version from active_runtime where run_id = ?')
      .get(runId) as unknown as { dsh_version: string | null } | undefined
    inspect.close()
    expect(row?.dsh_version).toBe('0.1.0-rc.8')

    await reap(pid) // 本用例的探针自己收回（失败路径靠 afterAll 兜底，绿路径不留活口）
  })
})
