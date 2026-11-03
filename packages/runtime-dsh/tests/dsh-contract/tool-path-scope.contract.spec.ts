/**
 * ADR-0028 §7（RD-03c1）：机器 Run 的路径/资源范围契约。
 *
 * 真 RuntimeBridge boot（replay LLM）+ 真 DSH fs 工具：证明「免审批」只在
 * 工作区/只读材料根内成立；越界读被 pre-execute 直接拒绝（无 approval.requested、
 * 正文不进会话），写入只在 `.whalepod/drafts/` 内落地。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunToolPolicy, RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

const WORK_KEY = '01905f7c-0000-7000-8000-000000000904'

function machinePolicy(allowedToolNames: RunToolPolicy['allowedToolNames']): RunToolPolicy {
  return { mode: 'draft', allowedToolNames, mandateVersion: 2, workKey: WORK_KEY }
}

function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

function toolResultsOf(outputs: readonly RuntimeOutput[]): string {
  return sessionEventsOf(outputs)
    .filter((event) => event.type === 'tool/result')
    .map((event) => JSON.stringify(event.data))
    .join('\n')
}

describe('probe: machine draft path scope', () => {
  it('denies an allowlisted read that escapes the workspace without asking a human', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whalepod-path-probe-'))
    const workspace = join(root, 'ws')
    mkdirSync(workspace)
    writeFileSync(join(root, 'probe-secret.txt'), 'probe-secret-body\n')
    const spec = runtimeSpec({ workspacePath: workspace, toolPolicy: machinePolicy(['read']) })
    const runtime = await startReplayRuntime('tool-path-outside', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'read the sibling probe file' }),
      )
      await runtime.until('run.completed')

      expect(
        runtime.outputs.some((frame) => frame.type === 'approval.requested'),
        '越界读必须直接 deny，不进入审批',
      ).toBe(false)
      const text = sessionEventsOf(runtime.outputs)
        .map((event) => JSON.stringify(event))
        .join('\n')
      expect(text).toContain('outside the authorized material scope')
      expect(toolResultsOf(runtime.outputs)).not.toContain('probe-secret-body')
    } finally {
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows an allowlisted read inside the workspace without approval', async () => {
    const spec = runtimeSpec({ toolPolicy: machinePolicy(['read']) })
    const runtime = await startReplayRuntime('tool-path-inside', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'read the report' }))
      await runtime.until('run.completed')

      expect(runtime.outputs.some((frame) => frame.type === 'approval.requested')).toBe(false)
      const results = toolResultsOf(runtime.outputs)
      expect(results).toContain('probe report')
      expect(results).not.toContain('"isError":true')
    } finally {
      await runtime.dispose()
    }
  })

  it('allows an allowlisted write only inside the workspace draft area', async () => {
    const spec = runtimeSpec({ toolPolicy: machinePolicy(['write']) })
    const runtime = await startReplayRuntime('tool-path-draft-write', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'write the draft probe' }),
      )
      await runtime.until('run.completed')

      expect(runtime.outputs.some((frame) => frame.type === 'approval.requested')).toBe(false)
      expect(
        readFileSync(join(spec.workspacePath, '.whalepod', 'drafts', 'probe.md'), 'utf8'),
      ).toBe('draft body\n')
      expect(toolResultsOf(runtime.outputs)).not.toContain('outside the draft area')
    } finally {
      await runtime.dispose()
    }
  })
})
