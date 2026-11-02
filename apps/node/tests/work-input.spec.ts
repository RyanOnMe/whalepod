/**
 * ADR-0028 §3（RD-02a-2b）：Node 工作输入正文下载。
 *
 * 判定基线：清单外条目/清单头不符/正文 digest 或 byteSize 不符 → 不写半成品、
 * 目录清理；正常路径按 inboxItemId 命名写入本地副本，供 read_work_input 读取。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunStartWorkInput, WorkInputBundleEntry } from '@whalepod/protocol'
import {
  WorkInputDownloader,
  WorkInputError,
  workInputBundleMatchesManifest,
} from '../src/work/work-input.js'

let root: string
let inputsRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-work-input-'))
  inputsRoot = join(root, 'runtime-work-inputs')
  await mkdir(inputsRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RUN_ID = '01905f7c-0000-7000-8000-000000000401'
const WORK_KEY = '01905f7c-0000-7000-8000-000000000402'
const ITEM_ID = '01905f7c-0000-7000-8000-000000000403'
const SOURCE_ID = '01905f7c-0000-7000-8000-000000000404'
const BODY = '# 需求澄清\n预算口径：含税，单位万元。\n'
const BODY_DIGEST = createHash('sha256').update(BODY).digest('hex')
const MANIFEST_DIGEST = createHash('sha256').update('manifest-rd02a2b').digest('hex')
const ENTRY = {
  inboxItemId: ITEM_ID,
  sourceType: 'task_message' as const,
  sourceId: SOURCE_ID,
  sourceVersion: '7',
  sourceDigest: createHash('sha256').update('source-v7').digest('hex'),
  bodyDigest: BODY_DIGEST,
  byteSize: Buffer.byteLength(BODY, 'utf8'),
  authorizationGeneration: 'gen-3',
  title: '需求澄清',
}

function startInput(): RunStartWorkInput {
  return {
    manifestDigest: MANIFEST_DIGEST,
    manifest: { version: 'rd02a2.v1', workKey: WORK_KEY, entries: [ENTRY] },
  }
}

function bundleEntry(overrides: Partial<WorkInputBundleEntry> = {}): WorkInputBundleEntry {
  return {
    ...ENTRY,
    bodyBase64: Buffer.from(BODY).toString('base64'),
    ...overrides,
  }
}

function bundle(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 'rd02a2.v1',
    workKey: WORK_KEY,
    manifestDigest: MANIFEST_DIGEST,
    entries: [bundleEntry()],
    ...overrides,
  }
}

function makeHarness(input: {
  body?: unknown
  status?: number
  errorBody?: string
  fetchThrows?: boolean
}): {
  downloader: WorkInputDownloader
  requests: Array<{ url: string; token: string }>
} {
  const requests: Array<{ url: string; token: string }> = []
  const fetchImpl: typeof fetch = async (target, init) => {
    if (input.fetchThrows === true) throw new TypeError('fetch failed')
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
    downloader: new WorkInputDownloader({
      hubUrl: 'http://hub.test',
      deviceToken: 'test-device-token',
      inputsRoot,
      fetchImpl,
    }),
    requests,
  }
}

describe('WorkInputDownloader', () => {
  it('downloads entries by inboxItemId and verifies digest/byteSize', async () => {
    const h = makeHarness({})
    const prepared = await h.downloader.prepare(RUN_ID, startInput())
    expect(prepared.dir).toBe(join(inputsRoot, RUN_ID))
    expect(prepared.workKey).toBe(WORK_KEY)
    expect(prepared.manifestDigest).toBe(MANIFEST_DIGEST)
    expect(prepared.entries).toEqual([ENTRY])
    expect(await readFile(join(prepared.dir, ITEM_ID), 'utf8')).toBe(BODY)
    expect(h.requests[0]?.url).toBe(`http://hub.test/api/v1/node/runs/${RUN_ID}/work-input/bundle`)
    expect(h.requests[0]?.token).toBe('Device test-device-token')
  })

  it('rejects a tampered body, cleans the directory, and never leaves a partial copy', async () => {
    const h = makeHarness({
      body: bundle({
        entries: [
          bundleEntry({
            // 与原文等长：确保判红来自摘要而不是 byteSize。
            bodyBase64: Buffer.from('X'.repeat(Buffer.byteLength(BODY))).toString('base64'),
          }),
        ],
      }),
    })
    await expect(h.downloader.prepare(RUN_ID, startInput())).rejects.toMatchObject({
      code: 'CONTEXT_DIGEST_MISMATCH',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('rejects an entry whose pinned metadata changed in flight', async () => {
    const cases: Array<Record<string, unknown>> = [
      { sourceVersion: '8' },
      { sourceDigest: createHash('sha256').update('other').digest('hex') },
      { authorizationGeneration: 'gen-4' },
      { title: '另一条' },
    ]
    for (const overrides of cases) {
      const h = makeHarness({ body: bundle({ entries: [bundleEntry(overrides)] }) })
      await expect(h.downloader.prepare(RUN_ID, startInput())).rejects.toMatchObject({
        code: 'CONTEXT_DIGEST_MISMATCH',
      })
      expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
    }
  })

  it('rejects a bundle whose work key or manifest digest does not match run.start', async () => {
    for (const overrides of [
      { workKey: randomUUID() },
      { manifestDigest: createHash('sha256').update('other-manifest').digest('hex') },
    ]) {
      const h = makeHarness({ body: bundle(overrides) })
      await expect(h.downloader.prepare(RUN_ID, startInput())).rejects.toMatchObject({
        code: 'CONTEXT_DIGEST_MISMATCH',
      })
    }
  })

  it('rejects a bundle missing a pinned entry or carrying an extra one', async () => {
    const missing = makeHarness({ body: bundle({ entries: [] }) })
    await expect(missing.downloader.prepare(RUN_ID, startInput())).rejects.toBeInstanceOf(
      WorkInputError,
    )

    const extra = makeHarness({
      body: bundle({
        entries: [bundleEntry(), bundleEntry({ inboxItemId: randomUUID(), title: '额外条目' })],
      }),
    })
    await expect(extra.downloader.prepare(RUN_ID, startInput())).rejects.toMatchObject({
      code: 'CONTEXT_DIGEST_MISMATCH',
    })
    const duplicated = makeHarness({ body: bundle({ entries: [bundleEntry(), bundleEntry()] }) })
    await expect(duplicated.downloader.prepare(RUN_ID, startInput())).rejects.toMatchObject({
      code: 'CONTEXT_DIGEST_MISMATCH',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('passes through the Hub failure code and writes nothing', async () => {
    const h = makeHarness({
      status: 409,
      errorBody: JSON.stringify({
        ok: false,
        error: { code: 'CONTEXT_UNAVAILABLE', message: 'unavailable', requestId: 'req-1' },
      }),
    })
    await expect(h.downloader.prepare(RUN_ID, startInput())).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('maps a network failure to DEVICE_OFFLINE and maps unknown statuses', async () => {
    await expect(
      makeHarness({ fetchThrows: true }).downloader.prepare(RUN_ID, startInput()),
    ).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' })
    await expect(
      makeHarness({ status: 500 }).downloader.prepare(RUN_ID, startInput()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('cleanup removes the run directory', async () => {
    const h = makeHarness({})
    const prepared = await h.downloader.prepare(RUN_ID, startInput())
    expect(existsSync(prepared.dir)).toBe(true)
    await h.downloader.cleanup(RUN_ID)
    expect(existsSync(prepared.dir)).toBe(false)
  })
})

describe('workInputBundleMatchesManifest', () => {
  it('accepts a matching bundle and rejects identity/digest drift', () => {
    const matching = {
      version: 'rd02a2.v1' as const,
      workKey: WORK_KEY,
      manifestDigest: MANIFEST_DIGEST,
      entries: [bundleEntry()],
    }
    expect(workInputBundleMatchesManifest(matching, startInput().manifest)).toBe(true)
    expect(
      workInputBundleMatchesManifest(
        {
          ...matching,
          entries: [
            bundleEntry({
              bodyDigest: createHash('sha256').update('other-body').digest('hex'),
            }),
          ],
        },
        startInput().manifest,
      ),
    ).toBe(false)
    expect(
      workInputBundleMatchesManifest({ ...matching, entries: [] }, startInput().manifest),
    ).toBe(false)
  })
})
