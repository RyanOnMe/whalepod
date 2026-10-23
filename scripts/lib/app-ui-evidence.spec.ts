import { describe, expect, it } from 'vitest'
import { verifyAppUiEvidence } from './app-ui-evidence.js'

function evidence() {
  const widths = [1440, 390, 320]
  const box = { x: 12, y: 12, width: 240, height: 140 }
  return {
    ok: true,
    browserErrors: [],
    facts: [
      {
        component: 'web.app-ui',
        scenario: 'restricted-presentation',
        prompts: widths.map((width) => ({
          width,
          inputCount: 1,
          inputShadow: 'none',
          frameShadow: '0 0 0 2px black',
        })),
        approvals: widths.map((width) => ({
          width,
          card: box,
          preview: box,
          approveHeight: 44,
          rejectHeight: 44,
        })),
        files: widths.map((width) => ({
          width,
          menu: box,
          itemCount: 3,
          posts: 0,
          escapeRestoresFocus: true,
          outerPanelPreserved: true,
        })),
        sendFocus: widths.map((width) => ({
          width,
          focused: true,
          shadow: 'rgb(255, 255, 255) 0px 0px 0px 2px, rgb(0, 0, 0) 0px 0px 0px 4px',
        })),
      },
    ],
  }
}

describe('P1-421 independent evidence judgment', () => {
  it('accepts complete measurements for all nine surfaces', () => {
    expect(verifyAppUiEvidence(evidence())).toMatchObject({ layouts: 9 })
  })
  it('fails on missing facts, missing viewports and duplicated inputs', () => {
    expect(() => verifyAppUiEvidence({ ok: true, facts: [] })).toThrow()
    const partial = evidence()
    partial.facts[0]!.files.pop()
    expect(() => verifyAppUiEvidence(partial)).toThrow('viewports')
    const duplicate = evidence()
    duplicate.facts[0]!.prompts[0]!.inputCount = 2
    expect(() => verifyAppUiEvidence(duplicate)).toThrow('Duplicate input')
  })
  it('rejects viewport overflow, small decisions, unexpected posts and broken Escape', () => {
    const overflow = evidence()
    overflow.facts[0]!.files[2]!.menu = { x: 300, y: 10, width: 100, height: 140 }
    expect(() => verifyAppUiEvidence(overflow)).toThrow('overflows')
    const tiny = evidence()
    tiny.facts[0]!.approvals[0]!.approveHeight = 28
    expect(() => verifyAppUiEvidence(tiny)).toThrow('too small')
    const mutation = evidence()
    mutation.facts[0]!.files[0]!.posts = 1
    expect(() => verifyAppUiEvidence(mutation)).toThrow('mutation')
    const focus = evidence()
    focus.facts[0]!.files[0]!.outerPanelPreserved = false
    expect(() => verifyAppUiEvidence(focus)).toThrow('Escape/focus')
    const ring = evidence()
    ring.facts[0]!.sendFocus[0]!.shadow = 'inset 0px 1px 0px black'
    expect(() => verifyAppUiEvidence(ring)).toThrow('focus ring')
  })
})
