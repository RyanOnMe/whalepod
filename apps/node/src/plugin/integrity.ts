/**
 * SRI integrity 校验（02 Task 17 Step 4；04 §6.5：integrity 不匹配 = 拒绝）。
 *
 * 只支持 sha256/384/512 单值（npm 实践）；多值/未知算法一律拒绝。
 */
import { createHash, timingSafeEqual } from 'node:crypto'

export class PluginError extends Error {
  constructor(
    readonly code:
      | 'VALIDATION_FAILED'
      | 'INTEGRITY_MISMATCH'
      | 'LOCK_DIGEST_MISMATCH'
      | 'TARBALL_UNSAFE'
      | 'HOST_NOT_ALLOWED'
      | 'SIZE_LIMIT_EXCEEDED'
      | 'STORE_IO',
    message: string,
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

const SRI_RE = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/

/** 计算字节流的 SRI 值（用于 catalog 制作与测试断言）。 */
export function sriFor(
  content: Buffer,
  algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha512',
): string {
  return `${algorithm}-${createHash(algorithm).update(content).digest('base64')}`
}

/** 校验 content 是否匹配 integrity；任何不匹配/格式问题抛 INTEGRITY_MISMATCH。 */
export function verifyIntegrity(content: Buffer, integrity: string): void {
  const match = SRI_RE.exec(integrity)
  if (match === null) {
    // 固定话术：integrity 串来自 descriptor（攻击者可控面），不得回显片段（§9）。
    throw new PluginError('INTEGRITY_MISMATCH', 'malformed SRI integrity value')
  }
  const algorithm = `sha${match[1]}` as 'sha256' | 'sha384' | 'sha512'
  const expected = Buffer.from(match[2]!, 'base64')
  const actual = createHash(algorithm).update(content).digest()
  // 定长比较防时序侧信道；长度不等直接判不等（timingSafeEqual 对不等长会抛错）。
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PluginError('INTEGRITY_MISMATCH', 'tarball content does not match declared integrity')
  }
}
