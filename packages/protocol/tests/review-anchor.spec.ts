import { describe, expect, it } from 'vitest'
import { ArtifactCommentAnchorSchema, locateArtifactCommentAnchor } from '../src/review.js'

const TEXT = 'alpha orderId beta\nbeta orderId gamma\n'

function anchor(offset: number, quote: string) {
  return {
    quote,
    prefix: TEXT.slice(Math.max(0, offset - 6), offset),
    suffix: TEXT.slice(offset + quote.length, offset + quote.length + 6),
    start: offset,
    end: offset + quote.length,
  }
}

describe('artifact comment anchor (#429)', () => {
  it('偏移与长度必须一致；quote 不能为空', () => {
    expect(
      ArtifactCommentAnchorSchema.safeParse({
        quote: 'abc',
        prefix: '',
        suffix: '',
        start: 0,
        end: 2,
      }).success,
    ).toBe(false)
    expect(
      ArtifactCommentAnchorSchema.safeParse({
        quote: '',
        prefix: '',
        suffix: '',
        start: 0,
        end: 0,
      }).success,
    ).toBe(false)
  })

  it('重复文字靠前后文唯一定位；上下文缺失时明确失败', () => {
    const second = TEXT.indexOf('orderId', TEXT.indexOf('orderId') + 1)
    expect(locateArtifactCommentAnchor(TEXT, anchor(second, 'orderId'))).toMatchObject({
      start: second,
      end: second + 7,
    })
    expect(
      locateArtifactCommentAnchor(TEXT, {
        quote: 'orderId',
        prefix: '',
        suffix: '',
        start: 0,
        end: 7,
      }),
    ).toBeNull()
  })

  it('偏移过期但上下文唯一时重定位；上下文也不匹配时不猜', () => {
    const second = TEXT.indexOf('orderId', TEXT.indexOf('orderId') + 1)
    expect(
      locateArtifactCommentAnchor(TEXT, { ...anchor(second, 'orderId'), start: 0, end: 7 }),
    ).toMatchObject({ start: second, end: second + 7 })
    expect(
      locateArtifactCommentAnchor(TEXT, {
        quote: 'orderId',
        prefix: 'not-in-version',
        suffix: '',
        start: 0,
        end: 7,
      }),
    ).toBeNull()
  })
})
