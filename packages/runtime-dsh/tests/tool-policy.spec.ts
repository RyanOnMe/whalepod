/**
 * ADR-0028 §7（RD-03c1）：固定草稿面 + Mandate 步级预批准的纯裁决表。
 * 路径/资源范围是免审批的前置条件：读限工作区 + 随 Run 下发的只读材料根，
 * 写限工作区内 `.whalepod/drafts/`；越界一律 deny。
 * 真正的 pre-execute 接线由 contract 用例覆盖；这里逐名、逐路径钉住 allow/ask/deny。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunToolPolicy } from '@whalepod/protocol'
import { machineDraftToolDecision } from '../src/tool-policy.js'

const policy: RunToolPolicy = {
  mode: 'draft',
  allowedToolNames: ['read', 'glob', 'grep', 'write', 'edit'],
  mandateVersion: 3,
  workKey: '01905f7c-0000-7000-8000-000000000901',
}

let root: string
let workspace: string
let scope: { workspacePath: string; readRoots: string[] }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'whalepod-tool-policy-'))
  workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(join(workspace, '.whalepod', 'drafts'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'main.ts'), 'export const ok = true\n')
  scope = { workspacePath: workspace, readRoots: [join(root, 'inputs')] }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function decide(name: string, args: unknown = {}) {
  return machineDraftToolDecision(policy, name, args, scope)
}

describe('machineDraftToolDecision', () => {
  it('leaves human Runs to the existing approval policy', () => {
    expect(machineDraftToolDecision(undefined, 'bash', {}, scope)).toBeUndefined()
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
      expect(decide(name)).toMatchObject({ kind: 'deny' })
    }
  })

  it('allows the implicit read/result channels without an approval', () => {
    for (const name of ['publish_artifact', 'read_work_input', 'read_project_context']) {
      expect(decide(name)).toEqual({ kind: 'allow' })
    }
  })

  it('allows surface tools named by the Mandate when the path is inside the workspace', () => {
    expect(decide('read', { file_path: 'src/main.ts' })).toEqual({ kind: 'allow' })
    expect(decide('read', { file_path: join(workspace, 'src', 'main.ts') })).toEqual({
      kind: 'allow',
    })
    expect(decide('glob', { pattern: '**/*.ts' })).toEqual({ kind: 'allow' })
    expect(decide('glob', { pattern: '**/*.ts', path: 'src' })).toEqual({ kind: 'allow' })
    expect(decide('grep', { pattern: 'ok', path: 'src' })).toEqual({ kind: 'allow' })
  })

  it('denies reads outside the workspace and outside the read roots', () => {
    const outside = join(root, 'secret.txt')
    writeFileSync(outside, 'host secret\n')
    expect(decide('read', { file_path: outside })).toMatchObject({ kind: 'deny' })
    expect(decide('read', { file_path: '../secret.txt' })).toMatchObject({ kind: 'deny' })
    expect(decide('glob', { pattern: '**/*.txt', path: '../' })).toMatchObject({ kind: 'deny' })
    expect(decide('grep', { pattern: 'secret', path: root })).toMatchObject({ kind: 'deny' })
  })

  it('denies symlink escapes even when the literal path stays inside the workspace', () => {
    const outside = join(root, 'outside-dir')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'host secret\n')
    symlinkSync(outside, join(workspace, 'link-out'))
    expect(decide('read', { file_path: 'link-out/secret.txt' })).toMatchObject({ kind: 'deny' })
    // 目标尚不存在时也要按最近的已存在祖先判定：draft 内的 symlink 不能把写带出去。
    symlinkSync(outside, join(workspace, '.whalepod', 'drafts', 'link-out'))
    expect(decide('write', { file_path: '.whalepod/drafts/link-out/new.md' })).toMatchObject({
      kind: 'deny',
    })
  })

  it('allows reads of the run material roots outside the workspace', () => {
    const inputs = join(root, 'inputs')
    mkdirSync(inputs)
    writeFileSync(join(inputs, 'inbox-item.txt'), 'material\n')
    expect(decide('read', { file_path: join(inputs, 'inbox-item.txt') })).toEqual({
      kind: 'allow',
    })
  })

  it('allows writes only inside the draft area', () => {
    expect(decide('write', { file_path: '.whalepod/drafts/report.md' })).toEqual({ kind: 'allow' })
    expect(decide('write', { file_path: join(workspace, '.whalepod/drafts/new.md') })).toEqual({
      kind: 'allow',
    })
    expect(decide('edit', { file_path: '.whalepod/drafts/report.md' })).toEqual({ kind: 'allow' })
    expect(decide('write', { file_path: 'src/main.ts' })).toMatchObject({ kind: 'deny' })
    expect(decide('edit', { file_path: 'src/main.ts' })).toMatchObject({ kind: 'deny' })
    expect(decide('write', { file_path: join(root, 'outside.md') })).toMatchObject({ kind: 'deny' })
  })

  it('fails closed on malformed paths', () => {
    expect(decide('read', {})).toMatchObject({ kind: 'deny' })
    expect(decide('read', { file_path: '   ' })).toMatchObject({ kind: 'deny' })
    expect(decide('read', { file_path: 'src/\0main.ts' })).toMatchObject({ kind: 'deny' })
    expect(decide('read', { file_path: 'C:\\Windows\\win.ini' })).toMatchObject({ kind: 'deny' })
  })

  it('denies a draft root that is itself a symlink redirect', () => {
    // `.whalepod/drafts -> src`：若把草稿根 canonical 化，src 会被误当成合法
    // 草稿区；根必须按字面路径判定。
    rmSync(join(workspace, '.whalepod'), { recursive: true, force: true })
    symlinkSync(join(workspace, 'src'), join(workspace, '.whalepod'), 'dir')
    expect(decide('write', { file_path: '.whalepod/drafts/probe.md' })).toMatchObject({
      kind: 'deny',
    })

    unlinkSync(join(workspace, '.whalepod'))
    mkdirSync(join(workspace, '.whalepod'), { recursive: true })
    symlinkSync(join(workspace, 'src'), join(workspace, '.whalepod', 'drafts'), 'dir')
    expect(decide('write', { file_path: '.whalepod/drafts/probe.md' })).toMatchObject({
      kind: 'deny',
    })
  })

  it('asks for in-scope surface tools outside the Mandate allowlist', () => {
    const readOnly: RunToolPolicy = { ...policy, allowedToolNames: ['read'] }
    expect(
      machineDraftToolDecision(readOnly, 'write', { file_path: '.whalepod/drafts/x' }, scope),
    ).toMatchObject({ kind: 'ask' })
    expect(
      machineDraftToolDecision(readOnly, 'edit', { file_path: '.whalepod/drafts/x' }, scope),
    ).toMatchObject({ kind: 'ask' })
    expect(machineDraftToolDecision(readOnly, 'grep', { pattern: 'ok' }, scope)).toMatchObject({
      kind: 'ask',
    })
  })

  it('keeps path scope ahead of the allowlist ask (out-of-scope never reaches approval)', () => {
    const writeOnly: RunToolPolicy = { ...policy, allowedToolNames: ['write'] }
    expect(
      machineDraftToolDecision(writeOnly, 'read', { file_path: '../secret.txt' }, scope),
    ).toMatchObject({ kind: 'deny' })
    expect(
      machineDraftToolDecision(writeOnly, 'write', { file_path: 'src/main.ts' }, scope),
    ).toMatchObject({ kind: 'deny' })
  })

  it('after mandate invalidation only read/finish tools run, without asking', () => {
    const writeOnly: RunToolPolicy = { ...policy, allowedToolNames: ['write'] }
    expect(
      machineDraftToolDecision(
        writeOnly,
        'write',
        { file_path: '.whalepod/drafts/x' },
        scope,
        'mandate_revoked',
      ),
    ).toMatchObject({ kind: 'deny' })
    expect(
      machineDraftToolDecision(
        writeOnly,
        'read',
        { file_path: 'src/main.ts' },
        scope,
        'mandate_revoked',
      ),
    ).toEqual({ kind: 'allow' })
    expect(
      machineDraftToolDecision(writeOnly, 'publish_artifact', {}, scope, 'mandate_revoked'),
    ).toEqual({ kind: 'allow' })
    expect(
      machineDraftToolDecision(
        writeOnly,
        'read',
        { file_path: '../secret.txt' },
        scope,
        'mandate_revoked',
      ),
    ).toMatchObject({ kind: 'deny' })
    expect(machineDraftToolDecision(writeOnly, 'bash', {}, scope, 'mandate_revoked')).toMatchObject(
      { kind: 'deny' },
    )
  })
})
