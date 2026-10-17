import { describe, expect, it } from 'vitest'
import {
  DomainError,
  isHelperRunPurpose,
  nextDraftVersion,
  transitionTaskSpecRevision,
} from '../src/index.js'

// #378（ADR-0017 §1/§2）：任务约定版本的状态边与辅助 Run 用途的纯逻辑判据。
describe('task spec revision transitions (#378)', () => {
  it('draft 通过 confirm 冻结为 confirmed（唯一状态边）', () => {
    expect(transitionTaskSpecRevision({ status: 'draft' }, { type: 'confirm' })).toEqual({
      status: 'confirmed',
    })
  })

  it('confirmed 是终态：再确认抛 INVALID_SPEC_REVISION_TRANSITION（不原地覆盖）', () => {
    expect(() => transitionTaskSpecRevision({ status: 'confirmed' }, { type: 'confirm' })).toThrow(
      DomainError,
    )
    try {
      transitionTaskSpecRevision({ status: 'confirmed' }, { type: 'confirm' })
      expect.unreachable('confirmed must not be re-confirmable')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('INVALID_SPEC_REVISION_TRANSITION')
    }
  })

  it('草稿并发令牌只增：每次落盘 +1', () => {
    expect(nextDraftVersion(1)).toBe(2)
    expect(nextDraftVersion(7)).toBe(8)
  })
})

describe('run purpose helpers (#378)', () => {
  it('agreement_draft / handoff_draft 是辅助 Run（免绑定）', () => {
    expect(isHelperRunPurpose('agreement_draft')).toBe(true)
    expect(isHelperRunPurpose('handoff_draft')).toBe(true)
  })

  it('business 与未知/缺省值按业务执行处理（fail-closed，要求绑定）', () => {
    expect(isHelperRunPurpose('business')).toBe(false)
    expect(isHelperRunPurpose(undefined)).toBe(false)
    expect(isHelperRunPurpose(null)).toBe(false)
    expect(isHelperRunPurpose('something_else')).toBe(false)
  })
})
