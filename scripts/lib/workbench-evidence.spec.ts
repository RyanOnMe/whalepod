import { describe, expect, it } from 'vitest'
import { verifyWorkbenchEvidence } from './workbench-evidence.js'

function fixture() {
  const rect = { x: 8, y: 8, width: 260, height: 80 }
  const rows = [1440, 390, 320].map((width) => ({
    width,
    scroll: width,
    empty: rect,
    search: rect,
    drawer: rect,
    welcome: rect,
    tool: rect,
    activity: rect,
    profileCount: width === 1440 ? 1 : 0,
    mobileNameVisible: width === 390,
    uniqueSearch: true,
    keyboardClear: true,
    closeRestoresFocus: true,
    clip: { client: 260, scroll: 260, contained: true, footerVisible: true },
    resultNavigation: true,
    drawerFocus: true,
    status: 'completed',
    working: null as string | null,
    reducedArcRule: true,
  }))
  return {
    ok: true,
    browserErrors: [],
    facts: [
      {
        component: 'web.workbench',
        start: { rows: structuredClone(rows), posts: 0 },
        room: { rows: structuredClone(rows), posts: 0 },
        run: { rows: structuredClone(rows) },
      },
    ],
  }
}
describe('P1-423 independent workbench evidence', () => {
  it('accepts complete production observations', () => {
    expect(verifyWorkbenchEvidence(fixture()).layouts).toBe(9)
  })
  it('rejects missing facts, widths, geometry, mutations and focus failures', () => {
    expect(() => verifyWorkbenchEvidence({ ok: true, browserErrors: [], facts: [] })).toThrow()
    const missing = fixture()
    missing.facts[0]!.room.rows.pop()
    expect(() => verifyWorkbenchEvidence(missing)).toThrow('viewports')
    const overflow = fixture()
    overflow.facts[0]!.start.rows[2]!.search.width = 400
    expect(() => verifyWorkbenchEvidence(overflow)).toThrow('overflow')
    const posts = fixture()
    posts.facts[0]!.room.posts = 1
    expect(() => verifyWorkbenchEvidence(posts)).toThrow('mutation')
    const focus = fixture()
    focus.facts[0]!.start.rows[1]!.keyboardClear = false
    expect(() => verifyWorkbenchEvidence(focus)).toThrow('keyboard')
  })
  it('rejects terminal animation and absent reduced-motion rules', () => {
    const clip = fixture()
    clip.facts[0]!.start.rows[2]!.clip.footerVisible = false
    expect(() => verifyWorkbenchEvidence(clip)).toThrow('clipped')
    const running = fixture()
    running.facts[0]!.run.rows[0]!.working = ''
    expect(() => verifyWorkbenchEvidence(running)).toThrow('pretends')
    const motion = fixture()
    motion.facts[0]!.run.rows[1]!.reducedArcRule = false
    expect(() => verifyWorkbenchEvidence(motion)).toThrow('reduced-motion')
  })
})
