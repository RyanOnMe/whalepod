/**
 * 探针 2/3/7/8 —— agents.create、agent.followup、agent.cancel、agent.whenIdle
 * （02 Task 11 Step 7）：Agent 生命周期契约。
 */
import { describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'
import type { RuntimeOutput } from '@project311/protocol'

/** 从 session.event 帧里取 DSH SessionEvent（unknown 载荷，探针内收窄）。 */
function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

describe('probe: agent lifecycle (create / followup / whenIdle)', () => {
  it('creates an agent, drives one followup turn to idle, and completes the run', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      // create 契约：ready 帧携带本次 Run 的 dshSessionId。
      const ready = await runtime.until('runtime.ready')
      expect(typeof ready.payload.dshSessionId).toBe('string')

      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))

      // whenIdle 契约：turn 收敛后 bridge 在 idle+flush 之后发 run.completed（03 §7.2）。
      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
      expect(completed.payload.dshSessionId).toBe(ready.payload.dshSessionId)

      // followup 契约：replay fixture 的 assistant 文本出现在 session.event 透传里。
      const assistant = sessionEventsOf(runtime.outputs).find((e) => e.type === 'assistant/message')
      expect(assistant).toBeDefined()
      const text = JSON.stringify(assistant?.data)
      expect(text).toContain('Hello from replay.')

      // agent.status 契约：running → idle 迁移成帧。
      const statuses = runtime.outputs.filter((frame) => frame.type === 'agent.status')
      expect(statuses.map((frame) => frame.payload.status)).toEqual(
        expect.arrayContaining(['running', 'idle']),
      )
      expect(statuses.at(-1)?.payload.status).toBe('idle')
    } finally {
      await runtime.dispose()
    }
  })

  it('cancels a hung turn mid-stream and converges to idle', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hang please' }))

      // 等到 turn 真的在跑（hang fixture 的前缀 chunk 已送达）再取消。
      await runtime.until('agent.status', (frame) => frame.payload.status === 'running')
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)

      const turnEnd = sessionEventsOf(runtime.outputs).find((e) => e.type === 'turn/end')
      expect(JSON.stringify(turnEnd?.data)).toContain('"aborted"')

      const idle = await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      expect(idle.payload.runId).toBe(spec.runId)
      // 取消后不得再出现 run.completed。
      expect(runtime.outputs.some((frame) => frame.type === 'run.completed')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
