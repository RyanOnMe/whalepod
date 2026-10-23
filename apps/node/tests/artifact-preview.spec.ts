/**
 * Office 只读预览派生（#431）Node 单测。
 *
 * 判定基线：
 * - 只有 DOCX/XLSX/PPTX 触发转换；其他格式不产生派生件；
 * - 转换成功 → 上传的字节与摘要一致，失败/超时只登记稳定原因码；
 * - 上传网络故障不写成「转换失败」；同一 artifact 的并发调用只转一次；
 * - 转换命令与输出目录隔离（每次独立 profile），真实 soffice 可用时再做一次烟测。
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OfficePreviewError,
  OfficePreviewGenerator,
  convertOfficeToPdf,
  officeExtensionFor,
  supportsOfficePreview,
  type PreviewFailureReport,
  type PreviewUploadMetadata,
} from '../src/artifact/preview.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const PDF = Buffer.from('%PDF-1.7\npreview-bytes\n')

function hasSoffice(): boolean {
  try {
    execFileSync(process.env.WHALEPOD_SOFFICE ?? 'soffice', ['--version'], {
      stdio: 'ignore',
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

const HAS_SOFFICE = hasSoffice()

let root: string
let staging: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whalepod-preview-'))
  staging = join(root, 'previews')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Harness {
  generator: OfficePreviewGenerator
  uploads: Array<{ artifactId: string; metadata: PreviewUploadMetadata; body: Buffer }>
  failures: Array<{ artifactId: string; report: PreviewFailureReport }>
  conversions: number
  logs: Array<{ level: string; msg: string }>
}

function makeHarness(
  convert: (sourcePath: string, outputDir: string) => Promise<Buffer>,
  overrides: { upload?: () => Promise<void> } = {},
): Harness {
  const h: Harness = {
    generator: undefined as unknown as OfficePreviewGenerator,
    uploads: [],
    failures: [],
    conversions: 0,
    logs: [],
  }
  h.generator = new OfficePreviewGenerator({
    stagingDir: staging,
    convert: async (sourcePath, outputDir) => {
      h.conversions += 1
      return convert(sourcePath, outputDir)
    },
    upload: async (artifactId, metadata, body) => {
      if (overrides.upload !== undefined) await overrides.upload()
      h.uploads.push({ artifactId, metadata, body })
    },
    reportFailure: async (artifactId, report) => {
      h.failures.push({ artifactId, report })
    },
    log: (level, msg) => {
      h.logs.push({ level, msg })
    },
  })
  return h
}

function source(overrides: Partial<Parameters<OfficePreviewGenerator['generate']>[0]> = {}) {
  const bytes = Buffer.from('fake office bytes')
  return {
    runId: 'run-1',
    artifactId: 'artifact-1',
    mediaType: DOCX,
    sourceSha256: sha256(bytes),
    bytes,
    ...overrides,
  }
}

describe('#431 预览格式判定', () => {
  it('只识别 OpenXML 三件套，大小写/参数不影响', () => {
    expect(supportsOfficePreview(DOCX)).toBe(true)
    expect(supportsOfficePreview(XLSX)).toBe(true)
    expect(supportsOfficePreview(PPTX)).toBe(true)
    expect(supportsOfficePreview(`${DOCX.toUpperCase()}; charset=binary`)).toBe(true)
    expect(supportsOfficePreview('application/pdf')).toBe(false)
    expect(supportsOfficePreview('text/markdown')).toBe(false)
    expect(officeExtensionFor(DOCX)).toBe('docx')
    expect(officeExtensionFor(XLSX)).toBe('xlsx')
    expect(officeExtensionFor(PPTX)).toBe('pptx')
    expect(officeExtensionFor('application/pdf')).toBeUndefined()
  })
})

describe('#431 OfficePreviewGenerator', () => {
  it('转换成功：上传 PDF 摘要/大小/转换器与原件摘要绑定，临时目录清理', async () => {
    const h = makeHarness(async (_sourcePath, outputDir) => {
      // 真实转换器会在 outputDir 生成 PDF；这里返回其字节即可。
      await mkdir(outputDir, { recursive: true })
      return PDF
    })
    const input = source()
    await h.generator.generate(input)
    expect(h.conversions).toBe(1)
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0]?.artifactId).toBe(input.artifactId)
    expect(h.uploads[0]?.metadata).toEqual({
      sourceSha256: input.sourceSha256,
      sha256: sha256(PDF),
      byteSize: PDF.byteLength,
      converter: 'libreoffice',
    })
    expect(h.uploads[0]?.body.equals(PDF)).toBe(true)
    expect(h.failures).toHaveLength(0)
    expect(existsSync(staging) ? await readdir(staging) : []).toHaveLength(0)
  })

  it('非 Office 媒体类型不转换、不上传', async () => {
    const h = makeHarness(async () => PDF)
    await h.generator.generate(source({ mediaType: 'application/pdf' }))
    expect(h.conversions).toBe(0)
    expect(h.uploads).toHaveLength(0)
    expect(h.failures).toHaveLength(0)
  })

  it('转换器缺失/超时/失败 → 只登记稳定原因码，不上传', async () => {
    for (const code of ['CONVERTER_UNAVAILABLE', 'CONVERT_TIMEOUT', 'CONVERT_FAILED'] as const) {
      const h = makeHarness(async () => {
        throw new OfficePreviewError(code)
      })
      await h.generator.generate(source())
      expect(h.uploads).toHaveLength(0)
      expect(h.failures).toEqual([
        {
          artifactId: 'artifact-1',
          report: {
            sourceSha256: sha256(Buffer.from('fake office bytes')),
            converter: 'libreoffice',
            reason: code,
          },
        },
      ])
    }
  })

  it('PDF 超过上限 → PREVIEW_TOO_LARGE，不上传', async () => {
    const h = makeHarness(async () => PDF)
    const generator = new OfficePreviewGenerator({
      stagingDir: staging,
      maxBytes: 4,
      convert: async () => PDF,
      upload: async () => {
        throw new Error('must not upload')
      },
      reportFailure: async (artifactId, report) => {
        h.failures.push({ artifactId, report })
      },
    })
    await generator.generate(source())
    expect(h.failures[0]?.report.reason).toBe('PREVIEW_TOO_LARGE')
  })

  it('上传网络故障不写成转换失败，仅告警', async () => {
    const h = makeHarness(async () => PDF, {
      upload: async () => {
        throw new Error('network down')
      },
    })
    await h.generator.generate(source())
    expect(h.failures).toHaveLength(0)
    expect(h.logs.some((entry) => entry.msg === 'artifact preview upload failed')).toBe(true)
  })

  it('同一 artifact 的并发 generate 共享一次转换', async () => {
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const h = makeHarness(async () => {
      markStarted?.()
      await gate
      return PDF
    })
    const first = h.generator.generate(source())
    const second = h.generator.generate(source())
    await started
    expect(h.conversions).toBe(1)
    release?.()
    await Promise.all([first, second])
    expect(h.uploads).toHaveLength(1)
  })

  it('失败上报本身失败也不抛出（预览缺失即可，不影响原件）', async () => {
    const generator = new OfficePreviewGenerator({
      stagingDir: staging,
      convert: async () => {
        throw new OfficePreviewError('CONVERT_FAILED')
      },
      upload: async () => {},
      reportFailure: async () => {
        throw new Error('hub down')
      },
    })
    await expect(generator.generate(source())).resolves.toBeUndefined()
  })
})

describe('#431 convertOfficeToPdf', () => {
  it.skipIf(!HAS_SOFFICE)(
    '用真实 soffice 把 DOCX 转成 PDF（无转换器时跳过）',
    async () => {
      const sourceDir = join(root, 'office')
      const outDir = join(root, 'pdf')
      await mkdir(sourceDir, { recursive: true })
      // 先用 soffice 从最小 HTML 造一份真实 DOCX（不引入二进制 fixture）。
      const htmlPath = join(sourceDir, 'sample.html')
      await writeFile(htmlPath, '<html><body><h1>WhalePod preview</h1><p>hello</p></body></html>')
      const soffice = process.env.WHALEPOD_SOFFICE ?? 'soffice'
      await promisify(execFile)(
        soffice,
        ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', sourceDir, htmlPath],
        { timeout: 120_000 },
      )
      const docxPath = join(sourceDir, 'sample.docx')
      expect(existsSync(docxPath)).toBe(true)
      const pdf = await convertOfficeToPdf(docxPath, outDir)
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdf.byteLength).toBeGreaterThan(0)
    },
    180_000,
  )

  it('soffice 不存在 → CONVERTER_UNAVAILABLE（稳定码，不带本机路径）', async () => {
    await expect(
      convertOfficeToPdf('/nonexistent/source.docx', join(root, 'out'), {
        sofficePath: join(root, 'missing-soffice'),
      }),
    ).rejects.toMatchObject({ code: 'CONVERTER_UNAVAILABLE' })
  })

  it('输出目录里没有 PDF → CONVERT_FAILED', async () => {
    const bin = join(root, 'fake-soffice')
    await writeFile(bin, '#!/bin/sh\nexit 0\n')
    await chmod(bin, 0o755)
    await expect(
      convertOfficeToPdf(join(root, 'in.docx'), join(root, 'out-empty'), { sofficePath: bin }),
    ).rejects.toMatchObject({ code: 'CONVERT_FAILED' })
  })
})
