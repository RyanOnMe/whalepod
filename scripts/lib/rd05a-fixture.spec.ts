import { describe, expect, it } from 'vitest'
import { observeRd05aAdmission } from './rd05a-fixture.js'

const expected = { inboxItemId: 'item-expected', subscriptionId: 'subscription-expected' }
describe('RD05a production admission observation', () => {
  it('records the actual admission foreign keys', () => {
    expect(observeRd05aAdmission(expected, expected)).toEqual({
      admissionItemId: expected.inboxItemId,
      admissionSubscriptionId: expected.subscriptionId,
    })
  })
  it.each(['inboxItemId', 'subscriptionId'] as const)(
    'rejects an actual wrong %s rather than substituting expectations',
    (key) => {
      expect(() => observeRd05aAdmission({ ...expected, [key]: 'wrong-row' }, expected)).toThrow()
    },
  )
  it('fails closed for a delivered admission without actual foreign keys', () => {
    expect(() =>
      observeRd05aAdmission({ inboxItemId: null, subscriptionId: null }, expected),
    ).toThrow()
  })
})
