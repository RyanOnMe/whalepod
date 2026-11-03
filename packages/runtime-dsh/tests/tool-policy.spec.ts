/**
 * ADR-0028 §7（RD-03c1）：固定草稿面 + Mandate 步级预批准的纯裁决表。
 * 真正的 pre-execute 接线由 contract 用例覆盖；这里逐名钉住 allow/ask/deny。
 */
import { describe, expect, it } from 'vitest'
import type { RunToolPolicy } from '@whalepod/protocol'
import { machineDraftToolDecision } from '../src/tool-policy.js'

const policy: RunToolPolicy = {
  mode: 'draft',
  allowedToolNames: ['read', 'glob'],
  mandateVersion: 3,
  workKey: '01905f7c-0000-7000-8000-000000000901',
}

describe('machineDraftToolDecision', () => {
  it('leaves human Runs to the existing approval policy', () => {
    expect(machineDraftToolDecision(undefined, 'bash')).toBeUndefined()
  })

  it('denies every tool outside the fixed draft surface', () => {
    for (const name of [
      'bash',
      'pwsh',
      'run_code',
      'workflow',
      'subagent',
      'subagent_fork',
      'job_list',
      'skill',
      'web_search',
      'str_replace_editor',
      'todo_write',
      'goal',
      'ralph',
      'send_message',
    ]) {
      expect(machineDraftToolDecision(policy, name)).toMatchObject({ kind: 'deny' })
    }
  })

  it('allows the implicit read/result channels without an approval', () => {
    for (const name of ['publish_artifact', 'read_work_input', 'read_project_context']) {
      expect(machineDraftToolDecision(policy, name)).toEqual({ kind: 'allow' })
    }
  })

  it('allows surface tools named by the Mandate without an approval', () => {
    expect(machineDraftToolDecision(policy, 'read')).toEqual({ kind: 'allow' })
    expect(machineDraftToolDecision(policy, 'glob')).toEqual({ kind: 'allow' })
  })

  it('asks for surface tools outside the Mandate allowlist', () => {
    expect(machineDraftToolDecision(policy, 'write')).toMatchObject({ kind: 'ask' })
    expect(machineDraftToolDecision(policy, 'edit')).toMatchObject({ kind: 'ask' })
    expect(machineDraftToolDecision(policy, 'grep')).toMatchObject({ kind: 'ask' })
  })
})
