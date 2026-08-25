import { describe, expect, it } from 'vitest'
import { expectDomainError } from './helpers.js'
import type { ApprovalDecision, ApprovalStatus } from '../src/approval.js'
import { decideApproval } from '../src/approval.js'

// 规则以 03-领域模型与运行协议.md §3.3 为准：
// pending -> allowed_once | rejected | expired | cancelled；
// 只有第一条有效决定获胜，重复相同决定返回第一次结果，冲突决定抛 APPROVAL_ALREADY_DECIDED。
const EXPIRES_AT = 1_000_000
const BEFORE_EXPIRY = EXPIRES_AT - 1

describe('decideApproval', () => {
  it('pending -> allowed_once on allow_once before expiry', () => {
    expect(
      decideApproval(
        { status: 'pending', expiresAt: EXPIRES_AT },
        { type: 'allow_once', at: BEFORE_EXPIRY },
      ),
    ).toEqual({ status: 'allowed_once', expiresAt: EXPIRES_AT, decidedAt: BEFORE_EXPIRY })
  })

  it('pending -> rejected on reject before expiry', () => {
    expect(
      decideApproval(
        { status: 'pending', expiresAt: EXPIRES_AT },
        { type: 'reject', at: BEFORE_EXPIRY },
      ),
    ).toEqual({ status: 'rejected', expiresAt: EXPIRES_AT, decidedAt: BEFORE_EXPIRY })
  })

  it('pending -> expired on expire', () => {
    expect(
      decideApproval(
        { status: 'pending', expiresAt: EXPIRES_AT },
        { type: 'expire', at: EXPIRES_AT },
      ),
    ).toEqual({ status: 'expired', expiresAt: EXPIRES_AT, decidedAt: EXPIRES_AT })
  })

  it('pending -> cancelled on cancel', () => {
    expect(
      decideApproval(
        { status: 'pending', expiresAt: EXPIRES_AT },
        { type: 'cancel', at: BEFORE_EXPIRY },
      ),
    ).toEqual({ status: 'cancelled', expiresAt: EXPIRES_AT, decidedAt: BEFORE_EXPIRY })
  })

  it.each(['allow_once', 'reject'] as const)(
    'rejects %s at or after expiresAt with APPROVAL_EXPIRED',
    (type) => {
      expectDomainError(
        () =>
          decideApproval({ status: 'pending', expiresAt: EXPIRES_AT }, { type, at: EXPIRES_AT }),
        'APPROVAL_EXPIRED',
      )
    },
  )

  it.each([
    ['allowed_once', { type: 'allow_once', at: BEFORE_EXPIRY }],
    ['rejected', { type: 'reject', at: BEFORE_EXPIRY }],
    ['expired', { type: 'expire', at: EXPIRES_AT }],
    ['cancelled', { type: 'cancel', at: BEFORE_EXPIRY }],
  ] as const)(
    'returns the first result when the same decision repeats on %s',
    (status: ApprovalStatus, decision: ApprovalDecision) => {
      const decided = { status, expiresAt: EXPIRES_AT, decidedAt: 42 }
      expect(decideApproval(decided, decision)).toEqual(decided)
    },
  )

  it.each([
    ['allowed_once', { type: 'reject', at: BEFORE_EXPIRY }],
    ['allowed_once', { type: 'expire', at: EXPIRES_AT }],
    ['allowed_once', { type: 'cancel', at: BEFORE_EXPIRY }],
    ['rejected', { type: 'allow_once', at: BEFORE_EXPIRY }],
    ['rejected', { type: 'expire', at: EXPIRES_AT }],
    ['rejected', { type: 'cancel', at: BEFORE_EXPIRY }],
    ['expired', { type: 'allow_once', at: BEFORE_EXPIRY }],
    ['expired', { type: 'reject', at: BEFORE_EXPIRY }],
    ['expired', { type: 'cancel', at: EXPIRES_AT }],
    ['cancelled', { type: 'allow_once', at: BEFORE_EXPIRY }],
    ['cancelled', { type: 'reject', at: BEFORE_EXPIRY }],
    ['cancelled', { type: 'expire', at: EXPIRES_AT }],
  ] as const)(
    'rejects a conflicting decision on %s with APPROVAL_ALREADY_DECIDED',
    (status: ApprovalStatus, decision: ApprovalDecision) => {
      expectDomainError(
        () => decideApproval({ status, expiresAt: EXPIRES_AT, decidedAt: 42 }, decision),
        'APPROVAL_ALREADY_DECIDED',
      )
    },
  )
})
