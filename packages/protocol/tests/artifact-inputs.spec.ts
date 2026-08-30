/**
 * Runtime wire：Reviewer 输入 manifest 字段（P1-15，03 §7.1 runtime.initialize 扩展）。
 *
 * `artifactInputs`（任务已发布 Artifact 的只读输入清单）与 `artifactInputsDir`
 * （Node 下载副本的本地目录，本地 wire 绝对路径——红线同 workspacePath）必须
 * 成对出现：只带清单不给目录、或只给目录不带清单，都是畸形 initialize，
 * fail-closed 拒绝。清单条目锁定内容寻址事实（artifactId/sha256/byteSize），
 * 不含任何本地路径。
 *
 * #64（P1-15 评审跟进）：manifest 响应（ArtifactInputManifestSchema）条目上限
 * 以导出常量钉死，上限值恰好通过、上限+1 fail-closed 拒绝——Hub 与 schema
 * 共用同一常量，防两处漂移。
 */
import { describe, expect, it } from 'vitest'
import { ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES, ArtifactInputManifestSchema } from '../src/http.js'
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

describe('ArtifactInputManifestSchema 条目上限（#64）', () => {
  const TASK_ID = '01905f7c-0000-7000-8000-000000000201'

  function manifestEntry(i: number) {
    return {
      artifactId: `01905f7c-0000-7000-8000-${String(i).padStart(12, '0')}`,
      runId: '01905f7c-0000-7000-8000-000000000301',
      title: `Builder report ${i}`,
      mediaType: 'text/markdown',
      byteSize: 10,
      sha256: '3c'.repeat(32),
      publishedAt: '2026-01-05T09:30:00Z',
    }
  }

  function parseManifest(count: number): { ok: boolean } {
    return {
      ok: ArtifactInputManifestSchema.safeParse({
        taskId: TASK_ID,
        artifacts: Array.from({ length: count }, (_, i) => manifestEntry(i)),
      }).success,
    }
  }

  it('上限值 = 导出常量（Hub 与 schema 共用，防漂移）', () => {
    expect(ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES).toBe(64)
  })

  it(`恰好 ${ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES} 条（上限）通过`, () => {
    expect(parseManifest(ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES)).toEqual({ ok: true })
  })

  it(`超上限（${ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES + 1} 条）fail-closed 拒绝`, () => {
    expect(parseManifest(ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES + 1)).toEqual({ ok: false })
  })
})
