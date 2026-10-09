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

  /**
   * A0-6（#288）「未知 Approval 只拒不放行」——**Runtime 层**负向面。
   *
   * 这一层此前零测试：`ApprovalPort.decide` 对未知/已 settle 的 callId 只记 warn、
   * 不产生任何 outcome（`approval-port.ts` 的 settle 分支），Hub/Node/projector 侧的
   * 未知 id 判据都在别处（approval-decision.integration / run-authorization.security /
   * projector.spec），唯独「最靠近模型执行的那一层」没被钉过。
   *
   * 双向夹逼，**不用 sleep 猜时间**（与 #256 纪律同形：先用一个决定把状态推坏，
   * 再用真正生效的那个决定把终局拉出来，比较终局）：
   *   A. 未知 callId 先发 allowed_once，再用**正确** callId 发 rejected：
   *      若未知决定被误认领（fail-open），工具就已执行 ⟹ 终局会出现 artifact.candidate ⟹ 红。
   *   B. 未知 callId 先发 rejected，再用**正确** callId 发 allowed_once：
   *      若未知决定被误认领（把待决吞成拒绝），工具永远不会执行 ⟹ 终局没有 candidate ⟹ 红。
   * 两条都绿 = 未知 callId 是 no-op，且**待决的请求仍然待决**（决定权完好无损）。
   */
  it('A0-6: unknown callId decide is a no-op — neither grants (A) nor swallows (B) the pending approval', async () => {
    // A：未知的 allowed_once 不得放行。
    const specA = runtimeSpec()
    const runtimeA = await startReplayRuntime('tool-approval', specA)
    try {
      const requested = await driveToApproval(runtimeA)
      await runtimeA.send(
        commandFrame('approval.decide', {
          runId: specA.runId,
          callId: 'call-unknown-ghost',
          decision: 'allowed_once',
        }),
      )
      await runtimeA.send(
        commandFrame('approval.decide', {
          runId: specA.runId,
          callId: requested.payload.callId,
          decision: 'rejected',
        }),
      )
      await runtimeA.until('run.completed')
      expect(
        runtimeA.outputs.some((frame) => frame.type === 'artifact.candidate'),
        '未知 callId 的 allowed_once 被误认领：工具执行了（fail-open）',
      ).toBe(false)
    } finally {
      await runtimeA.dispose()
    }

    // B：未知的 rejected 不得吞掉待决请求。
    const specB = runtimeSpec()
    const runtimeB = await startReplayRuntime('tool-approval', specB)
    try {
      const requested = await driveToApproval(runtimeB)
      await runtimeB.send(
        commandFrame('approval.decide', {
          runId: specB.runId,
          callId: 'call-unknown-ghost',
          decision: 'rejected',
        }),
      )
      await runtimeB.send(
        commandFrame('approval.decide', {
          runId: specB.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )
      const candidate = await runtimeB.until('artifact.candidate')
      expect(candidate.payload).toMatchObject({ runId: specB.runId, relativePath: 'out/report.md' })
      await runtimeB.until('run.completed')
    } finally {
      await runtimeB.dispose()
    }
  })
})
