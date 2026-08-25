/** 口令哈希单元测试：钉死 Argon2id 算法与参数行为（02 Task 5 Step 4）。 */
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js'

describe('hashPassword / verifyPassword', () => {
  it('产出 Argon2id PHC 串，可校验通过', async () => {
    const phc = await hashPassword('correct horse battery staple')
    expect(phc.startsWith('$argon2id$')).toBe(true)
    expect(phc).toContain('m=19456,t=2,p=1')
    expect(await verifyPassword(phc, 'correct horse battery staple')).toBe(true)
  })

  it('错误口令校验失败', async () => {
    const phc = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(phc, 'wrong password')).toBe(false)
  })

  it('损坏的 PHC 串返回 false 而不是抛错', async () => {
    expect(await verifyPassword('not-a-phc-string', 'whatever')).toBe(false)
  })

  it('同一口令两次哈希结果不同（随机盐）', async () => {
    const a = await hashPassword('same password')
    const b = await hashPassword('same password')
    expect(a).not.toBe(b)
  })
})
