import { describe, expect, it } from 'vitest'
import { verifyAgentBrandEvidence } from './agent-brand-evidence.js'
const ring = 'rgb(255, 255, 255) 0px 0px 0px 2px, rgb(0, 0, 0) 0px 0px 0px 4px'
const pair = (background = 'rgb(25, 91, 221)', foreground = 'rgb(255, 255, 255)') => ({
  background,
  foreground,
  shadow: ring,
})
function terminal() {
  return {
    state: 'completed',
    active: false,
    completing: false,
    renderer: 'fallback',
    motion: 'still',
    canvasCount: 0,
    marker: '✓',
    markerVisible: true,
    runningCss: 0,
  }
}
function gpu(active = true, state = 'thinking', paused = false) {
  return {
    drawCalls: active && !paused ? 12 : 0,
    runningCss: 0,
    frames: [0, 1].map((i) => ({
      hash: active && !paused ? `a${i}` : '0',
      nonempty: 400,
      colored: 300,
      blue: 80,
      teal: 80,
      time: active && !paused ? 1 + i : 1,
      width: 64,
      height: 64,
      error: 0,
      state,
      renderer: 'webgl',
      active,
      paused,
      motion: active && !paused ? 'running' : 'still',
    })),
  }
}
function visibleText() {
  return {
    checked: 30,
    offenders: [] as Array<{ selector: string; color: string; background: string; ratio: number }>,
    undecidable: [] as Array<{ selector: string; reason: string }>,
    acceptedChip: {
      className: 'instruction-state-accepted',
      visible: true,
      foreground: 'rgb(0, 0, 0)',
      background: 'rgb(224.4, 224.4, 224.4)',
      layers: [
        { background: 'rgba(0, 0, 0, 0.12)', opacity: 1, image: 'none', backdrop: 'none' },
        { background: 'rgb(255, 255, 255)', opacity: 1, image: 'none', backdrop: 'none' },
      ],
    },
  }
}
function tokenFacts(theme: string) {
  const names = [
    ['--brand-on-primary', '--brand-primary'],
    ['--brand-on-primary', '--brand-primary-hover'],
    ['--brand-link', '--color-surface'],
    ['--brand-link', '--color-paper'],
    ['--brand-selected-ink', '--brand-selected-surface'],
    ['--brand-note-ink', '--brand-note-surface'],
    ['--color-ink', '--color-surface'],
    ['--color-ink-soft', '--color-surface'],
    ['--color-muted', '--color-paper'],
    ['--color-run', '--color-run-soft'],
    ['--color-run', '--color-surface'],
    ['--color-warn', '--color-warn-soft'],
    ['--color-warn', '--color-surface'],
    ['--color-danger', '--color-danger-soft'],
    ['--color-danger-strong', '--color-surface'],
    ['--color-danger-strong', '--dsw-alias-button-floating-hover'],
  ]
  const backgrounds = [
    '--color-paper',
    '--color-surface',
    '--color-ink',
    '--color-signal',
    '--brand-primary',
    '--brand-primary-hover',
    '--brand-selected-surface',
    '--brand-note-surface',
    '--color-run-soft',
    '--color-warn-soft',
    '--color-danger-soft',
  ]
  return {
    theme,
    textPairs: names.map(([fg, bg]) => ({ fg, bg, ...pair('rgb(255, 255, 255)', 'rgb(0, 0, 0)') })),
    focus: backgrounds.map((bg) => ({ bg, background: 'rgb(128, 128, 128)', shadow: ring })),
  }
}
function fixture() {
  return {
    visibilityProbe: {
      component: 'harness.contrast-visibility',
      closed: { outerOpen: false, innerOpen: false, checked: 1, offenders: [], undecidable: [] },
      opened: {
        outerOpen: true,
        innerOpen: false,
        checked: 3,
        offenders: [
          {
            selector: 'a#probe-outer-link',
            color: 'rgb(255, 255, 255)',
            background: 'rgb(255, 255, 255)',
            ratio: 1,
          },
        ],
        undecidable: [],
      },
      nestedOpened: {
        outerOpen: true,
        innerOpen: true,
        checked: 4,
        offenders: [
          {
            selector: 'a#probe-outer-link',
            color: 'rgb(255, 255, 255)',
            background: 'rgb(255, 255, 255)',
            ratio: 1,
          },
          {
            selector: 'a#probe-inner-link',
            color: 'rgb(255, 255, 255)',
            background: 'rgb(255, 255, 255)',
            ratio: 1,
          },
        ],
        undecidable: [],
      },
      reclosed: { outerOpen: false, innerOpen: true, checked: 1, offenders: [], undecidable: [] },
      summaryChecked: {
        outerOpen: false,
        innerOpen: false,
        checked: 1,
        offenders: [
          {
            selector: 'span#probe-summary-low.low',
            color: 'rgb(255, 255, 255)',
            background: 'rgb(255, 255, 255)',
            ratio: 1,
          },
        ],
        undecidable: [],
      },
    },
    component: 'web.agent-brand',
    ok: true,
    browserErrors: [] as string[],
    readOnlyPosts: 0,
    videoAfterAuth: true,
    runs: [1440, 390, 320].map((width, index) => {
      const runId = `11111111-1111-4111-8111-11111111111${index}`
      return {
        width,
        runId,
        taskId: `22222222-2222-4222-8222-22222222222${index}`,
        samples: ['light', 'dark'].map((theme) => ({
          theme,
          ...gpu(),
          visibleText: visibleText(),
        })),
        approval: gpu(false, 'approval'),
        states: [
          { runId, state: 'thinking', active: true, completing: false },
          { runId, state: 'approval', active: false, completing: false },
          { runId, state: 'thinking', active: true, completing: false },
          { runId, state: 'unknown', active: false, completing: false },
          { runId, state: 'completed', active: false, completing: true },
          { runId, state: 'completed', active: false, completing: false },
        ].map((row) => ({
          ...row,
          renderer: row.state === 'completed' && !row.completing ? 'fallback' : 'webgl',
          motion: row.active ? 'running' : row.completing ? 'finishing' : 'still',
        })),
        memberReadOnly: true,
        runtimeObserved: true,
        runtimePid: 2345,
        status: 'completed',
        approved: true,
        artifactCount: 1,
      }
    }),
    brandRows: [1440, 390, 320].flatMap((width) =>
      ['light', 'dark'].map((theme) => ({
        width,
        theme,
        normal: pair(),
        hover: pair('rgb(18, 71, 177)'),
        focus: pair(),
        selected:
          theme === 'dark'
            ? pair('rgb(32, 55, 89)', 'rgb(179, 211, 255)')
            : pair('rgb(232, 241, 255)', 'rgb(18, 63, 136)'),
        w:
          width === 1440
            ? { ...pair(), shadow: 'rgb(19, 184, 166) -3px -3px 0px 0px inset' }
            : null,
        sendNormal: pair(),
        sendHover: pair('rgb(18, 71, 177)'),
        geometry: { viewport: width, scroll: width },
        historyStatic: true,
        historyCanvasCount: 0,
        tokenFacts: width === 1440 ? tokenFacts(theme) : null,
      })),
    ),
    completionLoss: {
      runId: '11111111-1111-4111-8111-111111111110',
      fault: {
        armed: true,
        armedAt: {
          state: 'thinking',
          active: true,
          paused: false,
          renderer: 'webgl',
          motion: 'running',
          followingStopped: true,
          rect: { x: 400, y: 200, width: 64, height: 64 },
          scroll: { top: 0, height: 1200, client: 600 },
        },
        attempted: true,
        lost: true,
        triggerState: 'completed',
        triggerActive: false,
        hadCompleting: true,
        rendererBefore: 'webgl',
        reason: null,
      },
      terminal: terminal(),
    },
    lostBeforeCompletion: {
      runId: '44444444-4444-4444-8444-444444444444',
      runStatus: 'completed',
      approved: true,
      fault: {
        beforeState: 'thinking',
        beforeRenderer: 'webgl',
        lost: true,
        contextLost: true,
        afterState: 'thinking',
        afterRenderer: 'fallback',
      },
      observation: { restoredEvents: 0, sawCompleting: false },
      terminal: terminal(),
    },
    keyboard: { input: 'keyboard', ...gpu() },
    reduced: gpu(true, 'thinking', true),
    fallback: {
      runId: '33333333-3333-4333-8333-333333333333',
      completed: true,
      blockedCalls: 1,
      on: {
        state: 'thinking',
        active: true,
        renderer: 'fallback',
        visible: true,
        paused: false,
        runningCss: 1,
        y: 100,
      },
      off: {
        state: 'thinking',
        active: true,
        renderer: 'fallback',
        visible: true,
        paused: true,
        runningCss: 0,
        y: -100,
      },
      resumed: {
        state: 'thinking',
        active: true,
        renderer: 'fallback',
        visible: true,
        paused: false,
        runningCss: 1,
        y: 100,
      },
      scrollFacts: { top: 500, range: 500, y: 100 },
    },
    contextLoss: {
      before: 'approval',
      after: 'approval',
      lost: true,
      restored: true,
      renderer: 'webgl',
      fallback: { state: 'approval', renderer: 'fallback', visible: true },
    },
  }
}
type Evidence = ReturnType<typeof fixture>
const mutations: Array<[string, (facts: Evidence) => void]> = [
  [
    'missing observed unknown bridge',
    (v) => {
      v.runs[0]!.states = v.runs[0]!.states.filter((row) => row.state !== 'unknown')
    },
  ],
  [
    'missing observed real work',
    (v) => {
      for (const row of v.runs[0]!.states) row.active = false
    },
  ],
  [
    'observed sequence never converges',
    (v) => {
      v.runs[0]!.states.at(-1)!.state = 'thinking'
    },
  ],
  [
    'state flags missing',
    (v) => {
      Reflect.deleteProperty(v.runs[0]!.states[0]!, 'active')
    },
  ],
  [
    'armed rect outside viewport',
    (v) => {
      v.completionLoss.fault.armedAt.rect.y = -1000
    },
  ],
  [
    'closed fixture actually open',
    (v) => {
      v.visibilityProbe.closed.outerOpen = true
    },
  ],

  [
    'completion probe armed offscreen',
    (v) => {
      v.completionLoss.fault.armedAt.paused = true
    },
  ],
  [
    'completion probe still following',
    (v) => {
      v.completionLoss.fault.armedAt.followingStopped = false
    },
  ],
  [
    'completion loss was never injected',
    (v) => {
      v.completionLoss.fault.lost = false
    },
  ],
  [
    'completion loss fabricated wrong phase',
    (v) => {
      v.completionLoss.fault.triggerState = 'thinking'
    },
  ],
  [
    'completion stays frozen',
    (v) => {
      v.completionLoss.terminal.completing = true
    },
  ],
  [
    'completion marker hidden',
    (v) => {
      v.completionLoss.terminal.markerVisible = false
    },
  ],
  [
    'completion canvas leaks',
    (v) => {
      v.completionLoss.terminal.canvasCount = 1
    },
  ],
  [
    'prior thinking loss not native',
    (v) => {
      v.lostBeforeCompletion.fault.contextLost = false
    },
  ],
  [
    'prior thinking loss restored',
    (v) => {
      v.lostBeforeCompletion.observation.restoredEvents = 1
    },
  ],
  [
    'lost GPU begins completion',
    (v) => {
      v.lostBeforeCompletion.observation.sawCompleting = true
    },
  ],
  [
    'lost GPU terminal canvas leaks',
    (v) => {
      v.lostBeforeCompletion.terminal.canvasCount = 1
    },
  ],
  [
    'historical canvas allocated',
    (v) => {
      v.brandRows[0]!.historyCanvasCount = 1
    },
  ],

  [
    'closed details not really measured',
    (v) => {
      v.visibilityProbe.closed.checked = 0
    },
  ],
  [
    'open nav exempted',
    (v) => {
      v.visibilityProbe.opened.offenders = []
    },
  ],
  [
    'nested closed ancestor ignored',
    (v) => {
      v.visibilityProbe.reclosed.outerOpen = true
    },
  ],
  [
    'closed summary incorrectly exempted',
    (v) => {
      v.visibilityProbe.summaryChecked.offenders = []
    },
  ],

  [
    'empty actual text sweep',
    (v) => {
      v.runs[0]!.samples[0]!.visibleText.checked = 0
    },
  ],
  [
    'actual low-contrast text',
    (v) => {
      v.runs[0]!.samples[0]!.visibleText.offenders.push({
        selector: '.instruction-state-accepted',
        color: 'rgb(0, 0, 0)',
        background: 'rgb(0, 0, 0)',
        ratio: 1,
      })
    },
  ],
  [
    'actual text undecidable',
    (v) => {
      v.runs[0]!.samples[0]!.visibleText.undecidable.push({
        selector: '.probe',
        reason: 'unknown backdrop',
      })
    },
  ],
  [
    'accepted dark chip unreadable',
    (v) => {
      v.runs[0]!.samples[1]!.visibleText.acceptedChip.foreground = 'rgb(224.4, 224.4, 224.4)'
    },
  ],
  [
    'accepted chip not seen',
    (v) => {
      v.runs[0]!.samples[0]!.visibleText.acceptedChip.visible = false
    },
  ],

  [
    'fallback was never GPU-faulted',
    (v) => {
      v.fallback.blockedCalls = 0
    },
  ],
  [
    'fallback offscreen still animates',
    (v) => {
      v.fallback.off.runningCss = 1
    },
  ],
  [
    'fallback never scrolled',
    (v) => {
      v.fallback.scrollFacts.top = 0
    },
  ],
  [
    'fallback cannot resume',
    (v) => {
      v.fallback.resumed.runningCss = 0
    },
  ],
  [
    'missing real pid',
    (v) => {
      v.runs[0]!.runtimePid = 0
    },
  ],
  [
    'incomplete driver',
    (v) => {
      v.ok = false
    },
  ],
  [
    'browser error',
    (v) => {
      v.browserErrors = ['Error']
    },
  ],
  [
    'read-only mutation',
    (v) => {
      v.readOnlyPosts = 1
    },
  ],
  [
    'unsafe video',
    (v) => {
      v.videoAfterAuth = false
    },
  ],
  [
    'missing viewport',
    (v) => {
      v.runs.pop()
    },
  ],
  [
    'repeated Run',
    (v) => {
      v.runs[1]!.runId = v.runs[0]!.runId
    },
  ],
  [
    'unapproved execution',
    (v) => {
      v.runs[0]!.approved = false
    },
  ],
  [
    'missing real runtime',
    (v) => {
      v.runs[0]!.runtimeObserved = false
    },
  ],
  [
    'member write controls',
    (v) => {
      v.runs[0]!.memberReadOnly = false
    },
  ],
  [
    'missing theme',
    (v) => {
      v.runs[0]!.samples.pop()
    },
  ],
  [
    'fallback instead of GPU',
    (v) => {
      v.runs[0]!.samples[0]!.frames[0]!.renderer = 'fallback'
    },
  ],
  [
    'blank GPU',
    (v) => {
      v.runs[0]!.samples[0]!.frames[0]!.nonempty = 0
    },
  ],
  [
    'monochrome GPU',
    (v) => {
      v.runs[0]!.samples[0]!.frames[0]!.colored = 0
    },
  ],
  [
    'missing teal pixels',
    (v) => {
      v.runs[0]!.samples[0]!.frames[0]!.teal = 0
    },
  ],
  [
    'missing blue pixels',
    (v) => {
      v.runs[0]!.samples[0]!.frames[0]!.blue = 0
    },
  ],
  [
    'static pixels',
    (v) => {
      v.runs[0]!.samples[0]!.frames[1]!.hash = v.runs[0]!.samples[0]!.frames[0]!.hash
    },
  ],
  [
    'no draws',
    (v) => {
      v.runs[0]!.samples[0]!.drawCalls = 0
    },
  ],
  [
    'approval still draws',
    (v) => {
      v.runs[0]!.approval.drawCalls = 1
    },
  ],
  [
    'completed still active',
    (v) => {
      v.runs[0]!.states.find((row) => row.state === 'completed')!.active = true
    },
  ],
  [
    'missing real completion',
    (v) => {
      for (const run of v.runs) for (const state of run.states) state.completing = false
    },
  ],
  [
    'keyboard disables work',
    (v) => {
      v.keyboard.drawCalls = 0
    },
  ],
  [
    'keyboard not used',
    (v) => {
      v.keyboard.input = 'pointer'
    },
  ],
  [
    'reduced work draws',
    (v) => {
      v.reduced.drawCalls = 1
    },
  ],
  [
    'reduced CSS loop',
    (v) => {
      v.reduced.runningCss = 1
    },
  ],
  [
    'reduced shader advances',
    (v) => {
      v.reduced.frames[1]!.time = 2
    },
  ],
  [
    'context fallback hidden',
    (v) => {
      v.contextLoss.fallback.visible = false
    },
  ],
  [
    'context never restored',
    (v) => {
      v.contextLoss.restored = false
    },
  ],
  [
    'context changes phase',
    (v) => {
      v.contextLoss.after = 'thinking'
    },
  ],
  [
    'brand layout missing',
    (v) => {
      v.brandRows.pop()
    },
  ],
  [
    'black primary',
    (v) => {
      v.brandRows[0]!.normal.background = 'rgb(0, 0, 0)'
    },
  ],
  [
    'wrong send color',
    (v) => {
      v.brandRows[0]!.sendNormal.background = 'rgb(19, 184, 166)'
    },
  ],
  [
    'wrong selected palette',
    (v) => {
      v.brandRows[1]!.selected.foreground = 'rgb(255, 255, 255)'
    },
  ],
  [
    'missing W detail',
    (v) => {
      v.brandRows[0]!.w!.shadow = 'none'
    },
  ],
  [
    'overflow',
    (v) => {
      v.brandRows[2]!.geometry.scroll = 500
    },
  ],
  [
    'history celebrates',
    (v) => {
      v.brandRows[0]!.historyStatic = false
    },
  ],
  [
    'missing text pair',
    (v) => {
      v.brandRows[0]!.tokenFacts!.textPairs.pop()
    },
  ],
  [
    'bad text contrast',
    (v) => {
      v.brandRows[0]!.tokenFacts!.textPairs[0]!.foreground = 'rgb(255, 255, 255)'
    },
  ],
  [
    'bad focus contrast',
    (v) => {
      v.brandRows[0]!.tokenFacts!.focus[0]!.background = 'rgb(255, 255, 255)'
      v.brandRows[0]!.tokenFacts!.focus[0]!.shadow =
        'rgb(255, 255, 255) 0px 0px 0px 2px, rgb(255, 255, 255) 0px 0px 0px 4px'
    },
  ],
]
describe('P1-437 independent Agent brand browser evidence', () => {
  it('accepts real colored moving GPU observations and truthful paused/terminal paths', () => {
    expect(verifyAgentBrandEvidence(fixture())).toMatchObject({
      ok: true,
      runs: 3,
      layouts: 6,
      textPairs: 32,
      focusBackgrounds: 22,
    })
  })
  it('accepts a truthful phase advance while arming and recovery after an unknown gap', () => {
    const facts = fixture()
    facts.completionLoss.fault.armedAt.state = 'finalizing'
    const run = facts.runs[0]!
    run.states.splice(
      run.states.findIndex((row) => row.state === 'completed'),
      0,
      {
        runId: run.runId,
        state: 'finalizing',
        active: true,
        completing: false,
        renderer: 'webgl',
        motion: 'running',
      },
    )
    expect(verifyAgentBrandEvidence(facts).ok).toBe(true)
  })
  it('missing observations fail closed', () =>
    expect(() => verifyAgentBrandEvidence({ ok: true })).toThrow())
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const facts = fixture()
    mutate(facts)
    expect(() => verifyAgentBrandEvidence(facts)).toThrow()
  })
})
