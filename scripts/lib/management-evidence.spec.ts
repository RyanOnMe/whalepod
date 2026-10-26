import { describe, expect, it } from 'vitest'
import { verifyManagementEvidence } from './management-evidence.js'
function fixture() {
  const box = { x: 12, y: 0, width: 260, height: 80, client: 258, scroll: 258 }
  return {
    ok: true,
    component: 'web.management',
    browserErrors: [],
    readOnlyPosts: 0,
    inviteRetained: true,
    inviteCopied: true,
    memberJoined: true,
    pluginInstalled: true,
    packCreated: true,
    agentCreated: true,
    paired: true,
    pairingCopied: true,
    pairingKeyboard: { durations: Array(5).fill('0s'), animations: 0 },
    memberReadOnly: true,
    rows: [1440, 390, 320].map((width) => ({
      width,
      inviteCollapsed: true,
      inviteRoleRetained: true,
      closeRestoresFocus: true,
      revisionPrefill: true,
      onePairingAction: true,
      reduced: true,
      members: { width, scroll: width, surfaces: Array.from({ length: 3 }, () => ({ ...box })) },
      plugins: { width, scroll: width, surfaces: Array.from({ length: 6 }, () => ({ ...box })) },
      agents: { width, scroll: width, surfaces: Array.from({ length: 2 }, () => ({ ...box })) },
      devices: { width, scroll: width, surfaces: Array.from({ length: 2 }, () => ({ ...box })) },
    })),
  }
}
describe('P1-432 independent management verdict', () => {
  it('accepts complete observations', () =>
    expect(verifyManagementEvidence(fixture()).layouts).toBe(12))
  it('rejects absent evidence, permissions, writes, missing/clipped surfaces and motion/focus failures', () => {
    expect(() => verifyManagementEvidence({ ok: true })).toThrow()
    const keyboard = fixture()
    keyboard.pairingKeyboard.animations = 1
    expect(() => verifyManagementEvidence(keyboard)).toThrow('keyboard')
    const missing = fixture()
    missing.rows.pop()
    expect(() => verifyManagementEvidence(missing)).toThrow('widths')
    const posts = fixture()
    posts.readOnlyPosts = 1
    expect(() => verifyManagementEvidence(posts)).toThrow('mutation')
    const permission = fixture()
    permission.memberReadOnly = false
    expect(() => verifyManagementEvidence(permission)).toThrow('workflow')
    const absent = fixture()
    absent.rows[0]!.plugins.surfaces = []
    expect(() => verifyManagementEvidence(absent)).toThrow('surfaces')
    const clipped = fixture()
    clipped.rows[2]!.devices.surfaces[0]!.scroll = 300
    expect(() => verifyManagementEvidence(clipped)).toThrow('clipped')
    const overflow = fixture()
    overflow.rows[2]!.agents.scroll = 400
    expect(() => verifyManagementEvidence(overflow)).toThrow('overflow')
    for (const key of [
      'inviteCollapsed',
      'inviteRoleRetained',
      'closeRestoresFocus',
      'revisionPrefill',
      'onePairingAction',
      'reduced',
    ] as const) {
      const bad = fixture()
      bad.rows[1]![key] = false
      expect(() => verifyManagementEvidence(bad)).toThrow('interaction')
    }
  })
})
