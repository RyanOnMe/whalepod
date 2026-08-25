import { createHash, randomBytes } from 'node:crypto'

/**
 * opaque Token（02 Task 5 Step 4）：Session 与邀请共用同一 pattern——
 * 明文 32 字节随机 base64url 只出现在响应里，数据库只存 SHA-256。
 */
export function issueOpaqueToken(): { token: string; hash: Uint8Array } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): Uint8Array {
  return createHash('sha256').update(token).digest()
}
