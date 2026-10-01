/**
 * 交付物文本预览的资格与截断（#250；#243 第 3 条「交付物有脸」）。纯函数，供
 * ArtifactList 与单测共用。「不假装能预览」：非文本、超大一律不给预览，下载才是正路。
 */

/** 页内预览的拉取上限：超过它的文本不在页面里拉（下载兜底）。 */
export const PREVIEW_MAX_BYTES = 512 * 1024

/** 页内展示上限：超长内容截断展示，标注「已截断」。 */
const PREVIEW_DISPLAY_CHARS = 64 * 1024

/**
 * 能否页内预览：text/* 与 json/xml 族（含 +json/+xml 结构化后缀），且体积在上限内。
 * 二进制（图片/PDF/zip/八进制流）恒 false——「有脸」不等于「什么都硬塞进 <pre>」。
 */
export function isTextPreviewable(mediaType: string, byteSize: number): boolean {
  if (byteSize > PREVIEW_MAX_BYTES) return false
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base.startsWith('text/')) return true
  return (
    base === 'application/json' ||
    base === 'application/xml' ||
    (base.startsWith('application/') && (base.endsWith('+json') || base.endsWith('+xml')))
  )
}

/** 展示截断：64KiB 以内原样；超出截断并标注。 */
export function truncatePreview(text: string): { text: string; truncated: boolean } {
  if (text.length <= PREVIEW_DISPLAY_CHARS) return { text, truncated: false }
  return { text: text.slice(0, PREVIEW_DISPLAY_CHARS), truncated: true }
}
