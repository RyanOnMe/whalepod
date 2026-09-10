/**
 * 内容寻址 Artifact Store 单测（P1-15；03 §2.6 storage_key 规则、04 §6.3）。
 *
 * 判定基线（G6-03 的存储半场）：
 * - 上传成功：字节按 `sha256/ab/cd/<digest>` 内容寻址落位；临时目录清空。
 * - hash 不匹配：拒绝（ARTIFACT_HASH_MISMATCH）、临时文件删除、无 blob 落位。
 * - 超限：拒绝（ARTIFACT_TOO_LARGE）、临时文件删除、无 blob 落位。
 * - 下载：磁盘字节与 DB metadata digest 不一致必须失败（§6.3 下载校验行）。
 * - 同内容只存一份 blob（03 §2.6「同一 SHA-256 只存一份」）。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore, ArtifactStoreError } from '../src/modules/artifact/store.js'

let root: string
let store: ArtifactStore

const CONTENT = 'artifact payload 0123456789\n'
const DIGEST = createHash('sha256').update(CONTENT).digest('hex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-artifact-store-'))
  store = new ArtifactStore({ root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function tmpCount(): Promise<number> {
  const entries = await readdir(join(root, 'tmp')).catch(() => [] as string[])
  return entries.length
}

describe('ArtifactStore.saveUpload', () => {
  it('stores content at sha256/ab/cd/<digest> and clears the temp file', async () => {
    const blob = await store.saveUpload(DIGEST, Buffer.from(CONTENT))
    expect(blob.sha256).toBe(DIGEST)
    expect(blob.byteSize).toBe(CONTENT.length)
    expect(blob.storageKey).toBe(`sha256/${DIGEST.slice(0, 2)}/${DIGEST.slice(2, 4)}/${DIGEST}`)
    const stored = await readFile(join(root, blob.storageKey))
    expect(stored.toString()).toBe(CONTENT)
    expect(await tmpCount()).toBe(0)
  })

  it('rejects a hash mismatch: no blob, temp file removed (G6-03 存储半场)', async () => {
    const wrong = 'a'.repeat(64)
    await expect(store.saveUpload(wrong, Buffer.from(CONTENT))).rejects.toBeInstanceOf(
      ArtifactStoreError,
    )
    await expect(store.saveUpload(wrong, Buffer.from(CONTENT))).rejects.toMatchObject({
      code: 'ARTIFACT_HASH_MISMATCH',
    })
    // 内容寻址树里没有该 digest 的落位。
    expect(existsSync(join(root, 'sha256', wrong.slice(0, 2)))).toBe(false)
    expect(await tmpCount()).toBe(0)
  })

  it('rejects oversize content: no blob, temp file removed', async () => {
    const tight = new ArtifactStore({ root, maxBytes: 8 })
    await expect(tight.saveUpload(DIGEST, Buffer.from(CONTENT))).rejects.toMatchObject({
      code: 'ARTIFACT_TOO_LARGE',
    })
    expect(await tmpCount()).toBe(0)
    expect(existsSync(join(root, 'sha256', DIGEST.slice(0, 2)))).toBe(false)
  })

  it('keeps a single blob for identical content saved twice', async () => {
    await store.saveUpload(DIGEST, Buffer.from(CONTENT))
    await store.saveUpload(DIGEST, Buffer.from(CONTENT))
    const buckets = await readdir(join(root, 'sha256', DIGEST.slice(0, 2), DIGEST.slice(2, 4)))
    expect(buckets).toEqual([DIGEST])
  })
})

describe('ArtifactStore.readVerified', () => {
  it('returns the exact bytes for a matching digest', async () => {
    const blob = await store.saveUpload(DIGEST, Buffer.from(CONTENT))
    const bytes = await store.readVerified(blob.storageKey, DIGEST)
    expect(bytes.toString()).toBe(CONTENT)
  })

  it('fails when the disk bytes no longer match the DB digest (§6.3)', async () => {
    const blob = await store.saveUpload(DIGEST, Buffer.from(CONTENT))
    const path = join(root, blob.storageKey)
    await writeFile(path, Buffer.from(CONTENT.replace('0', '1')))
    await expect(store.readVerified(blob.storageKey, DIGEST)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    })
  })

  it('fails on a missing blob (storage lost, metadata present)', async () => {
    await mkdir(join(root, 'sha256', 'aa', 'bb'), { recursive: true })
    await expect(
      store.readVerified('sha256/aa/bb/' + 'b'.repeat(64), 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
