/**
 * 探针 1 —— boot（02 Task 11 Step 7）：钉住的 DSH 组合能启动并给出稳定的
 * bridge 事件（runtime.ready 为 initialize 的第一帧应答，dshSessionId 稳定）。
 *
 * #288：ready 帧同时回报本 Run 装载的 `profileDigest`——Node 侧据此与固化的
 * Revision digest 比对（对照点在收到方，不在 Hub 领域模型里）。判据：回声必须
 * 逐字节等于 initialize 携带的值（换一个 digest 也照样回声，不是常量）。
 */
import { describe, expect, it } from 'vitest'
import {
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'

describe('probe: boot', () => {
  let runtime: ProbeRuntime | undefined

  it('boots a DSH agent and emits stable bridge events', async () => {
    const spec = runtimeSpec()
    runtime = await startReplayRuntime('basic', spec)
    await runtime.send(initializeCommand(spec))
    const ready = await runtime.next()
    expect(ready).toMatchObject({
      type: 'runtime.ready',
      payload: { runId: spec.runId },
    })
    const payload = ready.payload as { dshSessionId: string; profileDigest: string }
    expect(typeof payload.dshSessionId).toBe('string')
    expect(payload.dshSessionId.length).toBeGreaterThan(0)
    // 回声（#288）：等于本次 initialize 携带的 digest，而不是别的 Run/常量。
    expect(payload.profileDigest).toBe(spec.profileDigest)
  })

  it('ready 回声跟随本 Run 的 digest（换值也如实回报）', { timeout: 60_000 }, async () => {
    const digest = 'c'.repeat(64)
    const spec = runtimeSpec({ profileDigest: digest })
    const probe = await startReplayRuntime('basic', spec)
    try {
      await probe.send(initializeCommand(spec))
      const ready = await probe.until('runtime.ready')
      expect((ready.payload as { profileDigest: string }).profileDigest).toBe(digest)
    } finally {
      await probe.dispose()
    }
  })

  it('boot leaves no frame before runtime.ready and no runtime.fatal', async () => {
    const ready = runtime?.outputs.find((frame) => frame.type === 'runtime.ready')
    expect(ready).toBeDefined()
    const readyIndex = runtime?.outputs.indexOf(ready ?? ({} as never))
    expect(readyIndex).toBe(0)
    expect(runtime?.outputs.some((frame) => frame.type === 'runtime.fatal')).toBe(false)
  })

  it('reported readiness: bridge logs runtime booted on the log channel', () => {
    expect(runtime?.logs.some((record) => record['msg'] === 'runtime booted')).toBe(true)
  })

  it('disposes cleanly', async () => {
    await runtime?.dispose()
    runtime = undefined
  })
})
