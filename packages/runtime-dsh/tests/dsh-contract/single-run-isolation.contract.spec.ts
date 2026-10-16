/**
 * 探针：单 Run 隔离（#289）——一个 Runtime 子进程只服务一个 Run。
 *
 * 判定基线（负向优先 + 正控）：
 * - 负向：把**别的 Run** 的 `run.prompt` / `run.cancel` / `approval.decide` 喂进本桥
 *   必须被显式拒（fail-closed，不是静默丢弃），且零副作用——不起本 Run 的 turn、
 *   不产生会话事件、不结算、不取消；
 * - 正控：拒绝之后本桥**仍然可用**——本 Run 自己的指令照常起 turn 并收敛
 *   （拒绝不得把桥弄成半死状态）。
 *
 * 这条负向在本 PR 之前是**红的**：桥的 handleCommand 不比对命令里的 runId，
 * 跨 Run 的指令会被当成本 Run 的指令执行（同一子进程里跑另一个 Run 的话）。
 */
import { randomUUID } from 'node:crypto'
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

describe('probe: single-run isolation (#289)', () => {
  it('别的 Run 的 run.prompt → 拒绝且零副作用；本 Run 的指令照常起 turn 并收敛（正控）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')

      const foreignRunId = randomUUID()
      await expect(
        runtime.send(
          commandFrame('run.prompt', { runId: foreignRunId, text: 'foreign instruction' }),
        ),
      ).rejects.toThrow(/different run/)

      // 零副作用：跨 Run 的指令绝不许在本 Run 的会话里执行。
      expect(sessionEventTypes(runtime.outputs)).toEqual([])
      expect(runtime.outputs.some((frame) => frame.type === 'run.completed')).toBe(false)

      // 正控：桥仍可用——本 Run 自己的指令照常被受理、起 turn、收敛。
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
      expect(sessionEventTypes(runtime.outputs)).toContain('turn/start')
    } finally {
      await runtime.dispose()
    }
  })

  it('别的 Run 的 run.cancel → 拒绝，本 Run 不被取消；本 Run 自己的取消照常（正控）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hang please' }))
      await runtime.until('agent.status', (frame) => frame.payload.status === 'running')

      await expect(
        runtime.send(commandFrame('run.cancel', { runId: randomUUID(), cause: 'parent' })),
      ).rejects.toThrow(/different run/)
      // 跨 Run 的取消没有生效：turn 还在跑，没有 run.cancelled。
      expect(runtime.outputs.some((frame) => frame.type === 'run.cancelled')).toBe(false)

      // 正控：本 Run 自己的取消照常收敛。
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))
      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
    } finally {
      await runtime.dispose()
    }
  })

  it('别的 Run 的 approval.decide → 同样过闸（拒绝是唯一可观察面：未知 callId 本是 no-op）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('tool-approval', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'use the tool' }))
      await runtime.until('approval.requested')

      await expect(
        runtime.send(
          commandFrame('approval.decide', {
            runId: randomUUID(),
            callId: 'call-does-not-matter',
            decision: 'allowed_once',
          }),
        ),
      ).rejects.toThrow(/different run/)

      // 正控：本 Run 自己的决定照常被受理（悬置的审批被答复后 turn 收敛）。
      const pending = runtime.outputs.find((frame) => frame.type === 'approval.requested')
      const callId = (pending?.payload as { callId: string }).callId
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId,
          decision: 'allowed_once',
        }),
      )
      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
    } finally {
      await runtime.dispose()
    }
  })
})
