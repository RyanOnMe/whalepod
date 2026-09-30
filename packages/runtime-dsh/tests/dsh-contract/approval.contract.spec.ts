/**
 * 探针 5/6 —— approval 拦截与 tools.register（02 Task 11 Step 7）：
 * Runtime 注册 publish_artifact 工具、对所有工具调用发起审批拦截，
 * approval.decide 的一次性决定控制工具是否执行（03 §7.1/§7.2）。
 */
import { describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'
import type { RuntimeOutput } from '@whalepod/protocol'

function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

async function driveToApproval(scenarioRuntime: Awaited<ReturnType<typeof startReplayRuntime>>) {
  const spec = scenarioRuntime.spec
  await scenarioRuntime.send(initializeCommand(spec))
  await scenarioRuntime.until('runtime.ready')
  await scenarioRuntime.send(
    commandFrame('run.prompt', { runId: spec.runId, text: 'publish the report' }),
  )
  const requested = await scenarioRuntime.until('approval.requested')
  expect(requested.payload.runId).toBe(spec.runId)
  expect(requested.payload.callId).toBe('call-artifact-1')
  expect(requested.payload.toolName).toBe('publish_artifact')
  return requested
}

describe('probe: approval interception and tool registration', () => {
  it('allowed_once lets the registered publish_artifact tool execute and emits artifact.candidate', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('tool-approval', spec)
    try {
      const requested = await driveToApproval(runtime)
      expect(typeof requested.payload.reason).toBe('string')

      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )

      // tools.register 契约：模型可调 publish_artifact，执行成功并产生 artifact.candidate。
      const candidate = await runtime.until('artifact.candidate')
      expect(candidate.payload).toMatchObject({
        runId: spec.runId,
        relativePath: 'out/report.md',
        title: 'Report',
        mediaType: 'text/markdown',
      })

      await runtime.until('run.completed')

      // tool/result 在 artifact.candidate 之后落进 session 流；turn 收尾后再断言。
      const events = sessionEventsOf(runtime.outputs)
      const result = events.find((e) => e.type === 'tool/result')
      expect(result).toBeDefined()
      expect(JSON.stringify(result?.data)).not.toContain('"isError":true')
    } finally {
      await runtime.dispose()
    }
  })

  /**
   * 切片⑧（#241；ADR-0009 决策 7）：full_access 档——initialize 带
   * approvalPolicy='full_access' 时 pre-execute 直接放行：
   *   * 全程**零** approval.requested（不存在等待人批准的中间态）；
   *   * 工具照常执行并产出 artifact.candidate；
   *   * 与 approval_required 的差别只在拦截层，工具语义不变。
   * 判据是可失败的：`until('approval.requested')` 的竞速版本——等 run.completed
   * 后断言输出流里没有 approval.requested 帧（有就是档位没生效）。
   */
  it('full_access: tool runs without any approval.requested frame, candidate still emitted', async () => {
    const base = runtimeSpec()
    const spec = { ...base, approvalPolicy: 'full_access' as const }
    // 场景复用 tool-approval 的 fixture：模型侧剧本（调工具、收结果）与档位无关，
    // 档位只改变 runtime 的 pre-exec 决策——这正是本用例要验的差别面。
    const runtime = await startReplayRuntime('tool-approval', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'publish the report' }),
      )

      const candidate = await runtime.until('artifact.candidate')
      expect(candidate.payload).toMatchObject({
        runId: spec.runId,
        relativePath: 'out/report.md',
        title: 'Report',
        mediaType: 'text/markdown',
      })
      await runtime.until('run.completed')

      expect(
        runtime.outputs.some((frame) => frame.type === 'approval.requested'),
        'full_access 下不应有任何 approval.requested 帧',
      ).toBe(false)

      const events = sessionEventsOf(runtime.outputs)
      const result = events.find((e) => e.type === 'tool/result')
      expect(result).toBeDefined()
      expect(JSON.stringify(result?.data)).not.toContain('"isError":true')
    } finally {
      await runtime.dispose()
    }
  })

  it('rejected blocks the tool call: no artifact.candidate, error tool result, run still completes', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('tool-approval', spec)
    try {
      const requested = await driveToApproval(runtime)
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'rejected',
        }),
      )

      await runtime.until('run.completed')
      expect(runtime.outputs.some((frame) => frame.type === 'artifact.candidate')).toBe(false)

      const events = sessionEventsOf(runtime.outputs)
      const result = events.find((e) => e.type === 'tool/result')
      expect(result).toBeDefined()
      // 拒绝必须落成失败的 tool/result，而不是静默吞掉。
      expect(JSON.stringify(result?.data)).toContain('"isError":true')
    } finally {
      await runtime.dispose()
    }
  })
})
