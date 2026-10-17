/**
 * 探针 —— 收尾交接草稿的四态（#379；ADR-0017 §3）。
 *
 * 判据（全走 Node 相同的命令入口；replay 无密钥）：
 * 1. **正常完成**：turn 正常结束 → 收尾一次性调用（replay 脚本追加条目）→
 *    `handoff.draft{status:'generated'}` 且叙述通过协议 schema，**先于** `run.completed`；
 * 2. **超时**：收尾脚本 hang + 环境变量收窄超时 → `handoff.draft{status:'failed', reason:'timeout'}`，
 *    业务终态 `run.completed` 照发（整理失败不改变执行结果）；
 * 3. **未启用**（spec 不携带 handoff）：不调用模型、零 handoff.draft 帧
 *    （脚本里预备的追加条目若被消费就会出现 generated 帧——用它当负向判据）；
 * 4. **取消/中断**：turn 被中断（aborted）→ 不调用模型、零 handoff.draft 帧、
 *    终态唯一（run.cancelled）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

const TIMEOUT_ENV = 'WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS'
const AGREEMENT = {
  revisionNumber: 1,
  goal: '交付登录接口',
  constraints: '不引入新依赖',
  acceptance: '全部用例通过',
  openQuestions: '',
}

const previousTimeout = process.env[TIMEOUT_ENV]
afterEach(() => {
  if (previousTimeout === undefined) delete process.env[TIMEOUT_ENV]
  else process.env[TIMEOUT_ENV] = previousTimeout
})

function frameTypes(outputs: readonly RuntimeOutput[]): string[] {
  return outputs.map((frame) => frame.type)
}

describe('#379 收尾交接草稿（replay 契约探针）', () => {
  it('正常完成：生成草稿（叙述过 schema）并且先于 run.completed', async () => {
    const spec = runtimeSpec({ handoff: { agreement: AGREEMENT } })
    const runtime = await startReplayRuntime('handoff', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: '实现登录接口' }))
      const completed = await runtime.until('run.completed')
      expect(completed.payload.dshSessionId).toBeDefined()

      const draft = await runtime.until('handoff.draft')
      expect(draft.payload.status).toBe('generated')
      if (draft.payload.status !== 'generated') throw new Error('unreachable')
      expect(draft.payload.content?.completed[0]?.text).toBe('登录接口与用例已实现')
      expect(draft.payload.content?.evidence[0]?.refs).toHaveLength(1)
      expect(draft.payload.content?.commits).toEqual(['0f1e2d3'])
      // 全部条目默认「待核实」。
      const items = [
        ...(draft.payload.content?.completed ?? []),
        ...(draft.payload.content?.evidence ?? []),
      ]
      expect(items.every((item) => item.verified === false)).toBe(true)

      // 帧序：草稿在终态之前（Node 先落草稿事实、再收终态）。
      const types = frameTypes(runtime.outputs)
      expect(types.indexOf('handoff.draft')).toBeGreaterThan(-1)
      expect(types.indexOf('handoff.draft')).toBeLessThan(types.indexOf('run.completed'))
      // 只尝试一次：整个生命周期恰一帧草稿。
      expect(types.filter((type) => type === 'handoff.draft')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('超时：failed(timeout) 且 run.completed 照发（不改业务结果）', async () => {
    process.env[TIMEOUT_ENV] = '300'
    const spec = runtimeSpec({ handoff: { agreement: AGREEMENT } })
    // 第一轮照常完成，收尾调用命中 hang 条目 → 300ms 超时。
    const runtime = await startReplayRuntime('handoff-hang', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: '实现登录接口' }))
      const draft = await runtime.until('handoff.draft')
      expect(draft.payload.status).toBe('failed')
      if (draft.payload.status !== 'failed') throw new Error('unreachable')
      expect(draft.payload.reason).toBe('timeout')
      const types = frameTypes(runtime.outputs)
      expect(types.indexOf('handoff.draft')).toBeLessThan(types.indexOf('run.completed'))
    } finally {
      await runtime.dispose()
    }
  })

  it('未启用（spec 无 handoff）：不调用模型、零草稿帧', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('handoff', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: '实现登录接口' }))
      await runtime.until('run.completed')
      expect(frameTypes(runtime.outputs)).not.toContain('handoff.draft')
    } finally {
      await runtime.dispose()
    }
  })

  it('取消/中断：aborted 不触发整理，零草稿帧、终态唯一', async () => {
    const spec = runtimeSpec({ handoff: { agreement: AGREEMENT } })
    // cancel 场景：脚本整体替换为 hang——首个模型调用挂起，取消即中断。
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: '实现登录接口' }))
      await runtime.until('agent.status', (frame) => frame.payload.status === 'running')
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))
      await runtime.until('run.cancelled')
      await new Promise((resolve) => setTimeout(resolve, 200))
      const types = frameTypes(runtime.outputs)
      expect(types).not.toContain('handoff.draft')
      expect(types.filter((type) => type === 'run.cancelled')).toHaveLength(1)
      expect(types).not.toContain('run.completed')
    } finally {
      await runtime.dispose()
    }
  })
})
