/**
 * Runtime wire：Reviewer 输入 manifest 字段（P1-15，03 §7.1 runtime.initialize 扩展）。
 *
 * `artifactInputs`（任务已发布 Artifact 的只读输入清单）与 `artifactInputsDir`
 * （Node 下载副本的本地目录，本地 wire 绝对路径——红线同 workspacePath）必须
 * 成对出现：只带清单不给目录、或只给目录不带清单，都是畸形 initialize，
 * fail-closed 拒绝。清单条目锁定内容寻址事实（artifactId/sha256/byteSize），
 * 不含任何本地路径。
 */
import { describe, expect, it } from 'vitest'
import { RuntimeInitializeSchema } from '../src/runtime-wire.js'

const BASE_PAYLOAD = {
  runId: '01905f7c-0000-7000-8000-000000000301',
  workspacePath: '<workspace>',
  dshHomePath: '<dsh-home>',
  profileDigest: '1a'.repeat(32),
  pluginPackDigest: '2b'.repeat(32),
  provider: 'deepseek',
  model: 'deepseek-chat',
  persona: 'You are a careful TypeScript reviewer.',
}

const ENTRY = {
  artifactId: '01905f7c-0000-7000-8000-000000000901',
  title: 'Builder report',
  mediaType: 'text/markdown',
  byteSize: 2048,
  sha256: '3c'.repeat(32),
}

function initializeWith(extra: Record<string, unknown>): { ok: boolean } {
  const frame = {
    protocolVersion: 1,
    messageId: '01905f7c-0000-7000-8000-00000000a021',
    type: 'runtime.initialize',
    sentAt: '2026-01-05T09:00:01Z',
    payload: { ...BASE_PAYLOAD, ...extra },
  }
  return { ok: RuntimeInitializeSchema.safeParse(frame).success }
}

describe('runtime.initialize artifact input manifest', () => {
  it('accepts a reviewer run: inputs + dir together', () => {
    expect(
      initializeWith({ artifactInputs: [ENTRY], artifactInputsDir: '<runtime-inputs>/r1' }),
    ).toEqual({ ok: true })
  })

  it('accepts a builder run: no inputs, no dir', () => {
    expect(initializeWith({})).toEqual({ ok: true })
  })

  it('rejects inputs without dir (pair rule, fail-closed)', () => {
    expect(initializeWith({ artifactInputs: [ENTRY] })).toEqual({ ok: false })
  })

  it('rejects dir without inputs (pair rule, fail-closed)', () => {
    expect(initializeWith({ artifactInputsDir: '<runtime-inputs>/r1' })).toEqual({ ok: false })
  })

  it('rejects entry with malformed sha256', () => {
    expect(
      initializeWith({
        artifactInputs: [{ ...ENTRY, sha256: 'not-a-digest' }],
        artifactInputsDir: '<runtime-inputs>/r1',
      }),
    ).toEqual({ ok: false })
  })

  it('rejects entry over the 50 MiB artifact cap', () => {
    expect(
      initializeWith({
        artifactInputs: [{ ...ENTRY, byteSize: 52_428_801 }],
        artifactInputsDir: '<runtime-inputs>/r1',
      }),
    ).toEqual({ ok: false })
  })

  it('rejects entry carrying a local path (manifest is path-free)', () => {
    expect(
      initializeWith({
        artifactInputs: [{ ...ENTRY, localPath: '<workspace>/report.md' }],
        artifactInputsDir: '<runtime-inputs>/r1',
      }),
    ).toEqual({ ok: false })
  })
})
