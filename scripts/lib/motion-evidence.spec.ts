import { describe, expect, it } from 'vitest'
import { verifyMotionEvidence } from './motion-evidence.js'
function fixture() {
  return {
    ok: true,
    component: 'web.motion',
    project: {
      depthTransform: 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,1,0,0,1)',
      reducedTransform: 'none',
      idleWrites: 0,
      returned: true,
    },
    workspace: {
      posts: 0,
      contentReads: 1,
      toolsReal: true,
      candidatePrivate: true,
      secondRunId: '11111111-1111-4111-8111-111111111111',
      rows: [1440, 390, 320].map((width) => ({
        width,
        reveal: {
          declaredDuration: '0.36s',
          durations: [360, 360],
          early: { x: 0, height: 30, opacity: 0.5 },
          late: { x: 0, height: 80, opacity: 0.9 },
        },
        inspector: {
          declaredDuration: '0.32s, 0.32s',
          durations: [320, 320],
          early: { x: 20, height: 400, opacity: 0.5 },
          late: { x: 1, height: 400, opacity: 0.9 },
        },
        fanBefore: ['matrix(1)', 'matrix(2)'],
        fanAfter: ['matrix(3)', 'matrix(4)'],
        reduced: { duration: '0s', transform: 'none' },
        geometry: { width, scroll: width, client: width - 40, content: width - 40 },
        interrupted: true,
        closedInert: true,
        previewRetained: true,
        focusReturned: true,
      })),
    },
  }
}
describe('independent visible motion verdict', () => {
  it('requires actual differing intermediate frames', () =>
    expect(verifyMotionEvidence(fixture()).layouts).toBe(3))
  it('rejects missing facts, static frames, lost state, unauthorized writes, loops and overflow', () => {
    expect(() => verifyMotionEvidence({ ok: true })).toThrow()
    const invalid = [
      (value: ReturnType<typeof fixture>) => {
        value.project.idleWrites = 1
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.posts = 1
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.contentReads = 2
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.candidatePrivate = false
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows.pop()
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.reveal.late.height = 30
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.inspector.late.x = 20
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.reveal.durations = []
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.reduced.transform = 'matrix(1)'
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.fanAfter = value.workspace.rows[0]!.fanBefore
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.geometry.scroll = 1800
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.interrupted = false
      },
      (value: ReturnType<typeof fixture>) => {
        value.workspace.rows[0]!.focusReturned = false
      },
    ]
    for (const mutate of invalid) {
      const value = fixture()
      mutate(value)
      expect(() => verifyMotionEvidence(value)).toThrow()
    }
  })
})
