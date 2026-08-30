/**
 * Node Artifact 采集器（P1-15；03 §12「realpath + hash + upload」、04 §6.3）。
 *
 * Runtime 发出 artifact.candidate（相对路径）后，由本模块完成权威采集：
 * 1. 字面拒绝（绝对路径/NUL/resolve 越界）→ ARTIFACT_PATH_OUTSIDE_WORKSPACE；
 * 2. realpath 解析 symlink 后复验边界（canonical 被采用；逃逸同上码）；
 * 3. 常规文件 + 大小上限（读入后再验一次，覆盖 stat 与 read 之间的增长窗口）；
 * 4. staging 临时副本落盘（副本=上传字节=被 hash 字节，三同一源——Hub 再做
 *    声明比对兜底）；无论成败副本即清理（G6-03 证据）。
 *
 * 红线：结构化日志与错误消息不携带绝对路径（只带 runId/相对路径/错误码）。
 * 边界语义复用 workspace/path-policy（同一 realpath 边界规则的 Node 侧事实源），
 * attack corpus 与 packages/runtime-dsh/tests/artifact-tool.spec.ts 镜像防漂移。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { isInsideWorkspace } from '../workspace/path-policy.js'

/** 第一阶段单文件上限：50 MiB（02 Global Constraints）。 */
export const ARTIFACT_MAX_BYTES = 52_428_800

/** 采集失败分类（结构化观测用；不在 wire 上直接传输）。 */
export type ArtifactCollectErrorCode =
  | 'ARTIFACT_PATH_OUTSIDE_WORKSPACE'
  | 'ARTIFACT_TOO_LARGE'
  | 'ARTIFACT_SOURCE_UNAVAILABLE'
  | 'ARTIFACT_UPLOAD_FAILED'

export class ArtifactCollectError extends Error {
  constructor(
    readonly code: ArtifactCollectErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactCollectError'
  }
}

export interface CollectCandidate {
  readonly relativePath: string
  readonly title: string
  readonly mediaType: string
}

export interface UploadPayload {
  readonly title: string
  readonly mediaType: string
  readonly sha256: string
  readonly byteSize: number
  readonly sourceRelativePath: string
}

export interface CollectedArtifact {
  readonly artifactId: string
  readonly sha256: string
  readonly byteSize: number
  readonly sourceRelativePath: string
}

export interface ArtifactCollectorDeps {
  /** 临时副本目录（RunManager 侧按 stateDir 派生）。 */
  readonly stagingDir: string
  /** 上传客户端（fetch → Hub POST /node/runs/:runId/artifacts）。 */
  readonly upload: (
    runId: string,
    payload: UploadPayload,
    body: Buffer,
  ) => Promise<{ artifactId: string }>
  readonly maxBytes?: number
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

export class ArtifactCollector {
  private readonly stagingDir: string
  private readonly upload: ArtifactCollectorDeps['upload']
  private readonly maxBytes: number
  private readonly log: ArtifactCollectorDeps['log']

  constructor(deps: ArtifactCollectorDeps) {
    this.stagingDir = deps.stagingDir
    this.upload = deps.upload
    this.maxBytes = deps.maxBytes ?? ARTIFACT_MAX_BYTES
    this.log = deps.log ?? (() => {})
  }

  /** Runtime 候选 → 权威校验 → staging 副本 + hash → 上传。拒绝时绝不上传。 */
  async collect(
    runId: string,
    candidate: CollectCandidate,
    workspacePath: string,
  ): Promise<CollectedArtifact> {
    // 1) 字面拒绝（不触 IO）：空值/NUL/绝对路径（含 Windows 盘符形）/resolve 越界。
    const relativePath = candidate.relativePath
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new ArtifactCollectError(
        'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
        'artifact relativePath must be a non-empty workspace-relative path',
      )
    }
    if (
      relativePath.includes('\0') ||
      isAbsolute(relativePath) ||
      /^[A-Za-z]:[\\/]/.test(relativePath)
    ) {
      throw new ArtifactCollectError(
        'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
        'artifact relativePath must be workspace-relative and path-safe',
      )
    }
    if (!isInsideWorkspace(workspacePath, relativePath)) {
      throw new ArtifactCollectError(
        'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
        'artifact relativePath escapes the workspace boundary',
      )
    }
    // 根先 canonical（macOS /var → /private/var 类 symlink 根会让候选 canonical
    // 的边界复验误判；生产路径常已 canonical，这里兜底归一）。
    let canonicalRoot = workspacePath
    try {
      canonicalRoot = await realpath(workspacePath)
    } catch {
      throw new ArtifactCollectError(
        'ARTIFACT_SOURCE_UNAVAILABLE',
        'workspace root is not available for artifact collection',
      )
    }
    // 2) realpath 后复验边界（symlink 链一起解析；canonical 被采用，G3-06 同语义）。
    let canonical: string
    try {
      canonical = await realpath(resolve(workspacePath, relativePath))
    } catch {
      throw new ArtifactCollectError(
        'ARTIFACT_SOURCE_UNAVAILABLE',
        'artifact source file does not exist inside the workspace',
      )
    }
    if (!isInsideWorkspace(canonicalRoot, canonical)) {
      throw new ArtifactCollectError(
        'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
        'artifact source resolves outside the workspace boundary',
      )
    }
    // 3) 常规文件 + 大小上限。
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(canonical)
    } catch {
      throw new ArtifactCollectError(
        'ARTIFACT_SOURCE_UNAVAILABLE',
        'artifact source file is not readable',
      )
    }
    if (!stats.isFile()) {
      throw new ArtifactCollectError(
        'ARTIFACT_SOURCE_UNAVAILABLE',
        'artifact source must be a regular file',
      )
    }
    if (stats.size > this.maxBytes) {
      throw new ArtifactCollectError(
        'ARTIFACT_TOO_LARGE',
        `artifact source exceeds the ${this.maxBytes} byte limit`,
      )
    }
    // 4) 读入（≤50 MiB 上界）+ 复验 + 副本落盘 + hash；同一 Buffer 三处同源。
    let bytes: Buffer
    try {
      bytes = await readFile(canonical)
    } catch {
      throw new ArtifactCollectError(
        'ARTIFACT_SOURCE_UNAVAILABLE',
        'artifact source file is not readable',
      )
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new ArtifactCollectError(
        'ARTIFACT_TOO_LARGE',
        `artifact source exceeds the ${this.maxBytes} byte limit`,
      )
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await mkdir(this.stagingDir, { recursive: true })
    const tmpPath = resolve(this.stagingDir, randomUUID())
    try {
      await writeFile(tmpPath, bytes)
      // 5) 上传（注入客户端处理重试/错误映射）。
      const { artifactId } = await this.upload(
        runId,
        {
          title: candidate.title,
          mediaType: candidate.mediaType,
          sha256,
          byteSize: bytes.byteLength,
          sourceRelativePath: relativePath,
        },
        bytes,
      )
      this.log?.('info', 'artifact candidate uploaded', {
        component: 'node.artifact',
        runId,
        artifactId,
        sha256,
        byteSize: bytes.byteLength,
      })
      return {
        artifactId,
        sha256,
        byteSize: bytes.byteLength,
        sourceRelativePath: relativePath,
      }
    } catch (error) {
      if (error instanceof ArtifactCollectError) throw error
      throw new ArtifactCollectError(
        'ARTIFACT_UPLOAD_FAILED',
        error instanceof Error ? error.message : 'artifact upload failed',
      )
    } finally {
      await unlink(tmpPath).catch(() => {})
    }
  }
}
