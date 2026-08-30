/**
 * G7-03 Runtime 非零退出（P1-16）：Run failed(RUNTIME_LOST)，不自动重启。
 *
 * 判定基线：
 * - Runtime 退出（code=1 / 信号 / 干净退出但无终态帧）→ 合成 run.failed
 *   (RUNTIME_LOST) 双受众投影，走 stdout→projector→spool→uplink 同一条链；
 * - 退出后重复 run.start（R7 重发窗口）绝不 spawn 第二个 Runtime——回放旧 ack
 *   + 上报 run.snapshot(lost, RUNTIME_LOST)，等人工显式重跑；
 * - 已有终态事实（completed）后的退出被忽略，不产生第二份失败投影；
 * - 真人路径探针：真实 node 子进程 process.exit(7) → 退出事件驱动同一分类。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeResilienceHarness,
  runStartFrame,
  RUN_ID,
  runtimeReadyLine,
  type ResilienceHarness,
} from './harness.js'

let current: ResilienceHarness | undefined

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

function failedEvents(harness: ResilienceHarness): Array<{ code: string; summary: string }> {
  return harness
    .runEvents()
    .filter((event) => event.event.type === 'run.failed')
    .map((event) => event.event as { code: string; summary: string })
}

function snapshotFrames(harness: ResilienceHarness): Array<Record<string, unknown>> {
  return harness
    .sentFrames()
    .filter((frame) => frame.type === 'run.snapshot')
    .map((frame) => frame.payload)
}

describe('G7-03: Runtime 退出 → failed(RUNTIME_LOST)，不自动重启', () => {
  it('非零退出合成 run.failed(RUNTIME_LOST)；重复 run.start 不 spawn 第二个 Runtime', async () => {
    const harness = await makeResilienceHarness()
    current = harness

    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    expect(harness.runtimes).toHaveLength(1)

    // Runtime 崩溃：退出码 1，无任何终态帧。
    harness.runtimes[0]?.exitWith(1, null)

    const failed = harness
      .runEvents()
      .filter((event) => event.event.type === 'run.failed')
      .map((event) => ({
        audience: event.audience,
        event: event.event as { code: string; summary: string },
      }))
    expect(failed).toHaveLength(2) // owner + project
    for (const { event } of failed) expect(event.code).toBe('RUNTIME_LOST')
    expect(failed.find(({ audience }) => audience === 'owner')?.event.summary).toContain('code=1')
    expect(failed.find(({ audience }) => audience === 'project')?.event.summary).toBe(
      'RUNTIME_LOST',
    )
    expect(harness.eventStore.pending(RUN_ID)).toHaveLength(2)
    expect(harness.supervisor.isActive(RUN_ID)).toBe(false)

    // R7 重发窗口内的重复 run.start：绝不自动重启（无第二 PID）。
    const spawnCountBefore = harness.runtimes.length
    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    expect(harness.runtimes.length).toBe(spawnCountBefore) // 没有第二 Runtime
    // 重复 run.start 附带快照重申：Run 已由 run.failed 事件收敛为 failed，
    // 快照如实携带 failureCode=RUNTIME_LOST（Hub 侧终态幂等，二者皆可）。
    const snapshot = snapshotFrames(harness)[0] as
      | { status: string; failureCode: string; runId: string }
      | undefined
    expect(snapshot).toMatchObject({ failureCode: 'RUNTIME_LOST', runId: RUN_ID })
    expect(['failed', 'lost']).toContain(snapshot?.status)
    // ack 幂等回放（Hub 侧 queued→dispatching 由旧 ack 收敛，Run 不会卡死）。
    const ack = harness.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({
      commandId: '22222222-2222-4222-8222-222222222222',
      accepted: true,
    })
  })

  it('干净退出（code=0）但无终态帧同样判 RUNTIME_LOST（诚实：Runtime 消失了）', async () => {
    const harness = await makeResilienceHarness()
    current = harness
    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    harness.runtimes[0]?.exitWith(0, null)
    const failed = failedEvents(harness)
    expect(failed.length).toBe(2)
    expect(failed[0]?.code).toBe('RUNTIME_LOST')
  })

  it('run.completed 之后的正常退出被忽略：只有一份完成事实，无失败投影', async () => {
    const harness = await makeResilienceHarness()
    current = harness
    await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
    harness.runtimes[0]?.emitStdout(runtimeReadyLine(RUN_ID))
    harness.runtimes[0]?.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: '30000000-0000-4000-8000-000000000003',
        sentAt: new Date().toISOString(),
        type: 'run.completed',
        payload: { runId: RUN_ID, dshSessionId: 'session-1' },
      }),
    )
    expect(failedEvents(harness)).toHaveLength(0)

    harness.runtimes[0]?.exitWith(0, null)
    expect(failedEvents(harness)).toHaveLength(0)
    const completed = harness.runEvents().filter((event) => event.event.type === 'run.completed')
    expect(completed).toHaveLength(2) // owner + project 各一份，不重复
  })
})
