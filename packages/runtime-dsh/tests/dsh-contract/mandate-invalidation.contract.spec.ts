/**
 * ADR-0028 §9（RD-03c2）：Mandate 实时失效率契约。
 *
 * 真 RuntimeBridge boot（replay LLM）+ 真 fs 工具：失效信号到达后，写工具
 * 即使原本在 allowlist 内也不再执行、不产生审批；读工具仍按既有路径硬边界
 * 放行。Run 不因失效信号被自动杀死。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunToolPolicy, RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

const WORK_KEY = '01905f7c-0000-7000-8000-000000000905'
const MANDATE_ID = '01905f7c-0000-7000-8000-000000000906'

function policy(allowedToolNames: RunToolPolicy['allowedToolNames']): RunToolPolicy {
  return { mode: 'draft', allowedToolNames, mandateVersion: 2, workKey: WORK_KEY }
}

function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

async function driveAfterInvalidation(
  scenario: Parameters<typeof startReplayRuntime>[0],
  allowedToolNames: RunToolPolicy['allowedToolNames'],
) {
  const spec = runtimeSpec({ toolPolicy: policy(allowedToolNames) })
  const runtime = await startReplayRuntime(scenario, spec)
  await runtime.send(initializeCommand(spec))
  await runtime.until('runtime.ready')
  await runtime.send(
    commandFrame('run.mandate_invalidated', {
      runId: spec.runId,
      mandateId: MANDATE_ID,
      reason: 'mandate_revoked',
    }),
  )
  await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'continue' }))
  await runtime.until('run.completed')
  return { runtime, spec }
}

describe('probe: live mandate invalidation', () => {
  it('denies an allowlisted draft write after invalidation, with no approval', async () => {
    const { runtime, spec } = await driveAfterInvalidation('tool-path-draft-write', ['write'])
    try {
      expect(runtime.outputs.some((frame) => frame.type === 'approval.requested')).toBe(false)
      const text = sessionEventsOf(runtime.outputs)
        .map((event) => JSON.stringify(event))
        .join('\n')
      expect(text).toContain('mandate invalidated (mandate_revoked)')
      expect(existsSync(join(spec.workspacePath, '.whalepod', 'drafts', 'probe.md'))).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('still allows an in-scope read after invalidation even when it was not allowlisted', async () => {
    const { runtime } = await driveAfterInvalidation('tool-path-inside', ['write'])
    try {
      expect(runtime.outputs.some((frame) => frame.type === 'approval.requested')).toBe(false)
      const results = sessionEventsOf(runtime.outputs)
        .filter((event) => event.type === 'tool/result')
        .map((event) => JSON.stringify(event.data))
        .join('\n')
      expect(results).toContain('probe report')
    } finally {
      await runtime.dispose()
    }
  })

  it('still allows publish_artifact as a finish step after invalidation', async () => {
    const spec = runtimeSpec({ toolPolicy: policy([]) })
    const runtime = await startReplayRuntime('tool-approval', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.mandate_invalidated', {
          runId: spec.runId,
          mandateId: MANDATE_ID,
          reason: 'mandate_expired',
        }),
      )
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'publish the report' }),
      )
      const candidate = await runtime.until('artifact.candidate')
      expect(candidate.payload).toMatchObject({ relativePath: 'out/report.md' })
      await runtime.until('run.completed')
      expect(runtime.outputs.some((frame) => frame.type === 'approval.requested')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('a pending approval cannot execute a write after invalidation', async () => {
    // write 在面内但不在 allowlist：先产生 approval.requested；失效信号先于
    // allowed_once 到达时，guard 必须在执行前再次拒绝。
    const spec = runtimeSpec({ toolPolicy: policy(['read']) })
    const runtime = await startReplayRuntime('tool-path-draft-write', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'write the draft probe' }),
      )
      const requested = await runtime.until('approval.requested')
      await runtime.send(
        commandFrame('run.mandate_invalidated', {
          runId: spec.runId,
          mandateId: MANDATE_ID,
          reason: 'mandate_revoked',
        }),
      )
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )
      await runtime.until('run.completed')
      expect(existsSync(join(spec.workspacePath, '.whalepod', 'drafts', 'probe.md'))).toBe(false)
      const text = sessionEventsOf(runtime.outputs)
        .map((event) => JSON.stringify(event))
        .join('\n')
      expect(text).toContain('mandate invalidated (mandate_revoked)')
    } finally {
      await runtime.dispose()
    }
  })
})
