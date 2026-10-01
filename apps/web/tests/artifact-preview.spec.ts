/**
 * 文本预览资格判定（#250；#243 第 3 条「交付物有脸」）纯函数判据。
 * 「不假装能预览」：非文本、超大一律不给预览——下载才是它们的正路。
 */
import { describe, expect, it } from 'vitest'
import { isTextPreviewable, truncatePreview } from '../src/features/task/artifactPreview.js'

describe('isTextPreviewable', () => {
  it('text/* 与 json/xml 族可预览', () => {
    expect(isTextPreviewable('text/markdown', 1024)).toBe(true)
    expect(isTextPreviewable('text/plain; charset=utf-8', 1024)).toBe(true)
    expect(isTextPreviewable('application/json', 1024)).toBe(true)
    expect(isTextPreviewable('application/geo+json', 1024)).toBe(true)
    expect(isTextPreviewable('application/xml', 1024)).toBe(true)
  })

  it('二进制不预览（图片/压缩包/八进制流）', () => {
    expect(isTextPreviewable('image/png', 1024)).toBe(false)
    expect(isTextPreviewable('application/pdf', 1024)).toBe(false)
    expect(isTextPreviewable('application/octet-stream', 1024)).toBe(false)
    expect(isTextPreviewable('application/zip', 1024)).toBe(false)
  })

  it('超 512KiB 的文本也不预览（页内不拉大文件，下载兜底）', () => {
    expect(isTextPreviewable('text/markdown', 512 * 1024)).toBe(true) // 恰好等于：可以
    expect(isTextPreviewable('text/markdown', 512 * 1024 + 1)).toBe(false)
  })
})

describe('truncatePreview', () => {
  it('64KiB 以内原样；超出截断并标注', () => {
    const small = 'x'.repeat(1000)
    expect(truncatePreview(small)).toEqual({ text: small, truncated: false })
    const big = 'x'.repeat(70_000)
    const result = truncatePreview(big)
    expect(result.text.length).toBeLessThan(big.length)
    expect(result.truncated).toBe(true)
  })
})
