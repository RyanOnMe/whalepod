/**
 * 探针 —— cancel 竞态与 followup 中断边界（#353，Q3 契约门）。
 *
 * 断链背景：`agent-control.contract.spec.ts` 的取消判据是**单点时序**——它在
 * `run.cancelled` 到达的同一瞬间断言「无 run.completed」，既没有收敛屏障（迟到的
 * 第二串 turn/结算不会被等出来），也没有覆盖「取消与 turn 收尾同时发生」这个交错；
 * 而 turn 被中断时**已在途的 followup** 在契约门里零判据（Hub 的
 * `instruction-queue` 判的是队列语义，不是运行时边界）。
 *
 * 本文件钉三条（全部走与 Node 相同的命令入口；负向优先、两处带正控）：
 * 1. 取消落在流式中间（hang 前缀已出）：等**内容帧**再取消（不赌 `agent.status`），
 *    收敛屏障后再清总账——不许有迟到结算、不许有第二串 turn；
 * 2. **取消与收尾撞车**：turn/end 已提交、settle 还在途时送 cancel——结果必须唯一：
 *    completed 成立、不得再出 run.cancelled/runtime.fatal，且这次取消不得毒化会话
 *    （随后的 followup 照常起第二个 turn：正控）；
 * 3. **中断边界的 followup**：turn 运行中追加入队的一条 followup，取消即中止——
 *    它不得被执行（第二条 turn 若真开跑，replay 脚本耗尽会硬失败成 runtime.fatal，
 *    这里把它断言成「零第二串 turn/零 fatal」），与 ADR-0009 决策 5（首个终态帧
 *    finalize；在途追问落 rejected）的产品口径一致。
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'

/** 从 session.event 帧里取 DSH SessionEvent（unknown 载荷，探针内收窄）。 */
function sessionEventsOf(
  outputs: readonly RuntimeOutput[],
): { type: string; data?: unknown; reason?: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data?: unknown; reason?: unknown })
}

/** 收窄 session.event 的载荷（协议里是 unknown；探针内自己钉形状）。 */
function eventOf(frame: Extract<RuntimeOutput, { type: 'session.event' }>): {
  type: string
  data?: unknown
  reason?: unknown
} {
  return frame.payload.event as { type: string; data?: unknown; reason?: unknown }
}

function countOf(outputs: readonly RuntimeOutput[], type: RuntimeOutput['type']): number {
  return outputs.filter((frame) => frame.type === type).length
}

function assertSingleAbortedTurn(runtime: ProbeRuntime): void {
  const events = sessionEventsOf(runtime.outputs)
  const starts = events.filter((event) => event.type === 'turn/start')
  const ends = events.filter((event) => event.type === 'turn/end')
  expect(starts, '取消后不得有第二串 turn/start').toHaveLength(1)
  expect(ends, '取消后不得有第二串 turn/end').toHaveLength(1)
  expect(JSON.stringify(ends[0]), 'turn/end 的归因必须是 aborted').toContain('"aborted"')
}

/** 等同类第 n 帧出现（`until` 只认首个匹配帧；第 n 帧只能按数量有界等）。 */
async function waitForCount(
  runtime: { readonly outputs: readonly RuntimeOutput[] },
  type: RuntimeOutput['type'],
  n: number,
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (countOf(runtime.outputs, type) >= n) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`probe: timed out waiting for ${n}× ${type}`)
}

/**
 * 静默窗（有界）：收敛信号（终态帧/idle）之后的**迟到第二串**只有在窗口内现形。
 * 它不是时序依赖——一切等待都由内容帧/收敛帧决定；窗口只负责把「迟到的多出来
 * 的帧」等出来（同族先例：single-run-isolation 的 waitForCount 屏障）。
 */
async function quietWindow(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('probe: cancel race & followup at the interrupt boundary (#353)', () => {
  it('取消落在流式中间：等 hang 前缀内容帧再取消，收敛后总账唯一（无迟到结算/无第二串 turn）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hang please' }))

      // 同步点用**内容帧**：hang 前缀的 text-delta 出现 = 模型流已在挂起（比
      // `agent.status: running` 强——那时流可能还没进入挂起点）。
      await runtime.until(
        'session.event',
        (frame) =>
          eventOf(frame).type === 'assistant/chunk' &&
          JSON.stringify(eventOf(frame)).includes('partial'),
      )
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
      // 收敛屏障：idle 状态帧出现才算这次中断结算完毕。
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      await quietWindow()

      assertSingleAbortedTurn(runtime)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(1)
      expect(countOf(runtime.outputs, 'run.completed'), '取消后不得再出 run.completed').toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('取消与收尾撞车（turn/end 已提交、settle 在途）：completed 成立、不得再出 cancelled，且取消不毒化会话（正控）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))

      // 撞车点：turn/end 已出（收尾已提交），settle 链（await whenIdle + flush）
      // 必在飞——此刻送 cancel。窗口由构造保证（本帧到 settle 完成之间至少一次 await），
      // 不靠 sleep 凑。
      await runtime.until(
        'session.event',
        (frame) =>
          eventOf(frame).type === 'turn/end' &&
          JSON.stringify(eventOf(frame)).includes('"completed"'),
      )
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      await quietWindow()

      // 结果唯一：已完成的那一轮成立，取消**不得**补出一条 run.cancelled，
      // 也不得把会话打成 fatal（协议没有「取消无回执」的帧，唯一允许的形态是沉默）。
      const events = sessionEventsOf(runtime.outputs)
      expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
      expect(JSON.stringify(events.find((event) => event.type === 'turn/end'))).toContain(
        '"completed"',
      )
      expect(countOf(runtime.outputs, 'run.completed')).toBe(1)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)

      // 正控：这次取消不得毒化会话——随后的 followup 照常起第二个 turn 并收敛
      // （vendor 口径「idle 时的取消是 no-op、不给后续工作上闩」）。若某天 cancel
      // 变成「armed」，这里会红。
      await runtime.send(commandFrame('run.followup', { runId: spec.runId, text: 'second' }))
      await runtime.until('session.event', (frame) =>
        JSON.stringify(frame.payload.event).includes('Second turn answer.'),
      )
      await waitForCount(runtime, 'run.completed', 2)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(2)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('中断边界：运行中入队的 followup 被取消吞掉——零第二串 turn、零 fatal、文本零出线', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hang please' }))
      await runtime.until(
        'session.event',
        (frame) =>
          eventOf(frame).type === 'assistant/chunk' &&
          JSON.stringify(eventOf(frame)).includes('partial'),
      )

      // 中断前入队一条 followup（send 返回 = 命令已派发进 bridge，vendor 侧已入队）。
      await runtime.send(
        commandFrame('run.followup', { runId: spec.runId, text: 'followup must not survive' }),
      )
      // 入队语义判据：followup 必须进 `next-turn`（下一个 turn 的追问），不是插进
      // 当前步的 `next-step`（那是 steer/插话的语义，03 §7）。实现若把 followup
      // 改成 steer，本断言红（而「无人值守的执行者被中途插话」正是要拦的形态）。
      const spliced = sessionEventsOf(runtime.outputs).filter(
        (event) => event.type === 'agent/inbox/spliced',
      )
      expect(
        spliced.some(
          (event) =>
            (event.data as { target?: string }).target === 'next-turn' &&
            JSON.stringify(event.data).includes('followup must not survive'),
        ),
        'followup 必须以 next-turn 入队（带指令原文的 spliced 事件）',
      ).toBe(true)
      expect(
        spliced.every((event) => (event.data as { target?: string }).target !== 'next-step'),
        'followup 不得以 next-step（steer/插话）语义进当前步',
      ).toBe(true)
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      await quietWindow()

      // 在途 followup 不得被执行：第二串 turn 一个都不能有。若实现改成「取消后仍
      // 跑排队项」，第二 turn 会启动 —— 本 fixture 只有一个脚本条目，replay 会以
      // `script exhausted` 硬失败成 runtime.fatal，下面三条断言都会红。
      assertSingleAbortedTurn(runtime)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(1)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)
      // 注：**入队回执**（agent/inbox/spliced 里带指令原文）是合法的会话事件，
      // 这里不做文本级断言——「未被受理执行的第二条指令」在帧面的形态就是
      // 「没有第二串 turn」（上一条断言）。
    } finally {
      await runtime.dispose()
    }
  })
})
