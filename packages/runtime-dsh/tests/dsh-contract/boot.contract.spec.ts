/**
 * 探针 1 —— boot（02 Task 11 Step 7）：钉住的 DSH 组合能启动并给出稳定的
 * bridge 事件（runtime.ready 为 initialize 的第一帧应答，dshSessionId 稳定）。
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
    const payload = ready.payload as { dshSessionId: string }
    expect(typeof payload.dshSessionId).toBe('string')
    expect(payload.dshSessionId.length).toBeGreaterThan(0)
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
