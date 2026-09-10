/**
 * G7-02 取消升级路径（P1-16；03 §3.2「cancel_requested 15 秒未确认时 Node
 * Supervisor 终止 Runtime，写 cancelled(forced)」、02 Task 16 Step 3）。
 *
 * 判定基线：
 * - run.cancel → stdin 派发 + ack；确认窗口内不动进程；
 * - 窗口过期（测试注入 100ms）→ SIGTERM（driver.terminate）；每阶段写
 *   node.supervisor 结构化日志；
 * - SIGTERM 宽限（50ms）仍不退 → SIGKILL（driver.forceKill）；
 * - 强杀退出且 Runtime 从未确认 → run.cancelled(forced=true) 双受众投影，
 *   走与真人路径一致的 stdout→projector→spool→uplink 链路；
 * - Runtime 主动确认（run.cancelled 帧）→ forced=false，无升级信号，计时器清空；
 * - 真人路径探针：真实 node 子进程——普通进程 SIGTERM 即死；SIGTERM 免疫进程
 *   被 SIGKILL 收尾（liveness 探针判定，绝不自证）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectedRunEvent } from '@whalepod/protocol'
import {
  alive,
  awaitDead,
  cancelFrame,
  makeRealProcessDriver,
  makeResilienceHarness,
  ManualTimers,
  runCancelledLine,
  runStartFrame,
  RUN_ID,
  runtimeReadyLine,
  type ResilienceHarness,
} from './harness.js'

let cleanupFns: Array<() => Promise<void>> = []

beforeAll(() => {
  cleanupFns = []
})

afterAll(async () => {
  for (const fn of cleanupFns.reverse()) await fn()
})

function forcedCancelEvents(harness: ResilienceHarness): Array<ProjectedRunEvent> {
  return harness.runEvents().filter((event) => event.event.type === 'run.cancelled')
}

describe('G7-02: 取消升级（脚本化 Runtime，手动时钟）', () => {
  it('确认窗口内只派发 stdin cancel；窗口过期 SIGTERM；再宽限后 SIGKILL；强制退出投影 forced=true', async () => {
    const timers = new ManualTimers()
    const harness = await makeResilienceHarness({
      behavior: { diesOnTerminate: false }, // 模拟忽略 SIGTERM 的 Runtime
      cancelConfirmMs: 100,
      cancelTermGraceMs: 50,
      timers,
    })
    cleanupFns.push(harness.cleanup)

    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    expect(harness.signals).toHaveLength(0)

    await harness.manager.handleFrame(cancelFrame())
    const cancelCommand = harness.runtimes[0]?.stdin.find((c) => c.type === 'run.cancel')
    expect(cancelCommand).toBeDefined()
    // ack 已回，进程未被动过。
    const ack = harness.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({
      commandId: 'c9c9c9c9-c9c9-4999-8999-c9c9c9c9c9c9',
      accepted: true,
    })
    expect(harness.signals).toHaveLength(0)
    expect(timers.pendingCount()).toBe(1)

    // 15s（注入为 100ms）确认窗口过期 → SIGTERM，阶段日志带 component。
    timers.advance(100)
    expect(harness.signals).toEqual([{ runId: RUN_ID, kind: 'terminate' }])
    expect(
      harness.logs.some(
        (log) => log.component === 'node.supervisor' && log.msg.includes('sigterm'),
      ),
    ).toBe(true)

    // 再 5s（注入为 50ms）仍不退 → SIGKILL；退出后 forced=true 投影上行。
    timers.advance(50)
    expect(harness.signals).toEqual([
      { runId: RUN_ID, kind: 'terminate' },
      { runId: RUN_ID, kind: 'forceKill' },
    ])
    const cancelled = forcedCancelEvents(harness)
    expect(cancelled).toHaveLength(2) // owner + project
    for (const event of cancelled) {
      expect(event.event).toMatchObject({ type: 'run.cancelled', forced: true })
    }
    expect(harness.eventStore.pending(RUN_ID)).toHaveLength(2)
    // Run 已终态：升级计时器全部清空，不再升级。
    expect(timers.pendingCount()).toBe(0)
  })

  it('SIGTERM 后进程退出则不再 SIGKILL（升级链路短路）', async () => {
    const timers = new ManualTimers()
    const harness = await makeResilienceHarness({
      behavior: { diesOnTerminate: true },
      cancelConfirmMs: 100,
      cancelTermGraceMs: 50,
      timers,
    })
    cleanupFns.push(harness.cleanup)

    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    await harness.manager.handleFrame(cancelFrame())

    timers.advance(100)
    expect(harness.signals).toEqual([{ runId: RUN_ID, kind: 'terminate' }])
    // 同步退出派发已收敛 forced 终态；50ms 宽限计时器被清空，SIGKILL 不发生。
    timers.advance(50)
    expect(harness.signals).toHaveLength(1)
    const cancelled = forcedCancelEvents(harness)
    expect(cancelled.length).toBe(2)
    expect(cancelled[0]?.event).toMatchObject({ forced: true })
    expect(timers.pendingCount()).toBe(0)
  })

  it('Runtime 主动确认 run.cancelled → forced=false、无升级信号；prompt 退出后 reap 链静默', async () => {
    const timers = new ManualTimers()
    const harness = await makeResilienceHarness({
      cancelConfirmMs: 100,
      cancelTermGraceMs: 50,
      timers,
    })
    cleanupFns.push(harness.cleanup)

    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    await harness.manager.handleFrame(cancelFrame())

    harness.runtimes[0]?.emitStdout(runCancelledLine(RUN_ID))
    const cancelled = forcedCancelEvents(harness)
    expect(cancelled.length).toBe(2)
    for (const event of cancelled) {
      expect(event.event).toMatchObject({ type: 'run.cancelled', forced: false })
    }
    expect(harness.signals).toHaveLength(0)

    // Runtime 如桥的正常行为：上报后即刻退出（code=0）。
    harness.runtimes[0]?.exitWith(0, null)
    // reap 宽限整段推进：进程已死 → 无任何信号，计时器清空。
    timers.advance(1000)
    expect(harness.signals).toHaveLength(0)
    expect(timers.pendingCount()).toBe(0)
    // 终态事实不重复：只有 cancelled 一份（forced=false）。
    expect(forcedCancelEvents(harness).length).toBe(2)
  })

  it('确认后 Runtime 迟迟不退 → reap 链 SIGTERM/SIGKILL 收尾（终态不受影响）', async () => {
    const timers = new ManualTimers()
    const harness = await makeResilienceHarness({
      behavior: { diesOnTerminate: false },
      cancelConfirmMs: 100,
      cancelTermGraceMs: 50,
      timers,
    })
    cleanupFns.push(harness.cleanup)

    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    await harness.manager.handleFrame(cancelFrame())
    harness.runtimes[0]?.emitStdout(runCancelledLine(RUN_ID))
    expect(forcedCancelEvents(harness).every((event) => event.event.type === 'run.cancelled')).toBe(
      true,
    )

    timers.advance(50) // reap 宽限到期 → SIGTERM（进程忽略）
    expect(harness.signals).toEqual([{ runId: RUN_ID, kind: 'terminate' }])
    timers.advance(50) // reap 再宽限 → SIGKILL
    expect(harness.signals).toEqual([
      { runId: RUN_ID, kind: 'terminate' },
      { runId: RUN_ID, kind: 'forceKill' },
    ])
    // 终态保持 cancelled(forced=false)：reap 不产生第二份终态投影。
    const cancelled = forcedCancelEvents(harness)
    expect(cancelled).toHaveLength(2)
    expect(cancelled[0]?.event).toMatchObject({ forced: false })
  })
})

describe('G7-02: 真人路径强杀探针（真实 node 子进程 + 真实信号）', () => {
  it('普通 Runtime 忽略 stdin cancel，确认窗口过期后被 SIGTERM 终止（进程组死亡）', async () => {
    const { driver, pids } = makeRealProcessDriver()
    const harness = await makeResilienceHarness({
      driverOverride: driver,
      cancelConfirmMs: 60,
      cancelTermGraceMs: 60,
    })
    cleanupFns.push(harness.cleanup)
    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    const pid = pids[0]
    expect(pid).toBeGreaterThan(0)
    expect(await alive(pid)).toBe(true)

    await harness.manager.handleFrame(cancelFrame())
    // 真实长驻进程不读 stdin 也不上报 cancelled：升级链路必须收尾。
    const deadline = Date.now() + 10_000
    for (;;) {
      const dead = await awaitDead(pid, 500)
      if (dead) break
      if (Date.now() > deadline) break
    }
    expect(await alive(pid)).toBe(false)

    // forced=true 投影经 stdout 同一条链路上行（真实进程无 stdout 输出 → 由退出分类合成）。
    const deadline2 = Date.now() + 5_000
    for (;;) {
      if (forcedCancelEvents(harness).length > 0) break
      if (Date.now() > deadline2) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const cancelled = forcedCancelEvents(harness)
    expect(cancelled.length).toBe(2)
    expect(cancelled[0]?.event).toMatchObject({ type: 'run.cancelled', forced: true })
  })

  it('SIGTERM 免疫的 Runtime 被 SIGKILL 升级收尾（5s 宽限注入为 60ms）', async () => {
    const { driver, pids } = makeRealProcessDriver({ sigtermImmune: true })
    const harness = await makeResilienceHarness({
      driverOverride: driver,
      cancelConfirmMs: 60,
      cancelTermGraceMs: 60,
    })
    cleanupFns.push(harness.cleanup)
    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    const pid = pids[0]
    expect(pid).toBeGreaterThan(0)
    await harness.manager.handleFrame(cancelFrame())

    expect(await awaitDead(pid, 10_000)).toBe(true)
    const deadline = Date.now() + 5_000
    for (;;) {
      if (forcedCancelEvents(harness).length > 0) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const cancelled = forcedCancelEvents(harness)
    expect(cancelled.length).toBe(2)
    expect(cancelled[0]?.event).toMatchObject({ forced: true })
    // SIGKILL 路径必须真的被走到（进程对 SIGTERM 免疫，只有 SIGKILL 能解释死亡）。
    expect(
      harness.logs.some(
        (log) => log.component === 'node.supervisor' && log.msg.includes('sigkill'),
      ),
    ).toBe(true)
  })
})
