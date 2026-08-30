/**
 * R9 Node 进程重启（P1-16）：Node 在 Runtime 活跃时重启 → 杀孤儿、上报
 * lost(RUNTIME_LOST)、绝不自动复活/重放；之后由用户显式重跑（G7-04 的
 * rerunOfRunId 血缘，Hub 侧断言见 apps/hub/tests/resilience/run-lease-resilience.spec.ts
 * 与 apps/hub/tests/run-rerun.integration.spec.ts）。
 *
 * 判定基线：
 * - 三重匹配（pid/启动时间/cmdline nonce）命中 → 孤儿进程组被终止（liveness 探针）；
 * - 重启后的 Node 上报 run.snapshot(lost, RUNTIME_LOST)，summary 指明 orphaned；
 * - 断连期间快照先缓冲，重连 flush（与 R1 事件补发同一条上行纪律）；
 * - Hub 重发 run.start（R7 窗口）→ 不 spawn 第二 Runtime、不重发 prompt——
 *   只回放 ack + 重申 lost；任何情况下不自动重放可能有副作用的工具。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandStore } from '../../src/spool/command-store.js'
import { EventStore } from '../../src/spool/event-store.js'
import { SecretStore } from '../../src/secret/store.js'
import { WorkspaceRegistry } from '../../src/workspace/registry.js'
import { RuntimeSupervisor } from '../../src/supervisor/runtime-supervisor.js'
import { RunManager } from '../../src/run/run-manager.js'
import { awaitDead, makeRealProcessDriver } from './harness.js'

let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMMAND_ID = '22222222-2222-4222-8222-222222222222'

function runStartFrame(workspaceId: string): ReturnType<typeof JSON.parse> {
  return JSON.parse(
    JSON.stringify({
      protocolVersion: 1,
      messageId: 'm-1',
      sentAt: new Date().toISOString(),
      type: 'run.start',
      payload: {
        commandId: COMMAND_ID,
        runId: RUN_ID,
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
        workspaceId,
        expectedProfileDigest: 'a'.repeat(64),
        expectedPluginPackDigest: 'b'.repeat(64),
        prompt: 'do the thing',
      },
    }),
  )
}

function snapshotPayloads(sent: string[]): Array<Record<string, unknown>> {
  return sent
    .map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
    .filter((frame) => frame.type === 'run.snapshot')
    .map((frame) => frame.payload as Record<string, unknown>)
}

describe('R9: Node 重启杀孤儿 + lost(RUNTIME_LOST) 上报 + 不自动复活', () => {
  it('重启后：孤儿被杀、snapshot lost 缓冲到重连才发、重复 run.start 不复活', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p311-r9-'))
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true })
    })
    const workspaceDir = join(root, 'ws')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(workspaceDir, { recursive: true })

    // ---- 第一段「进程生命周期」：正常启动 Run（真实子进程）后 Node「崩溃」。----
    const { driver, pids } = makeRealProcessDriver()
    const registry1 = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
    const workspace = await registry1.register(workspaceDir, { name: 'ws-1' })
    const commandStore1 = new CommandStore(join(root, 'commands.db'))
    const eventStore1 = new EventStore(join(root, 'events.db'))
    const sent1: string[] = []
    const supervisor1 = new RuntimeSupervisor({
      driver,
      registry: registry1,
      secrets: new SecretStore(join(root, 'secrets.json'), {
        PROJECT311_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
      }),
      stateDbPath: join(root, 'supervisor.db'),
      capacity: 2,
      runtimeTimeoutMs: 60_000,
    })
    const manager1 = new RunManager({
      supervisor: supervisor1,
      registry: registry1,
      commandStore: commandStore1,
      eventStore: eventStore1,
      send: (frame) => sent1.push(frame),
      runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
      homeDir: '/Users/testhome',
      stateDir: root,
      packsRoot: join(root, 'plugin-packs'),
      deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      dshDistributionVersion: '0.1.0-rc.8',
    })
    await manager1.handleFrame(runStartFrame(workspace.id))
    const childPid = pids[0]
    expect(childPid).toBeGreaterThan(0)
    // Runtime 活跃（用 liveness 探针确认，不自证）。
    const { alive } = await import('./harness.js')
    expect(await alive(childPid)).toBe(true)

    // 「崩溃」：不 stopAll（进程留活），只释放进程内句柄——与进程被杀同形。
    supervisor1.close()
    commandStore1.close()
    eventStore1.close()

    // ---- 第二段：Node 重启，重开同一批状态文件，恢复流程接管。----
    const { driver: driver2, pids: pids2 } = makeRealProcessDriver()
    expect(pids2).toHaveLength(0)
    const registry2 = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
    const commandStore2 = new CommandStore(join(root, 'commands.db'))
    const eventStore2 = new EventStore(join(root, 'events.db'))
    const sent2: string[] = []
    let online2 = false // Node 重启后先处于离线（未连上 Hub）
    const supervisor2 = new RuntimeSupervisor({
      driver: driver2,
      registry: registry2,
      secrets: new SecretStore(join(root, 'secrets.json'), {
        PROJECT311_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
      }),
      stateDbPath: join(root, 'supervisor.db'),
      capacity: 2,
      runtimeTimeoutMs: 60_000,
    })
    const manager2 = new RunManager({
      supervisor: supervisor2,
      registry: registry2,
      commandStore: commandStore2,
      eventStore: eventStore2,
      send: (frame) => {
        if (online2) sent2.push(frame)
      },
      runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
      homeDir: '/Users/testhome',
      stateDir: root,
      packsRoot: join(root, 'plugin-packs'),
      deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      dshDistributionVersion: '0.1.0-rc.8',
    })
    cleanups.push(async () => {
      await supervisor2.stopAll()
      supervisor2.close()
      commandStore2.close()
      eventStore2.close()
    })

    // 恢复流程（cli.ts 顺序：RunManager 就绪 → recoverOrphans）。
    await supervisor2.recoverOrphans()
    expect(await awaitDead(childPid, 5_000)).toBe(true) // 孤儿进程组确被终止

    // 断连期间：lost 快照只缓冲，不发出（快照不落 spool，重连 flush 补达）。
    expect(snapshotPayloads(sent2)).toHaveLength(0)

    // 重连：onReconnect flush lost 快照。
    online2 = true
    manager2.onReconnect()
    const snapshots = snapshotPayloads(sent2)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      runId: RUN_ID,
      status: 'lost',
      failureCode: 'RUNTIME_LOST',
    })
    expect(String(snapshots[0]?.failureSummary)).toContain('orphan')

    // Hub 重发 run.start（R7 窗口）：不 spawn 第二 Runtime、不重放工具/prompt。
    const spawnCountBefore = pids2.length
    await manager2.handleFrame(runStartFrame(workspace.id))
    expect(pids2.length).toBe(spawnCountBefore)
    // ack 幂等回放；lost 快照重申（Hub 侧终态已收敛，重复快照被忽略）。
    const ack = sent2
      .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
      .findLast((frame) => frame.type === 'command.ack')
    expect(ack?.payload).toMatchObject({ commandId: COMMAND_ID, accepted: true })
    expect(snapshotPayloads(sent2).length).toBeGreaterThanOrEqual(1)
    expect(await supervisor2.activeRuns()).toEqual([])
  })

  it('回归哨兵：supervisor close 后迟到的子进程 exit 不炸状态库、不再归因', async () => {
    // 复现评审抓到的偶发（确定性时序）：spawn 真进程 → close()（Runtime 仍活，
    // 即 R9 的「旧实例释放状态库」时刻）→ 杀掉子进程 → exit 回调迟到到达。
    // 若 finalize 触碰已关闭的 SQLite，会在 ChildProcess exit 监听器里抛
    // ERR_INVALID_STATE 未处理异常，vitest 以 unhandled error 判本轮失败——
    // 与线上偶发的失败机制完全同形，因此本哨兵能守住回归。
    const root = await mkdtemp(join(tmpdir(), 'p311-r9-regression-'))
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true })
    })
    const { mkdirSync } = await import('node:fs')
    const workspaceDir = join(root, 'ws')
    mkdirSync(workspaceDir, { recursive: true })

    const { driver, pids } = makeRealProcessDriver()
    const registry = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
    const workspace = await registry.register(workspaceDir, { name: 'ws-regression' })
    const supervisor = new RuntimeSupervisor({
      driver,
      registry,
      secrets: new SecretStore(join(root, 'secrets.json'), {
        PROJECT311_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
      }),
      stateDbPath: join(root, 'supervisor.db'),
      capacity: 2,
      runtimeTimeoutMs: 60_000,
    })
    await supervisor.start(
      {
        runId: RUN_ID,
        nonce: 'nonce-regression',
        workspaceId: workspace.id,
        prompt: 'p',
        agent: {
          id: '55555555-5555-4555-8555-555555555555',
          profileRevisionId: '66666666-6666-4666-8666-666666666666',
          persona: 'p',
          provider: 'dsh',
          model: 'm',
          credentialSlot: 'api_key',
        },
        expectedProfileDigest: 'a'.repeat(64),
        expectedPluginPackDigest: 'b'.repeat(64),
      },
      { workspaceId: workspace.id },
    )
    const pid = (await supervisor.activeRuns()).find((run) => run.runId === RUN_ID)?.pid
    expect(pid).toBeGreaterThan(0)

    const exitEvents: unknown[] = []
    const lostEvents: unknown[] = []
    supervisor.onRuntimeExit((event) => exitEvents.push(event))
    supervisor.onLost((runId, reason) => lostEvents.push({ runId, reason }))

    // close 时子进程仍存活（正是偶发发生的前提时序）。
    supervisor.close()
    process.kill(-pid!, 'SIGKILL')
    const { awaitDead } = await import('./harness.js')
    expect(await awaitDead(pid!, 5_000)).toBe(true)
    // 给 ChildProcess exit 回调一个确定性的派发窗口。
    await new Promise((resolve) => setTimeout(resolve, 100))
    // close 后生命周期已分离：不发布任何归因事实（若 finalize 炸了，上面的
    // 未处理异常已让本轮失败；这里的断言守住「不再归因」语义）。
    expect(exitEvents).toEqual([])
    expect(lostEvents).toEqual([])
  })
})
