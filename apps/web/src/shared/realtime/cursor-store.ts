/**
 * P1-08 内存型 Team Event cursor（02 Task 8 Step 5）。
 *
 * 只存内存、不落 localStorage：页面刷新后从 0 重放保留窗口即可，无需持久化。
 * commit 只接受非负十进制字符串并保持单调；resync 后由 socket 重置为 '0'。
 */
const CURSOR_PATTERN = /^\d+$/

export class CursorStore {
  private value = '0'

  load(): string {
    return this.value
  }

  /**
   * 成功后提交：非单调或非法 cursor 忽略（服务端只下发递增 cursor；防御本地时序乱）。
   */
  commit(cursor: string): void {
    if (!CURSOR_PATTERN.test(cursor)) return
    if (this.value === '0' || this.compare(cursor, this.value) > 0) this.value = cursor
  }

  /** resync 后放弃本地光标：下一次连接重放 24h 保留窗口。 */
  reset(): void {
    this.value = '0'
  }

  private compare(a: string, b: string): number {
    // bigint cursor 可能超 Number.MAX_SAFE_INTEGER：按十进制字符串逐位比较。
    const paddedA = a.padStart(Math.max(a.length, b.length), '0')
    const paddedB = b.padStart(Math.max(a.length, b.length), '0')
    return paddedA === paddedB ? 0 : paddedA < paddedB ? -1 : 1
  }
}
