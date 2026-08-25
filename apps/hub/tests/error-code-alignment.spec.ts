/**
 * 错误码跨包对齐门（Issue #30）。
 *
 * packages/domain 与 packages/protocol 按边界规则（scripts/check-boundaries.ts）
 * 互相不能 import，错误码文本只能各持一份；apps/hub 是允许同时依赖两边的位置，
 * 因此在这里断言 DomainErrorCode 是 wire ErrorCodeSchema 的子集，
 * 防止「第三份错误码清单」漂移。domain 新增错误码而 protocol 未同步时此测试变红。
 */
import { describe, expect, it } from 'vitest'
import { DOMAIN_ERROR_CODES } from '@project311/domain'
import { ErrorCodeSchema } from '@project311/protocol'

describe('error code alignment (domain ⊆ protocol)', () => {
  it('every DomainErrorCode is a wire ErrorCode', () => {
    const wireCodes = new Set<string>(ErrorCodeSchema.options)
    const missing = DOMAIN_ERROR_CODES.filter((code) => !wireCodes.has(code))
    expect(missing).toEqual([])
  })

  it('every DomainErrorCode round-trips through ErrorCodeSchema.parse', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(ErrorCodeSchema.parse(code)).toBe(code)
    }
  })
})
