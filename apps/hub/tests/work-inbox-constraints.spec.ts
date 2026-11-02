import { describe, expect, it } from 'vitest'
import { mapWorkConstraint } from '../src/modules/work/commands.js'

// ADR-0028（RD-02a-1）：收件箱唯一约束到 HTTP 的映射必须是显式 409，
// 不能把“同来源已有 pending”伪装成 500 或泛化成工作身份冲突。
describe('work inbox constraint mapping', () => {
  it('maps the source pending unique index to CONFLICT', () => {
    const mapped = mapWorkConstraint({
      code: '23505',
      constraint_name: 'work_inbox_item_source_pending_unique',
    })
    expect(mapped).toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'source already has a pending inbox item; retry',
    })
  })
})
