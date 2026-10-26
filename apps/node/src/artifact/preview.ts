/**
 * Office 只读 PDF 预览派生（#431；ADR-0021 §2「预览绑定」）。
 *
 * Node 在原件采集成功后，用 LibreOffice 无头模式把 DOCX/XLSX/PPTX 转成 PDF，
 * 再作为**派生阅读副本**上传给 Hub。边界：
 * - 转换输入只来自本次上传的字节（staging 副本），不重新读工作区文件——原件在
 *   上传后变化不会让预览挂到错误的摘要上；
 * - 转换失败/超时/二进制缺失只登记失败原因，绝不影响原件采集与交付；
 * - 结构化日志不带绝对路径、不携带 soffice stderr（可能含本机路径）。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ARTIFACT_PREVIEW_MAX_BYTES } from '@whalepod/protocol'

const execFileAsync = promisify(execFile)

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
  /** 默认 `WHALEPOD_SOFFICE` 或 PATH 上的 `soffice`（权限/路径由部署方负责）。 */
  readonly sofficePath?: string
  /** 单次转换上限；超时由 execFile 终止子进程。 */
  readonly timeoutMs?: number
}

const DEFAULT_CONVERT_TIMEOUT_MS = 120_000

/**
 * 调用 LibreOffice 把已落盘的 Office 文件转成 PDF。
 *
 * 每次转换使用独立 UserInstallation profile：并发转换不会抢同一个 profile 锁，
 * 也不读写用户的真实 LibreOffice 配置。
 */
export async function convertOfficeToPdf(
  sourcePath: string,
  outputDir: string,
  options: ConvertOfficeToPdfOptions = {},
): Promise<Buffer> {
  const sofficePath = options.sofficePath ?? process.env.WHALEPOD_SOFFICE ?? 'soffice'
  const timeout = options.timeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS
  await mkdir(outputDir, { recursive: true })
  const profileDir = await mkdtemp(join(tmpdir(), 'whalepod-soffice-profile-'))
  try {
    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--invisible',
      '--nodefault',
      '--nologo',
      '--norestore',
      '--nolockcheck',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      sourcePath,
    ]
    try {
      await execFileAsync(sofficePath, args, {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') throw new OfficePreviewError('CONVERTER_UNAVAILABLE')
      // execFile 超时后 error.killed=true；不同平台/版本的 code 不一致，用 killed
      // 与 signal 双判，避免把超时误报成普通转换失败。
      if (
        (error as { killed?: unknown }).killed === true ||
        (error as { signal?: unknown }).signal === 'SIGKILL'
      ) {
        throw new OfficePreviewError('CONVERT_TIMEOUT')
      }
      throw new OfficePreviewError('CONVERT_FAILED')
    }
    let pdfName: string | undefined
    try {
      pdfName = (await readdir(outputDir))
        .filter((name) => name.toLowerCase().endsWith('.pdf'))
        .sort()[0]
    } catch {
      throw new OfficePreviewError('CONVERT_FAILED')
    }
    if (pdfName === undefined) throw new OfficePreviewError('CONVERT_FAILED')
    let bytes: Buffer
    try {
      bytes = await readFile(join(outputDir, pdfName))
    } catch {
      throw new OfficePreviewError('CONVERT_FAILED')
    }
    if (bytes.byteLength === 0) throw new OfficePreviewError('CONVERT_FAILED')
    return bytes
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
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
  /** 测试注入点；默认走 convertOfficeToPdf。 */
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
    let workDir: string | undefined
    try {
      await mkdir(this.deps.stagingDir, { recursive: true })
      workDir = await mkdtemp(join(this.deps.stagingDir, 'preview-'))
      const sourcePath = join(workDir, `source.${extension}`)
      const outputDir = join(workDir, 'out')
      await writeFile(sourcePath, source.bytes)
      const bytes = await (this.deps.convert?.(sourcePath, outputDir) ??
        convertOfficeToPdf(sourcePath, outputDir, {
          ...(this.deps.sofficePath === undefined ? {} : { sofficePath: this.deps.sofficePath }),
          ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
        }))
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
        converter: CONVERTER_NAME,
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
