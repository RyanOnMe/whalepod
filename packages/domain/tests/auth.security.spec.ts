/**
 * #106 口令强度政策（Q7 安全门首个用例族，域层半边）。
 * 政策判定的 SSoT 在 domain（纯函数）；HTTP 归因（400/错误码）属 hub 路由层。
 */
import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN_CODEPOINTS, isPasswordAcceptable } from '../src/auth.js'

describe('口令政策（#106）', () => {
  it('界值：11 个码点拒、12 个码点过', () => {
    expect(isPasswordAcceptable('a'.repeat(PASSWORD_MIN_CODEPOINTS - 1))).toBe(false)
    expect(isPasswordAcceptable('a'.repeat(PASSWORD_MIN_CODEPOINTS))).toBe(true)
  })

  it('空串/空白同样拒（min(1) 时代的 1 字符口令是本 Issue 的立契点）', () => {
    expect(isPasswordAcceptable('')).toBe(false)
    expect(isPasswordAcceptable('a')).toBe(false)
    expect(isPasswordAcceptable('   ')).toBe(false)
  })

  it('计数单位是 Unicode 码点，不是 UTF-16 code unit（代理对不被劈半计数）', () => {
    const emoji11 = '🔑'.repeat(11) // 22 个 UTF-16 code unit，11 个码点
    expect([...emoji11].length).toBe(11)
    expect(isPasswordAcceptable(emoji11)).toBe(false)
    expect(isPasswordAcceptable(emoji11 + '🔑')).toBe(true)
  })
})
