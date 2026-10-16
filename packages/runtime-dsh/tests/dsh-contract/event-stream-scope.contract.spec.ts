/**
 * 探针：事件流范围（#289）——越界事件不许出范围。
 *
 * 判定基线（负向 + 正控）：
 * - 负向：总线上出现的**异会话**事件必须被丢弃——不得转发成 session.event 帧，
 *   更不得当成本 Run 的 turn 结算（`session-owner.subscribe()` 的会话过滤是第一道闸）；
 * - 正控：本 Run 自己的事件照常转发（过滤是选择性的，不是把所有事件都丢光），
 *   run 照常收敛，且**恰好**一次 run.completed。
 *
 * 注入方式：`probeAfterReady`（探针专用接缝，字号同 `probeResumeSessionId`）在
 * ready 之后交出**绑在桥自己 ctx 上**的发射器，从桥的订阅面内部注入异会话事件。
 * 不用 DSH 插件发射：DSH 的 session/event 按会话上下文限定受众，兄弟子树的插件
 * 发不到桥的订阅点（三种发射形态哨兵实测全不达），那样负向会变成空断言。
 *
 * 可红性（变异自证，实测）：把 `session-owner.ts` 的
 * `if (String(eventSession.id) !== sessionId) return` 注释掉，本探针必红
 * （异会话 turn/end 触发本 Run 提前/重复 run.completed）。
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

describe('probe: event stream scope (#289)', () => {
  it('异会话事件不转发、不结算；本 Run 的事件照常（正控）', async () => {
    const injected: string[] = []
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec, {
      probeAfterReady: (emit) => {
        emit(
          { id: 'foreign-session' },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
        emit(
          { id: 'foreign-session' },
          { type: 'foreign/probe', data: { marker: 'foreign-session-event' } },
        )
        injected.push('emitted')
      },
    })
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      // 先控制变量：越界事件确实注入过（否则下面的「没有越界痕迹」是空断言）。
      expect(injected).toEqual(['emitted'])

      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      const completed = await runtime.until('run.completed')

      // 正控：本 Run 自己的事件照常转发；结算恰好一次、发生在本 Run 名下。
      const types = sessionEventTypes(runtime.outputs)
      expect(types).toContain('turn/start')
      expect(types).toContain('assistant/message')
      expect(runtime.outputs.filter((frame) => frame.type === 'run.completed')).toHaveLength(1)
      expect(completed.payload.runId).toBe(spec.runId)

      // 负向 ①：异会话的自定义事件绝不出现在帧流里。
      expect(types).not.toContain('foreign/probe')
      // 负向 ②：异会话的 turn/end 没有被当成本 Run 的结算——没有 fatal，也没有提前的
      // run.completed（本 Run 那条必须排在最早的 turn/start 之后），turn/end 恰好一条。
      expect(runtime.outputs.some((frame) => frame.type === 'runtime.fatal')).toBe(false)
      const turnStartIndex = runtime.outputs.findIndex(
        (frame) =>
          frame.type === 'session.event' &&
          (frame.payload.event as { type: string }).type === 'turn/start',
      )
      const completedIndex = runtime.outputs.findIndex((frame) => frame.type === 'run.completed')
      expect(completedIndex).toBeGreaterThan(turnStartIndex)
      expect(types.filter((type) => type === 'turn/end')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })
})
