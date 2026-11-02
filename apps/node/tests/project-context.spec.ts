/**
 * ADR-0027 §3（PC-05a）：Node 项目上下文快照下载。
 *
 * 判定基线：清单外条目/快照头不符/正文 digest 或 byteSize 不符 → 不写半成品、
 * 目录清理；正常路径按 entryId 命名写入本地副本，供 read_project_context 读取。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunStartProjectContext } from '@whalepod/protocol'
import { ProjectContextDownloader, ProjectContextError } from '../src/context/project-context.js'

let root: string
let inputsRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-project-context-'))
  inputsRoot = join(root, 'runtime-context')
  await mkdir(inputsRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const SNAPSHOT_ID = '01905f7c-0000-7000-8000-000000000302'
const ENTRY_ID = '01905f7c-0000-7000-8000-000000000303'
const BODY = '# 冻结上下文\n预算结论：8 万\n'
const DIGEST = createHash('sha256').update(BODY).digest('hex')
const ENTRY = {
  entryId: ENTRY_ID,
  kind: 'decision' as const,
  title: '预算结论',
  revisionId: null,
  businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
  digest: DIGEST,
  byteSize: Buffer.byteLength(BODY, 'utf8'),
  snapshotAuthorizationGeneration: null,
}
const HEADER_TEXT = `[project-context:0123456789abcdef]\n- ${ENTRY_ID} 预算结论`
const HEADER_DIGEST = createHash('sha256').update(HEADER_TEXT).digest('hex')
const SNAPSHOT_DIGEST = createHash('sha256').update('snapshot').digest('hex')

function manifest(): RunStartProjectContext {
  return {
    snapshotId: SNAPSHOT_ID,
    digest: SNAPSHOT_DIGEST,
    headerText: HEADER_TEXT,
    headerDigest: HEADER_DIGEST,
    manifest: [ENTRY],
  }
}

function bundle(overrides: Record<string, unknown> = {}): unknown {
  return {
    snapshotId: SNAPSHOT_ID,
    digest: SNAPSHOT_DIGEST,
    headerText: HEADER_TEXT,
    headerDigest: HEADER_DIGEST,
    entries: [
      {
        entryId: ENTRY_ID,
        kind: 'decision',
        title: '预算结论',
        digest: DIGEST,
        byteSize: ENTRY.byteSize,
        bodyBase64: Buffer.from(BODY).toString('base64'),
      },
    ],
    ...overrides,
  }
}

function makeHarness(input: { body?: unknown; status?: number; errorBody?: string }): {
  downloader: ProjectContextDownloader
  requests: Array<{ url: string; token: string }>
} {
  const requests: Array<{ url: string; token: string }> = []
  const fetchImpl: typeof fetch = async (target, init) => {
    requests.push({
      url: String(target),
      token: String(new Headers(init?.headers).get('authorization')),
    })
    if (input.status !== undefined) {
      return new Response(input.errorBody ?? 'nope', { status: input.status })
    }
    return new Response(JSON.stringify({ ok: true, data: input.body ?? bundle() }), {
      status: 200,
    })
  }
  return {
    downloader: new ProjectContextDownloader({
      hubUrl: 'http://hub.test',
      deviceToken: 'test-device-token',
      inputsRoot,
      fetchImpl,
    }),
    requests,
  }
}

describe('ProjectContextDownloader', () => {
  it('downloads entries by entryId and verifies digest/byteSize', async () => {
    const h = makeHarness({})
    const prepared = await h.downloader.prepare(RUN_ID, manifest())
    expect(prepared.dir).toBe(join(inputsRoot, RUN_ID))
    expect(prepared.entries).toEqual([ENTRY])
    expect(await readFile(join(prepared.dir, ENTRY_ID), 'utf8')).toBe(BODY)
    expect(h.requests[0]?.url).toBe(
      `http://hub.test/api/v1/node/runs/${RUN_ID}/project-context/bundle`,
    )
    expect(h.requests[0]?.token).toBe('Device test-device-token')
  })

  it('rejects a tampered body, cleans the directory, and never leaves a partial copy', async () => {
    const h = makeHarness({
      body: bundle({
        entries: [
          {
            entryId: ENTRY_ID,
            kind: 'decision',
            title: '预算结论',
            digest: DIGEST,
            byteSize: ENTRY.byteSize,
            bodyBase64: Buffer.from('tampered').toString('base64'),
          },
        ],
      }),
    })
    await expect(h.downloader.prepare(RUN_ID, manifest())).rejects.toMatchObject({
      code: 'CONTEXT_DIGEST_MISMATCH',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('rejects a bundle whose snapshot/header identity does not match run.start', async () => {
    const h = makeHarness({ body: bundle({ snapshotId: randomUUID() }) })
    await expect(h.downloader.prepare(RUN_ID, manifest())).rejects.toBeInstanceOf(
      ProjectContextError,
    )
    await expect(
      makeHarness({ body: bundle({ headerText: `${HEADER_TEXT}\nchanged` }) }).downloader.prepare(
        RUN_ID,
        manifest(),
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_DIGEST_MISMATCH' })
  })

  it('passes through the Hub failure code and writes nothing', async () => {
    const h = makeHarness({
      status: 409,
      errorBody: JSON.stringify({
        ok: false,
        error: { code: 'CONTEXT_UNAVAILABLE', message: 'unavailable', requestId: 'req-1' },
      }),
    })
    await expect(h.downloader.prepare(RUN_ID, manifest())).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })
})
