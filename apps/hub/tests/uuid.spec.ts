/** UUIDv7 单元测试（03 §1：持久 ID 一律 UUIDv7）。 */
import { describe, expect, it } from 'vitest'
import { uuidv7 } from '../src/modules/shared/uuid.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('uuidv7', () => {
  it('格式合法，version=7、variant=10', () => {
    const id = uuidv7()
    expect(id).toMatch(UUID_RE)
    expect(id[14]).toBe('7')
    expect(['8', '9', 'a', 'b']).toContain(id[19])
  })

  it('前 48 bit 是毫秒时间戳', () => {
    const now = 1_700_000_000_000
    const id = uuidv7(now)
    const hex = id.replaceAll('-', '').slice(0, 12)
    expect(Number(BigInt(`0x${hex}`))).toBe(now)
  })

  it('两次生成不相同', () => {
    expect(uuidv7()).not.toBe(uuidv7())
  })
})
