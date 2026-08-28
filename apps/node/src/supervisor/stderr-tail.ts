/**
 * stderr 末尾环（P1-12；02 Task 12 Step 6）：只保留末尾 8KiB 供 owner 诊断。
 */
const TAIL_LIMIT_BYTES = 8 * 1024

export class StderrTail {
  private buffer = ''

  push(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > TAIL_LIMIT_BYTES) {
      // 按 Buffer 字节裁尾：多字节字符不截半。
      this.buffer = Buffer.from(this.buffer).subarray(-TAIL_LIMIT_BYTES).toString('utf8')
    }
  }

  text(): string {
    return this.buffer
  }
}
