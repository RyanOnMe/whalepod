/**
 * Office 只读 PDF 预览派生（#431；ADR-0021 §2「预览绑定」）。
 *
 * 自动转换因缺少可验证隔离而暂停；Node 只登记 ISOLATION_REQUIRED。
 * 原件采集、下载与整件批注继续工作。后续隔离实现的边界：
 * - 转换输入只来自本次上传的字节（staging 副本），不重新读工作区文件——原件在
 *   上传后变化不会让预览挂到错误的摘要上；
 * - 转换失败/超时/二进制缺失只登记失败原因，绝不影响原件采集与交付；
 * - 结构化日志不带绝对路径、不携带 soffice stderr（可能含本机路径）。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ARTIFACT_PREVIEW_MAX_BYTES } from '@whalepod/protocol'

/** 第一阶段只预览 OpenXML 三件套；其他格式走下载回退。 */
const OFFICE_PREVIEW_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
])

export function supportsOfficePreview(mediaType: string): boolean {
  return officeExtensionFor(mediaType) !== undefined
}

export function officeExtensionFor(mediaType: string): string | undefined {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return OFFICE_PREVIEW_EXTENSIONS.get(base)
}

export type OfficePreviewFailureCode =
  | 'ISOLATION_REQUIRED'
  | 'CONVERTER_UNAVAILABLE'
  | 'CONVERT_TIMEOUT'
  | 'CONVERT_FAILED'
  | 'PREVIEW_TOO_LARGE'

export class OfficePreviewError extends Error {
  constructor(readonly code: OfficePreviewFailureCode) {
    super(code)
    this.name = 'OfficePreviewError'
  }
}

export interface ConvertOfficeToPdfOptions {
  /** Legacy option retained for compatibility; it cannot enable unisolated conversion. */
  readonly sofficePath?: string
  /** Reserved for a future verified isolated converter; currently ignored. */
  readonly timeoutMs?: number
}

/**
 * Untrusted Office formats can resolve document-linked local files and URLs. A separate
 * LibreOffice profile is not a permission boundary. Until a verified isolated converter
 * exists, even direct calls fail before filesystem reads or process creation (ADR-0023).
 */
export async function convertOfficeToPdf(
  _sourcePath: string,
  _outputDir: string,
  _options: ConvertOfficeToPdfOptions = {},
): Promise<Buffer> {
  throw new OfficePreviewError('ISOLATION_REQUIRED')
}

export interface PreviewSource {
  readonly runId: string
  readonly artifactId: string
  readonly mediaType: string
  readonly sourceSha256: string
  readonly bytes: Buffer
}

export interface PreviewUploadMetadata {
  readonly sourceSha256: string
  readonly sha256: string
  readonly byteSize: number
  readonly converter: string
}

export interface PreviewFailureReport {
  readonly sourceSha256: string
  readonly converter: string
  readonly reason: string
}

export interface OfficePreviewGeneratorDeps {
  /** 上传派生 PDF（Hub PUT /node/artifacts/:artifactId/preview）。 */
  readonly upload: (
    artifactId: string,
    metadata: PreviewUploadMetadata,
    body: Buffer,
  ) => Promise<void>
  /** 登记转换失败（Hub POST .../preview-failure）。 */
  readonly reportFailure: (artifactId: string, report: PreviewFailureReport) => Promise<void>
  /** 临时目录根（每个 artifact 一个子目录，完成即清理）。 */
  readonly stagingDir: string
  readonly sofficePath?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** Unit-test seam only. Production CLI never injects a converter; automatic conversion is suspended. */
  readonly convert?: (sourcePath: string, outputDir: string) => Promise<Buffer>
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

const CONVERTER_NAME = 'libreoffice'

/**
 * 后台预览生成器。`generate` 不阻塞原件采集；同一 artifact 的并发调用共享同一个
 * Promise（重复候选事件不重复转 PDF）。
 */
export class OfficePreviewGenerator {
  private readonly deps: OfficePreviewGeneratorDeps
  private readonly maxBytes: number
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(deps: OfficePreviewGeneratorDeps) {
    this.deps = deps
    this.maxBytes = deps.maxBytes ?? ARTIFACT_PREVIEW_MAX_BYTES
  }

  generate(source: PreviewSource): Promise<void> {
    const existing = this.inFlight.get(source.artifactId)
    if (existing !== undefined) return existing
    const task = this.run(source).finally(() => {
      this.inFlight.delete(source.artifactId)
    })
    this.inFlight.set(source.artifactId, task)
    return task
  }

  private async run(source: PreviewSource): Promise<void> {
    const extension = officeExtensionFor(source.mediaType)
    if (extension === undefined) return
    // No input-format scanner is treated as an isolation boundary. Unknown bytes,
    // ZIP disguises, XML, ODF and valid OpenXML are all rejected by the default path.
    if (this.deps.convert === undefined) {
      await this.reportFailure(source, 'ISOLATION_REQUIRED')
      return
    }
    let workDir: string | undefined
    try {
      await mkdir(this.deps.stagingDir, { recursive: true })
      workDir = await mkdtemp(join(this.deps.stagingDir, 'preview-'))
      const sourcePath = join(workDir, `source.${extension}`)
      const outputDir = join(workDir, 'out')
      await writeFile(sourcePath, source.bytes)
      const bytes = await this.deps.convert(sourcePath, outputDir)
      if (bytes.byteLength > this.maxBytes) {
        await this.reportFailure(source, 'PREVIEW_TOO_LARGE')
        return
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await this.deps.upload(
        source.artifactId,
        {
          sourceSha256: source.sourceSha256,
          sha256,
          byteSize: bytes.byteLength,
          converter: CONVERTER_NAME,
        },
        bytes,
      )
      this.deps.log?.('info', 'artifact preview uploaded', {
        component: 'node.artifact',
        runId: source.runId,
        artifactId: source.artifactId,
        byteSize: bytes.byteLength,
      })
    } catch (error) {
      const code = error instanceof OfficePreviewError ? error.code : undefined
      if (code !== undefined) {
        await this.reportFailure(source, code)
      } else {
        // 上传网络故障等：预览暂缺即可，不把瞬时故障写成「转换失败」。
        this.deps.log?.('warn', 'artifact preview upload failed', {
          component: 'node.artifact',
          runId: source.runId,
          artifactId: source.artifactId,
          reason: error instanceof Error ? error.name : 'unknown',
        })
      }
    } finally {
      if (workDir !== undefined) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async reportFailure(source: PreviewSource, reason: string): Promise<void> {
    await this.deps
      .reportFailure(source.artifactId, {
        sourceSha256: source.sourceSha256,
        converter: this.deps.convert === undefined ? 'unknown' : CONVERTER_NAME,
        reason,
      })
      .catch((error: unknown) => {
        this.deps.log?.('warn', 'artifact preview failure report failed', {
          component: 'node.artifact',
          runId: source.runId,
          artifactId: source.artifactId,
          reason: error instanceof Error ? error.name : 'unknown',
        })
      })
  }
}
