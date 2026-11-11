import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MANAGED_DRAFT_MAX_CONTENT_BYTES } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'

const digestPattern = /^[a-f0-9]{64}$/
const unavailable = () => new ApiError(500, 'INTERNAL_ERROR', 'managed draft storage unavailable')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Separate namespace and file permissions; the ordinary Artifact Store cannot open these keys. */
export function managedDraftCandidateStore(artifactStoreDir: string): ManagedDraftCandidateStore {
  return new ManagedDraftCandidateStore(join(artifactStoreDir, 'managed-drafts'))
}

export class ManagedDraftCandidateStore {
  constructor(private readonly root: string) {}

  private async ensurePrivateRoot(): Promise<void> {
    const info = await lstat(this.root)
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw unavailable()
  }

  async saveUpload(expectedSha256: string, bytes: Buffer): Promise<string> {
    if (
      !digestPattern.test(expectedSha256) ||
      bytes.length < 1 ||
      bytes.length > MANAGED_DRAFT_MAX_CONTENT_BYTES ||
      digest(bytes) !== expectedSha256
    )
      throw unavailable()
    const pending = join(this.root, randomUUID())
    let temporaryFileCreated = false
    try {
      await mkdir(this.root, { mode: 0o700, recursive: true })
      await this.ensurePrivateRoot()
      const handle = await open(pending, 'wx', 0o600)
      temporaryFileCreated = true
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(pending, join(this.root, expectedSha256))
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      return expectedSha256
    } catch {
      throw unavailable()
    } finally {
      if (temporaryFileCreated) await rm(pending, { force: true }).catch(() => {})
    }
  }

  async readVerified(storageKey: string, expectedSha256: string): Promise<Buffer> {
    if (storageKey !== expectedSha256 || !digestPattern.test(storageKey)) throw unavailable()
    try {
      await this.ensurePrivateRoot()
      const handle = await open(
        join(this.root, storageKey),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const info = await handle.stat()
        if (
          !info.isFile() ||
          (info.mode & 0o077) !== 0 ||
          info.size < 1 ||
          info.size > MANAGED_DRAFT_MAX_CONTENT_BYTES
        )
          throw unavailable()
        const bytes = Buffer.alloc(info.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        const content = bytes.subarray(0, offset)
        if (offset !== info.size || digest(content) !== expectedSha256) throw unavailable()
        return content
      } finally {
        await handle.close()
      }
    } catch {
      throw unavailable()
    }
  }
}
