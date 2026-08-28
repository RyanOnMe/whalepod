/**
 * SRI integrity 校验（02 Task 17 Step 4；04 §6.5：integrity 不匹配 = 拒绝）。
 *
 * 只支持 sha256/384/512 单值（npm 实践）；多值/未知算法一律拒绝。
 */
import { createHash } from 'node:crypto'

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
export function sriFor(content: Buffer, algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(content).digest('base64')}`
}

/** 校验 content 是否匹配 integrity；任何不匹配/格式问题抛 INTEGRITY_MISMATCH。 */
export function verifyIntegrity(content: Buffer, integrity: string): void {
  const match = SRI_RE.exec(integrity)
  if (match === null) {
    throw new PluginError('INTEGRITY_MISMATCH', `malformed SRI: ${integrity.slice(0, 32)}…`)
  }
  const algorithm = `sha${match[1]}` as 'sha256' | 'sha384' | 'sha512'
  const expected = Buffer.from(match[2]!, 'base64')
  const actual = createHash(algorithm).update(content).digest()
  if (actual.length !== expected.length || !actual.equals(expected)) {
    throw new PluginError('INTEGRITY_MISMATCH', 'tarball content does not match declared integrity')
  }
}
