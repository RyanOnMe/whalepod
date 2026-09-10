/**
 * Node Reviewer 输入准备单测（P1-15；G6-06/07 的 Node 半场）。
 *
 * 判定基线：
 * - manifest 拉取 fail-closed（envelope/schema 校验），taskId 与 Run 不一致拒绝。
 * - 逐条受控下载副本：文件名 = artifactId（UUID 白名单，无用户可控文件名），
 *   字节 sha256 与 manifest 一致；篡改 → ARTIFACT_HASH_MISMATCH 且清理目录。
 * - prepare 产出 runtime.initialize 所需 entries + dir；cleanup 删除整目录。
 * - 无已发布 Artifact（Builder Run）→ 空 manifest，不下载、仍返回目录。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeArtifactInput } from '@whalepod/protocol'
import { ArtifactInputsManager, ArtifactInputsError } from '../src/artifact/inputs.js'

let root: string
let inputsRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-artifact-inputs-'))
  inputsRoot = join(root, 'runtime-inputs')
  await mkdir(inputsRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const TASK_ID = '01905f7c-0000-7000-8000-000000000201'

const CONTENT = '# builder report\n'
// manifest 条目形状（协议 ArtifactManifestEntrySchema）。
const ENTRY = {
  artifactId: '01905f7c-0000-7000-8000-000000000901',
  runId: RUN_ID,
  title: 'Builder report',
  mediaType: 'text/markdown',
  byteSize: CONTENT.length,
  sha256: createHash('sha256').update(CONTENT).digest('hex'),
  publishedAt: '2026-01-05T09:30:00Z',
}
// initialize 清单条目 = manifest 条目的内容寻址子集。
const INPUT_ENTRY: RuntimeArtifactInput = {
  artifactId: ENTRY.artifactId,
  title: ENTRY.title,
  mediaType: ENTRY.mediaType,
  byteSize: ENTRY.byteSize,
  sha256: ENTRY.sha256,
}

interface Harness {
  manager: ArtifactInputsManager
  requests: Array<{ url: string; token: string }>
}

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, data })
}

function makeHarness(input: {
  manifest?: unknown
  content?: Buffer
  manifestError?: number
  manifestErrorBody?: string
  contentError?: number
  manifestTaskId?: string
}): Harness {
  const requests: Array<{ url: string; token: string }> = []
  const fetchImpl: typeof fetch = async (input_, init) => {
    const url = String(input_)
    requests.push({ url, token: String(new Headers(init?.headers).get('authorization')) })
    if (url.endsWith('/input-manifest')) {
      if (input.manifestError !== undefined) {
        return new Response(input.manifestErrorBody ?? 'nope', {
          status: input.manifestError,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        envelope({
          taskId: input.manifestTaskId ?? TASK_ID,
          artifacts: input.manifest ?? [],
        }),
        { status: 200 },
      )
    }
    if (url.includes('/node/artifacts/')) {
      if (input.contentError !== undefined) {
        return new Response('missing', { status: input.contentError })
      }
      return new Response(new Uint8Array(input.content ?? Buffer.alloc(0)), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const manager = new ArtifactInputsManager({
    hubUrl: 'http://hub.test',
    deviceToken: 'test-device-token',
    inputsRoot,
    fetchImpl,
  })
  return { manager, requests }
}

describe('ArtifactInputsManager', () => {
  it('Builder Run（空 manifest）：返回空 entries，不下载任何副本', async () => {
    const h = makeHarness({ manifest: [] })
    const prepared = await h.manager.prepare(RUN_ID, TASK_ID)
    expect(prepared.entries).toEqual([])
    expect(prepared.dir).toBe(join(inputsRoot, RUN_ID))
    expect(await readdir(prepared.dir)).toHaveLength(0)
  })

  it('已发布 Artifact：受控下载副本，digest 一致，entries 带 dir 交给 initialize', async () => {
    const h = makeHarness({ manifest: [ENTRY], content: Buffer.from(CONTENT) })
    const prepared = await h.manager.prepare(RUN_ID, TASK_ID)
    expect(prepared.entries).toEqual([INPUT_ENTRY])
    expect(prepared.dir).toBe(join(inputsRoot, RUN_ID))
    const copy = await readFile(join(prepared.dir, ENTRY.artifactId))
    expect(createHash('sha256').update(copy).digest('hex')).toBe(ENTRY.sha256)
    // Node 面走 Device Token。
    expect(h.requests.every((r) => r.token === 'Device test-device-token')).toBe(true)
  })

  it('副本字节与 manifest digest 不符 → ARTIFACT_HASH_MISMATCH，目录清理', async () => {
    const h = makeHarness({
      manifest: [ENTRY],
      content: Buffer.from('tampered'),
    })
    await expect(h.manager.prepare(RUN_ID, TASK_ID)).rejects.toMatchObject({
      code: 'ARTIFACT_HASH_MISMATCH',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('manifest 的 taskId 与 Run 不一致 → VALIDATION_FAILED（fail-closed）', async () => {
    const h = makeHarness({ manifest: [ENTRY], manifestTaskId: randomUUID() })
    await expect(h.manager.prepare(RUN_ID, TASK_ID)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('manifest 请求失败 → 404 折算 NOT_FOUND，不写任何副本', async () => {
    const h = makeHarness({ manifestError: 404 })
    await expect(h.manager.prepare(RUN_ID, TASK_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('manifest 超限（#64）：Hub 409 + ARTIFACT_INPUT_MANIFEST_TOO_LARGE 显式码透传，不写副本', async () => {
    const h = makeHarness({
      manifestError: 409,
      manifestErrorBody: JSON.stringify({
        ok: false,
        error: {
          code: 'ARTIFACT_INPUT_MANIFEST_TOO_LARGE',
          message: 'task has more than 64 published artifacts; reviewer input manifest refused',
          requestId: 'req-manifest-limit',
        },
      }),
    })
    // 拒绝码必须是 Hub 的专用码本身（不是折算的 INTERNAL_ERROR）：run.start
    // ack 的 error.code 透传它，语义显式可归因。
    await expect(h.manager.prepare(RUN_ID, TASK_ID)).rejects.toMatchObject({
      code: 'ARTIFACT_INPUT_MANIFEST_TOO_LARGE',
    })
    expect(existsSync(join(inputsRoot, RUN_ID))).toBe(false)
  })

  it('manifest 超限但 body 不是已知 envelope（旧 Node 对新 Hub）→ 409 折算 CONFLICT', async () => {
    const h = makeHarness({ manifestError: 409, manifestErrorBody: 'nope' })
    await expect(h.manager.prepare(RUN_ID, TASK_ID)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('cleanup 删除该 run 的输入目录', async () => {
    const h = makeHarness({ manifest: [ENTRY], content: Buffer.from(CONTENT) })
    const prepared = await h.manager.prepare(RUN_ID, TASK_ID)
    expect(existsSync(prepared.dir)).toBe(true)
    await h.manager.cleanup(RUN_ID)
    expect(existsSync(prepared.dir)).toBe(false)
  })
})
