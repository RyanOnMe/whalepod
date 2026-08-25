/** opaque Token 单元测试（02 Task 5 Step 4：Session 与邀请共用同一 pattern）。 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashToken, issueOpaqueToken } from '../src/modules/auth/token.js'

describe('issueOpaqueToken', () => {
  it('token 为 32 字节随机的 base64url，hash 为其 SHA-256', () => {
    const { token, hash } = issueOpaqueToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash.byteLength).toBe(32)
    expect(Buffer.from(hash).equals(createHash('sha256').update(token).digest())).toBe(true)
  })

  it('两次签发不相同', () => {
    expect(issueOpaqueToken().token).not.toBe(issueOpaqueToken().token)
  })
})
