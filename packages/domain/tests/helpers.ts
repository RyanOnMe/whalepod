import { expect } from 'vitest'
import type { DomainErrorCode } from '../src/errors.js'
import { DomainError } from '../src/errors.js'

/**
 * Vitest 4 没有 Jest 的 toThrowErrorMatchingObject；
 * 领域测试统一走这里断言「抛 DomainError 且 code 稳定」。
 */
export function expectDomainError(fn: () => unknown, code: DomainErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DomainError)
  expect(caught).toMatchObject({ code })
}
