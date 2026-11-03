/** ADR-0028：收件箱标题/正文的共用上限，避免入口准入与显式关联各写一套。 */
export const WORK_INBOX_TITLE_MAX = 200
export const WORK_INBOX_BODY_MAX_BYTES = 65_536

/** 按码点累积、按 UTF-16 长度封顶：不切代理对，也不超过 view schema 的 200。 */
export function clampWorkTitle(title: string, fallback: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return fallback
  let result = ''
  for (const character of Array.from(trimmed)) {
    if (result.length + character.length > WORK_INBOX_TITLE_MAX) break
    result += character
  }
  return result
}
