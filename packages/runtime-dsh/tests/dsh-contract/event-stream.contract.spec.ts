/**
 * 探针 4 —— session.event 事件流（02 Task 11 Step 7）：透传帧的次序与关联
 * 契约（03 §7.2：runId + dshSessionId 关联，seq 单调，turn 边界有序）。
 */
import { describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

describe('probe: session event stream order', () => {
  it('forwards session events with monotonic seq and stable correlation ids', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      const ready = await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      await runtime.until('run.completed')

      const frames = runtime.outputs.filter((frame) => frame.type === 'session.event')
      expect(frames.length).toBeGreaterThan(0)

      // 关联契约：每帧都钉在本次 Run 的 runId + dshSessionId 上（03 §8）。
      for (const frame of frames) {
        expect(frame.payload.runId).toBe(spec.runId)
        expect(frame.payload.dshSessionId).toBe(ready.payload.dshSessionId)
      }

      // 次序契约：seq 严格递增。
      const seqs = frames.map((frame) => (frame.payload.event as { seq: number }).seq)
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1)
      }

      // turn 边界次序：turn/start < step/start < assistant/message < step/end < turn/end。
      const types = frames.map((frame) => (frame.payload.event as { type: string }).type)
      const indexOf = (type: string) => types.indexOf(type)
      expect(indexOf('turn/start')).toBeGreaterThanOrEqual(0)
      expect(indexOf('turn/start')).toBeLessThan(indexOf('step/start'))
      expect(indexOf('step/start')).toBeLessThan(indexOf('assistant/message'))
      expect(indexOf('assistant/message')).toBeLessThan(indexOf('step/end'))
      expect(indexOf('step/end')).toBeLessThan(indexOf('turn/end'))

      // run.completed 只在最终 turn/end 之后发出（03 §7.2：idle+flush 后再发完成事件）。
      const lastTurnEndOutputIndex = runtime.outputs.findLastIndex(
        (frame) =>
          frame.type === 'session.event' &&
          (frame.payload.event as { type: string }).type === 'turn/end',
      )
      const completedIndex = runtime.outputs.findIndex((frame) => frame.type === 'run.completed')
      expect(completedIndex).toBeGreaterThan(lastTurnEndOutputIndex)
    } finally {
      await runtime.dispose()
    }
  })
})
