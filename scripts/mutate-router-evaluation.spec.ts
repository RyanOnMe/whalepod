import { describe, expect, it } from 'vitest'
import { isRouterMutationAssertionFailure } from './mutate-router-evaluation.js'

describe('Router mutation evidence accepts only assertion failures', () => {
  it.each([
    "AssertionError: expected 'accepted' to be 'rejected' // Object.is equality",
    'Error: promise resolved "{ …(8) }" instead of rejecting\n    at matcher',
    'Error: promise rejected "Error: unavailable" instead of resolving\n    at matcher',
  ])('recognizes a failed Vitest matcher: %s', (message) => {
    expect(isRouterMutationAssertionFailure(message)).toBe(true)
  })

  it.each([
    'SyntaxError: Unexpected token',
    'Error: database unavailable',
    'Error: Test timed out in 5000ms',
    'Error: promise resolved unexpectedly',
  ])('rejects an infrastructure, parser or ordinary error: %s', (message) => {
    expect(isRouterMutationAssertionFailure(message)).toBe(false)
  })
})
