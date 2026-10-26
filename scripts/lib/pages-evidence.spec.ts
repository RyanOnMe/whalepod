import { describe, expect, it } from 'vitest'
import { verifyPagesEvidence } from './pages-evidence.js'
function fixture() {
  const box = { x: 12, y: 12, width: 260, height: 80 }
  return {
    ok: true,
    browserErrors: [],
    facts: [
      {
        component: 'web.pages',
        posts: 0,
        commentShared: true,
        memberReadOnly: true,
        rows: [1440, 390, 320].map((width) => ({
          width,
          projectBounds: box,
          inboxBounds: box,
          settingsBounds: box,
          discussionBounds: box,
          homeScroll: width,
          settingsScroll: width,
          discussionScroll: width,
          pointerDuration: '0.36s',
          entryDuration: '0.44s',
          keyboardDuration: '0s',
          reducedDuration: '0s',
          reducedEntry: '0s',
          closedInert: true,
          keyboardFocus: true,
          interrupted: true,
          stableNode: true,
          filterDeepLink: true,
          advancedRetained: true,
          invalidFocus: true,
          draftRetained: true,
          replayed: 0,
          groups: 4,
        })),
      },
    ],
  }
}
describe('P1-425 page evidence verdict', () => {
  it('accepts complete measured observations', () => {
    expect(verifyPagesEvidence(fixture()).layouts).toBe(12)
  })
  it('rejects missing evidence, viewport, overflow, false interactions, delayed motion, replay and unexpected mutations', () => {
    expect(() => verifyPagesEvidence({ ok: true, browserErrors: [], facts: [] })).toThrow()
    const missing = fixture()
    missing.facts[0]!.rows.pop()
    expect(() => verifyPagesEvidence(missing)).toThrow('viewports')
    const overflow = fixture()
    overflow.facts[0]!.rows[2]!.homeScroll = 500
    expect(() => verifyPagesEvidence(overflow)).toThrow('overflow')
    for (const key of [
      'closedInert',
      'keyboardFocus',
      'interrupted',
      'stableNode',
      'filterDeepLink',
      'advancedRetained',
      'invalidFocus',
      'draftRetained',
    ] as const) {
      const bad = fixture()
      bad.facts[0]!.rows[0]![key] = false
      expect(() => verifyPagesEvidence(bad)).toThrow('interaction')
    }
    const motion = fixture()
    motion.facts[0]!.rows[1]!.reducedDuration = '0.16s'
    expect(() => verifyPagesEvidence(motion)).toThrow('reduced-motion')
    const replay = fixture()
    replay.facts[0]!.rows[0]!.replayed = 1
    expect(() => verifyPagesEvidence(replay)).toThrow('replays')
    const posts = fixture()
    posts.facts[0]!.posts = 1
    expect(() => verifyPagesEvidence(posts)).toThrow('mutation')
  })
})
