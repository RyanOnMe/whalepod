/**
 * 探针：事件流范围（#289）——越界事件不许出范围。
 *
 * 判定基线（负向 + 正控 + 屏障）：
 * - 负向 ①（会话面）：总线上出现的**异会话**事件必须被丢弃——不得转发成
 *   session.event 帧，更不得当成本 Run 的 turn 结算（`deliverSessionEvent` 的
 *   会话过滤是第一道闸）；
 * - 负向 ②（agent 面）：**异 agent** 的 status 不得以本 Run 的 runId 成帧
 *   （`deliverAgentStatus` 的 agent 过滤）——注入点在 ready 时刻同步落定，
 *   而此刻帧流里还没有任何 agent.status（实测基线），所以"注入后仍为零帧"
 *   就是真屏障，不是赌时序；
 * - 正控：本 Run 自己的事件照常转发（过滤是选择性的，不是把所有事件都丢光）、
 *   自己的 running → idle 状态照常成帧、run 照常收敛且**恰好**一次 run.completed。
 *
 * 注入方式：`probeAfterReady`（探针专用接缝，口径同 `probeResumeSessionId`）在
 * ready 之后交出**直送生产订阅处理器**的面（`RuntimeProbeFace`），注入点即订阅面
 * 本身。不用 DSH 插件发射：DSH 的 session/event 按会话上下文限定受众，兄弟子树的
 * 插件发不到桥的订阅点（三种发射形态哨兵实测全不达），那样负向会变成空断言。
 *
 * 可红性（变异自证，实测）：把 `session-owner.ts` 里
 * `if (String(eventSession.id) !== String(this.session.id)) return` 或
 * `if (payload.agent !== this.agent) return` 注释掉，本探针必红（异会话 turn/end
 * 触发提前/重复 run.completed 或 `runtime.fatal`；异 agent 的 idle 在 ready
 * 时刻就成帧）。
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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
  it('异会话事件不转发、不结算；异 agent 状态不成帧；本 Run 的事件与状态照常（正控）', async () => {
    const injected: string[] = []
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec, {
      probeAfterReady: (probe) => {
        // 异会话 turn/end：reason kind 选正常路径不产生的 `max-tokens`——若它漏进结算，
        // bridge 的 default 分支会发 `runtime.fatal` 并在 summary 里点名该 kind，
        // 泄漏因此有唯一指纹，不依赖计数。
        probe.deliverSessionEvent(
          { id: 'foreign-session' } as unknown as Session,
          {
            type: 'turn/end',
            data: { reason: { kind: 'max-tokens' } },
          } as unknown as SessionEvent,
        )
        probe.deliverSessionEvent(
          { id: 'foreign-session' } as unknown as Session,
          {
            type: 'foreign/probe',
            data: { marker: 'foreign-session-event' },
          } as unknown as SessionEvent,
        )
        probe.deliverAgentStatus({ agent: {} as unknown as Agent, status: 'idle' })
        injected.push('emitted')
      },
    })
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      // 控制变量：越界事件/状态确实注入过（否则下面的「没有越界痕迹」是空断言）。
      expect(injected).toEqual(['emitted'])
      // 负向 ② 当场判：注入是同步的（probeAfterReady 在 start 内 ready 之后同步跑完），
      // 而 ready 时刻本 Run 尚未起 turn——此处出现任何 agent.status 都只能是异 agent 漏出。
      expect(runtime.outputs.filter((frame) => frame.type === 'agent.status')).toHaveLength(0)

      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      const completed = await runtime.until('run.completed')

      // 正控：本 Run 自己的事件照常转发、status running→idle 照常成帧；结算恰好一次、在本 Run 名下。
      const types = sessionEventTypes(runtime.outputs)
      expect(types).toContain('turn/start')
      expect(types).toContain('assistant/message')
      expect(runtime.outputs.filter((frame) => frame.type === 'run.completed')).toHaveLength(1)
      expect(completed.payload.runId).toBe(spec.runId)
      const statuses = runtime.outputs
        .filter((frame) => frame.type === 'agent.status')
        .map((frame) => frame.payload.status)
      expect(statuses).toEqual(expect.arrayContaining(['running', 'idle']))

      // 负向 ①：异会话的自定义事件绝不出现在帧流里。
      expect(types).not.toContain('foreign/probe')
      // 越界的 turn/end 没有被当成本 Run 的结算：没有 fatal（泄漏的唯一指纹是
      // `unhandled reason kind: max-tokens`）、没有提前的 run.completed（本 Run 那条
      // 必须排在最早的 turn/start 之后）、turn/end 恰好一条。
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
