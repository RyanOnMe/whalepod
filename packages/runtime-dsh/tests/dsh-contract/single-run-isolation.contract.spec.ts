/**
 * 探针：单 Run 隔离（#289）——一个 Runtime 子进程只服务一个 Run。
 *
 * 判定基线（负向优先 + 正控）：
 * - 负向：把**别的 Run** 的 `run.prompt` / `run.followup` / `run.cancel` /
 *   `approval.decide` / `runtime.shutdown` 喂进本桥必须被显式拒（fail-closed，
 *   不是静默丢弃），且零副作用——不起本 Run 的 turn、不产生会话事件、不结算、
 *   不取消、不收敛本进程；
 * - 正控：拒绝之后本桥**仍然可用**——本 Run 自己的指令照常起 turn 并收敛
 *   （拒绝不得把桥弄成半死状态），本 Run 自己的 shutdown 照常收敛。
 * - 屏障：零副作用不只查拒绝时刻的帧流（那里异步帧还没产出，"先执行后拒绝"型
 *   退化会漏过），每个用例都让本 Run 的正控先收敛/收尾，再清点总账（turn 数、
 *   结算数、越界文本有无）。
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

function countOf(outputs: readonly RuntimeOutput[], type: RuntimeOutput['type']): number {
  return outputs.filter((frame) => frame.type === type).length
}

/**
 * 等同类第 `n` 帧出现（`until` 只认首个匹配帧；第 n 帧只能按数量有界等）。
 * 屏障用：跨 Run 指令若被"先执行后抛错"，多出来的 turn/结算会在这里被等出来。
 */
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

      // 零副作用（拒绝时刻）：立即帧流里没有跨 Run 指令的痕迹。
      expect(sessionEventTypes(runtime.outputs)).toEqual([])
      expect(countOf(runtime.outputs, 'run.completed')).toBe(0)

      // 正控：桥仍可用——本 Run 自己的指令照常被受理、起 turn、收敛。
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
      expect(sessionEventTypes(runtime.outputs)).toContain('turn/start')

      // 屏障（收敛后清总账）：跨 Run 的指令若被"先执行后抛错"，到此必有第二串 turn
      // 或那段文本；只拒一次是不够的。
      const types = sessionEventTypes(runtime.outputs)
      expect(types.filter((type) => type === 'turn/start')).toHaveLength(1)
      expect(types.filter((type) => type === 'turn/end')).toHaveLength(1)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(1)
      expect(JSON.stringify(runtime.outputs)).not.toContain('foreign instruction')
    } finally {
      await runtime.dispose()
    }
  })

  it('别的 Run 的 run.followup → 拒绝；本 Run 的 followup 照常起第二个 turn（正控）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'first' }))
      await runtime.until('run.completed')

      await expect(
        runtime.send(
          commandFrame('run.followup', { runId: randomUUID(), text: 'foreign followup' }),
        ),
      ).rejects.toThrow(/different run/)

      // 正控 + 屏障：本 Run 的 followup 起第二个 turn 并收敛（replay 第二轮的
      // assistant 文本作数据依赖屏障，不赌时序）；跨 Run 的那条若被执行，这里必是
      // 第三个 turn 或出现 foreign 文本。
      await runtime.send(commandFrame('run.followup', { runId: spec.runId, text: 'second' }))
      await runtime.until('session.event', (frame) =>
        JSON.stringify(frame.payload.event).includes('Second turn answer.'),
      )
      await waitForCount(runtime, 'run.completed', 2)

      const types = sessionEventTypes(runtime.outputs)
      expect(types.filter((type) => type === 'turn/start')).toHaveLength(2)
      expect(types.filter((type) => type === 'turn/end')).toHaveLength(2)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(2)
      expect(JSON.stringify(runtime.outputs)).not.toContain('foreign followup')
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
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(0)

      // 正控：本 Run 自己的取消照常收敛。
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))
      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
      // 屏障：取消只会结算一次，跨 Run 的那条若生效会再来一个 run.cancelled。
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(1)
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
      expect(countOf(runtime.outputs, 'run.completed')).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('别的 Run 的 runtime.shutdown → 拒绝且本进程未被收敛；本 Run 的 shutdown 照常（正控）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')

      await expect(
        runtime.send(commandFrame('runtime.shutdown', { runId: randomUUID() })),
      ).rejects.toThrow(/different run/)

      // 正控 ①：跨 Run 的 shutdown 没拆掉本进程——本 Run 的指令照常起 turn 并收敛。
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      await runtime.until('run.completed')

      // 正控 ②：本 Run 自己的 shutdown 照常收敛；收敛之后命令一律显式拒（不得静默吞）。
      await runtime.send(commandFrame('runtime.shutdown', { runId: spec.runId }))
      await expect(
        runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'after shutdown' })),
      ).rejects.toThrow(/after runtime shutdown/)
    } finally {
      await runtime.dispose()
    }
  })
})
