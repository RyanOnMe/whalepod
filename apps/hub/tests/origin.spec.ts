/** Origin gate 单元测试：exact 比较与全部拒绝形态（02 Task 5 Step 5、04 §6.1）。 */
import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { assertSameOrigin } from '../src/modules/auth/origin.js'
import { ApiError } from '../src/modules/shared/http-error.js'

const ORIGIN = 'https://hub.example.com'

function fakeRequest(method: string, origin?: string | string[]): FastifyRequest {
  return { method, headers: { ...(origin !== undefined ? { origin } : {}) } } as FastifyRequest
}

function expectRejected(request: FastifyRequest): void {
  try {
    assertSameOrigin(request, ORIGIN)
    expect.unreachable('应当抛出 ORIGIN_REJECTED')
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).statusCode).toBe(403)
    expect((error as ApiError).code).toBe('ORIGIN_REJECTED')
  }
}

describe('assertSameOrigin', () => {
  it('exact 一致的 Origin 放行非安全方法', () => {
    expect(() => assertSameOrigin(fakeRequest('POST', ORIGIN), ORIGIN)).not.toThrow()
  })

  it('安全方法（GET/HEAD/OPTIONS）不校验 Origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(() => assertSameOrigin(fakeRequest(method), ORIGIN)).not.toThrow()
    }
  })

  it('缺失 Origin 拒绝', () => {
    expectRejected(fakeRequest('POST'))
  })

  it('Origin: null 拒绝', () => {
    expectRejected(fakeRequest('POST', 'null'))
  })

  it('多值 Origin 拒绝（数组与逗号拼接两种形态）', () => {
    expectRejected(fakeRequest('POST', [ORIGIN, 'https://evil.example.com']))
    expectRejected(fakeRequest('POST', `${ORIGIN}, https://evil.example.com`))
  })

  it('scheme / host / port 任一不同都拒绝', () => {
    expectRejected(fakeRequest('POST', 'http://hub.example.com'))
    expectRejected(fakeRequest('POST', 'https://evil.example.com'))
    expectRejected(fakeRequest('POST', 'https://hub.example.com:8443'))
    expectRejected(fakeRequest('POST', `${ORIGIN}/`))
  })

  it('PATCH / DELETE 同样被校验', () => {
    expectRejected(fakeRequest('PATCH'))
    expectRejected(fakeRequest('DELETE'))
  })
})
