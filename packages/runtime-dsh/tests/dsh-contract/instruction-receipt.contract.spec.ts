/**
 * 探针：指令回执（#289）——命令不许被静默吞掉。
 *
 * 判定基线：
 * - 未 initialize 就来的命令（prompt / cancel）→ **显式拒** + 零帧（不伪造回执、
 *   不半初始化）；重复 initialize 同样显式拒（不得静默重启/复用）；
 * - 受理的 `run.prompt` 必须留下**可观察回执**：本 Run 的 `turn/start` 先出现，
 *   结算（`run.completed`）后到——两者都不允许缺席。
 *
 * 「指令回执」在 Hub 层（instruction_state 结算）与 Node 单测已有覆盖，本探针是
 * Q3 契约门内的那半边（Runtime 边界）。
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

function sessionEventTypes(outputs: readonly RuntimeOutput[]): string[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => (frame.payload.event as { type: string }).type)
}

describe('probe: instruction receipt (#289)', () => {
  it('initialize 之前的命令 → 显式拒且零帧（不静默吞、不伪造回执）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await expect(
        runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'too early' })),
      ).rejects.toThrow(/before runtime\.initialize/)
      await expect(
        runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' })),
      ).rejects.toThrow(/before runtime\.initialize/)
      // 零帧：拒绝不产生任何输出，也不改变进程状态（随后的 initialize 照常可用）。
      expect(runtime.outputs).toHaveLength(0)

      await runtime.send(initializeCommand(spec))
      const ready = await runtime.until('runtime.ready')
      expect(ready.payload.runId).toBe(spec.runId)
    } finally {
      await runtime.dispose()
    }
  })

  it('重复 initialize → 显式拒（不得静默重启或换会话）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await expect(runtime.send(initializeCommand(spec))).rejects.toThrow(
        /duplicate runtime\.initialize/,
      )
      // 零副作用：没有第二个 ready（不重启 boot），也没有任何会话事件（不换会话、
      // 不预起 turn）。ready 帧数与时序在下面一并清点。
      const readies = runtime.outputs.filter((frame) => frame.type === 'runtime.ready')
      expect(readies).toHaveLength(1)
      expect(readies[0]?.payload.runId).toBe(spec.runId)
      expect(sessionEventTypes(runtime.outputs)).toEqual([])
      expect(runtime.outputs.filter((frame) => frame.type === 'run.completed')).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('受理的 run.prompt：回执（turn/start）先到、结算（run.completed）后到，且都钉在本 Run', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      const ready = await runtime.until('runtime.ready')

      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
      expect(completed.payload.dshSessionId).toBe(
        (ready.payload as { dshSessionId: string }).dshSessionId,
      )

      const types = sessionEventTypes(runtime.outputs)
      const turnStart = types.indexOf('turn/start')
      const turnEnd = types.indexOf('turn/end')
      const completedIndex = runtime.outputs.findIndex((frame) => frame.type === 'run.completed')
      const turnStartIndex = runtime.outputs.findIndex(
        (frame) =>
          frame.type === 'session.event' &&
          (frame.payload.event as { type: string }).type === 'turn/start',
      )
      expect(turnStart).toBeGreaterThanOrEqual(0) // 回执在
      expect(turnEnd).toBeGreaterThan(turnStart) // 顺序：turn 有头有尾
      expect(completedIndex).toBeGreaterThan(turnStartIndex) // 结算在回执之后
    } finally {
      await runtime.dispose()
    }
  })
})
