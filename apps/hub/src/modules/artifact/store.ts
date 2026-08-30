/**
 * 本地内容寻址 Artifact Store（P1-15；03 §2.6、04 §6.3）。
 *
 * - 布局：`<root>/sha256/ab/cd/<digest>`（storage_key 规则 03 §2.6）；同内容
 *   只存一份 blob（原子 rename 去重）。临时文件统一落 `<root>/tmp`（与 blob
 *   同一文件系统，rename 原子），校验失败/超限即删，不残留（G6-03 证据）。
 * - hash/size 双验证：入站（declared vs 实收）在 saveUpload，出站（DB metadata
 *   vs 磁盘）在 readVerified——「Artifact 下载必须校验 DB metadata 与磁盘
 *   digest」（04 §6.3）。
 * - 本模块不碰 DB、不做权限判定：那是 artifact 模块路由层的事。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError } from '../shared/http-error.js'

/** 第一阶段单文件上限：50 MiB（02 Global Constraints）。 */
export const ARTIFACT_MAX_BYTES = 52_428_800

/**
 * Store 故障 = 可映射的 ApiError（app 级错误处理统一上 envelope）：
 * 声明与实收不一致 → 400 ARTIFACT_HASH_MISMATCH；超限 → 413
 * ARTIFACT_TOO_LARGE；存储自身故障 → 500 INTERNAL_ERROR。
 */
export class ArtifactStoreError extends ApiError {}

export interface StoredBlob {
  readonly sha256: string
  readonly byteSize: number
  readonly storageKey: string
}

export interface ArtifactStoreOptions {
  /** 存储根目录（blob 树 + tmp），由组合根注入（生产配置 / 测试临时目录）。 */
  readonly root: string
  readonly maxBytes?: number
  /** 结构化日志 sink（component=artifact.store）。 */
  readonly log?: (record: Record<string, unknown>) => void
}

export function storageKeyFor(sha256: string): string {
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`
}

export class ArtifactStore {
  private readonly root: string
  private readonly maxBytes: number
  private readonly log: (record: Record<string, unknown>) => void

  constructor(options: ArtifactStoreOptions) {
    this.root = options.root
    this.maxBytes = options.maxBytes ?? ARTIFACT_MAX_BYTES
    this.log = options.log ?? (() => {})
  }

  /** 内容寻址落位前的流式接收：临时文件 + 计数 + hash。 */
  async saveUpload(expectedSha256: string, content: Uint8Array): Promise<StoredBlob> {
    const tmpDir = join(this.root, 'tmp')
    await mkdir(tmpDir, { recursive: true })
    const tmpPath = join(tmpDir, randomUUID())
    try {
      const hash = createHash('sha256')
      hash.update(content)
      const actual = hash.digest('hex')
      if (content.byteLength > this.maxBytes) {
        throw new ArtifactStoreError(
          413,
          'ARTIFACT_TOO_LARGE',
          'artifact content exceeds the size limit',
        )
      }
      if (actual !== expectedSha256) {
        throw new ArtifactStoreError(
          400,
          'ARTIFACT_HASH_MISMATCH',
          'artifact content does not match the declared sha256',
        )
      }
      const storageKey = storageKeyFor(actual)
      const target = join(this.root, storageKey)
      await writeFile(tmpPath, content)
      await mkdir(join(this.root, 'sha256', actual.slice(0, 2), actual.slice(2, 4)), {
        recursive: true,
      })
      // 同内容并发/重传：rename 原子覆盖（字节相同，去重成立）。
      await rename(tmpPath, target)
      this.log({
        level: 'info',
        component: 'artifact.store',
        msg: 'blob stored',
        sha256: actual,
        byteSize: content.byteLength,
      })
      return { sha256: actual, byteSize: content.byteLength, storageKey }
    } catch (error) {
      // 任何失败路径都清临时文件（G6-03：临时文件删除）。目标 blob 已落位时
      // （rename 成功后 readVerified 才可能失败）不删内容寻址 blob。
      await rm(tmpPath, { force: true })
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError(500, 'INTERNAL_ERROR', 'artifact store write failed')
    }
  }

  /**
   * 下载读取：磁盘字节与 metadata digest 复核后返回；不一致按服务端完整性
   * 故障处理（INTERNAL_ERROR，结构化日志 component=artifact.store），绝不把
   * 未验证字节发给请求方。
   */
  async readVerified(storageKey: string, expectedSha256: string): Promise<Buffer> {
    const path = join(this.root, storageKey)
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      this.log({
        level: 'error',
        component: 'artifact.store',
        msg: 'blob missing for verified read',
        storageKey,
      })
      throw new ArtifactStoreError(500, 'INTERNAL_ERROR', 'artifact content unavailable')
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expectedSha256) {
      this.log({
        level: 'error',
        component: 'artifact.store',
        msg: 'stored blob digest mismatch',
        storageKey,
      })
      throw new ArtifactStoreError(
        500,
        'INTERNAL_ERROR',
        'artifact content failed integrity verification',
      )
    }
    return bytes
  }

  /** 磁盘 blob 实际大小（下载 Content-Length 用；缺失返回 undefined）。 */
  async sizeOf(storageKey: string): Promise<number | undefined> {
    try {
      const stats = await stat(join(this.root, storageKey))
      return stats.size
    } catch {
      return undefined
    }
  }
}
