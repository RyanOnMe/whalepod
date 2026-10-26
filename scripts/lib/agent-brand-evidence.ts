import { strict as assert } from 'node:assert'
import {
  compositeOver,
  contrastRatio,
  parseCssColor,
  WHITE,
} from '../../apps/web/tests/contrast.js'

/** Independently checks browser pixels, real Run transitions and resolved product colors. */
export function verifyAgentBrandEvidence(input: unknown) {
  let checks = 0
  const check = (condition: unknown, message: string) => {
    checks++
    assert(condition, message)
  }
  const object = (value: unknown): Record<string, unknown> => {
    check(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      'missing observation',
    )
    return value as Record<string, unknown>
  }
  const array = (value: unknown) => {
    check(Array.isArray(value), 'missing observation rows')
    return (value as unknown[]).map(object)
  }
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value)
  const color = (value: unknown) => {
    check(typeof value === 'string', 'missing computed color')
    const parsed = parseCssColor(value as string)
    check(
      [parsed.r, parsed.g, parsed.b, parsed.a].every(Number.isFinite) && parsed.a === 1,
      'color is transparent or invalid',
    )
    return parsed
  }
  const same = (value: unknown, rgb: readonly number[]) => {
    const c = color(value)
    check(
      [c.r, c.g, c.b].every((channel, index) => Math.abs(channel - rgb[index]!) < 0.5),
      'brand color drift',
    )
  }
  const text = (value: unknown) => {
    const pair = object(value)
    check(
      contrastRatio(color(pair.foreground), color(pair.background)) >= 4.5,
      'text contrast below AA',
    )
    return pair
  }
  const ring = (value: unknown) => {
    check(typeof value === 'string', 'missing actual focus ring')
    const shadow = value as string
    const layers = shadow.match(/rgba?\([^)]+\)\s+(?:-?[\d.]+px\s+){3}-?[\d.]+px/g) ?? []
    check(layers.length === 2, 'focus ring must retain two real layers')
    const parsed = layers.map((layer) => {
      const colored = layer.match(/^rgba?\([^)]+\)/)![0]
      const metrics = layer.slice(colored.length).trim().split(/\s+/).map(Number.parseFloat)
      check(
        metrics.length === 4 && metrics.slice(0, 3).every((n) => n === 0),
        'focus ring is offset or blurred',
      )
      return { color: color(colored), spread: metrics[3]! }
    })
    check(
      parsed[0]!.spread >= 2 && parsed[1]!.spread - parsed[0]!.spread >= 2,
      'focus ring bands too thin',
    )
    return parsed
  }
  const visibleText = (value: unknown) => {
    const sweep = object(value)
    check(finite(sweep.checked) && sweep.checked > 0, 'actual visible text was not scanned')
    check(
      Array.isArray(sweep.offenders) && sweep.offenders.length === 0,
      'actual visible text contrast failed',
    )
    check(
      Array.isArray(sweep.undecidable) && sweep.undecidable.length === 0,
      'actual visible text contrast undecidable',
    )
    const accepted = object(sweep.acceptedChip)
    check(
      accepted.visible === true &&
        typeof accepted.className === 'string' &&
        accepted.className.split(/\s+/).includes('instruction-state-accepted'),
      'accepted instruction chip was not visible',
    )
    const layers = array(accepted.layers)
    check(layers.length > 1, 'missing real accepted-chip background chain')
    let background = WHITE
    for (const layer of [...layers].reverse()) {
      check(
        layer.opacity === 1 && layer.image === 'none' && layer.backdrop === 'none',
        'accepted chip was sampled during opacity/unknown backdrop',
      )
      check(typeof layer.background === 'string', 'missing actual background layer')
      background = compositeOver(parseCssColor(layer.background as string), background)
    }
    check(typeof accepted.foreground === 'string', 'missing accepted-chip foreground')
    const foreground = compositeOver(parseCssColor(accepted.foreground as string), background)
    const reported = color(accepted.background)
    check(
      [reported.r - background.r, reported.g - background.g, reported.b - background.b].every(
        (v) => Math.abs(v) < 0.5,
      ),
      'accepted-chip composite background mismatch',
    )
    check(contrastRatio(foreground, background) >= 4.5, 'accepted instruction contrast below AA')
  }
  const terminalResources = (value: unknown) => {
    const terminal = object(value)
    check(
      terminal.state === 'completed' && terminal.active === false && terminal.completing === false,
      'GPU loss froze a business completion',
    )
    check(
      terminal.canvasCount === 0 && terminal.renderer === 'fallback' && terminal.motion === 'still',
      'terminal GPU resources were not released',
    )
    check(
      terminal.marker === '✓' && terminal.markerVisible === true && terminal.runningCss === 0,
      'completed fallback marker is hidden or still animating',
    )
  }
  const frames = (value: unknown) => {
    const sample = object(value),
      rows = array(sample.frames)
    check(rows.length === 2, 'missing two real GPU frames')
    for (const frame of rows) {
      check(frame.renderer === 'webgl' && frame.error === 0, 'not a working GPU renderer')
      check(
        finite(frame.width) && frame.width > 0 && finite(frame.height) && frame.height > 0,
        'empty GPU surface',
      )
      check(finite(frame.time) && frame.time >= 0, 'missing actual shader clock')
      check(
        typeof frame.hash === 'string' && /^[a-f0-9]+$/.test(frame.hash),
        'missing pixel readback',
      )
    }
    return { sample, rows }
  }
  const moving = (value: unknown) => {
    const { sample, rows } = frames(value)
    check(finite(sample.drawCalls) && sample.drawCalls > 0, 'GPU did not draw')
    for (const frame of rows) {
      check(
        frame.state === 'thinking' &&
          frame.active === true &&
          frame.paused === false &&
          frame.motion === 'running',
        'not truthful visible thinking',
      )
      check(
        finite(frame.nonempty) &&
          frame.nonempty > 20 &&
          finite(frame.colored) &&
          frame.colored > 10,
        'blank or monochrome GPU frame',
      )
      check(
        finite(frame.blue) && frame.blue > 2 && finite(frame.teal) && frame.teal > 2,
        'missing blue or teal GPU pixels',
      )
    }
    check(
      rows[0]!.hash !== rows[1]!.hash && (rows[1]!.time as number) > (rows[0]!.time as number),
      'GPU frames are static',
    )
  }
  const still = (value: unknown, state: string, active: boolean, paused: boolean) => {
    const { sample, rows } = frames(value)
    // A discarded framebuffer may read zero between presentations. Stable bytes alone are not
    // proof of a stopped renderer: require the actual production draw counter and shader clock.
    check(sample.drawCalls === 0 && sample.runningCss === 0, 'paused work still animates')
    for (const frame of rows)
      check(
        frame.state === state &&
          frame.active === active &&
          frame.paused === paused &&
          frame.motion === 'still',
        'paused semantic state changed',
      )
    check(rows[0]!.time === rows[1]!.time, 'paused GPU shader clock advanced')
  }
  const result = object(input)
  check(result.component === 'web.agent-brand' && result.ok === true, 'driver incomplete')
  check(Array.isArray(result.browserErrors) && result.browserErrors.length === 0, 'browser errors')
  check(
    result.readOnlyPosts === 0 && result.videoAfterAuth === true,
    'unexpected mutation or unsafe recording boundary',
  )
  const visibility = object(result.visibilityProbe)
  check(
    visibility.component === 'harness.contrast-visibility',
    'native disclosure self-test absent',
  )
  for (const key of ['closed', 'opened', 'nestedOpened', 'reclosed', 'summaryChecked']) {
    const row = object(visibility[key])
    check(
      finite(row.checked) &&
        row.checked > 0 &&
        Array.isArray(row.undecidable) &&
        row.undecidable.length === 0,
      'native disclosure scan incomplete',
    )
    const offenders = array(row.offenders)
    const expected =
      key === 'opened'
        ? ['a#probe-outer-link']
        : key === 'nestedOpened'
          ? ['a#probe-outer-link', 'a#probe-inner-link']
          : key === 'summaryChecked'
            ? ['span#probe-summary-low.low']
            : []
    check(
      JSON.stringify(offenders.map((item) => item.selector)) === JSON.stringify(expected),
      'closed/open native details visibility is misclassified',
    )
    for (const offender of offenders)
      check(
        contrastRatio(color(offender.color), color(offender.background)) < 4.5,
        'open low-contrast self-test was not really rejected',
      )
    if (key === 'closed' || key === 'summaryChecked')
      check(
        row.outerOpen === false && row.innerOpen === false,
        'closed disclosure self-test was not actually closed',
      )
    if (key === 'opened')
      check(
        row.outerOpen === true && row.innerOpen === false,
        'outer details was not really opened',
      )
    if (key === 'nestedOpened')
      check(
        row.outerOpen === true && row.innerOpen === true,
        'nested details was not really opened',
      )
    if (key === 'reclosed')
      check(
        row.outerOpen === false && row.innerOpen === true,
        'closed ancestor did not hide nested open disclosure',
      )
  }
  const runs = array(result.runs)
  check(
    JSON.stringify(runs.map((row) => row.width)) === '[1440,390,320]',
    'missing real Run viewports',
  )
  const ids = new Set<string>(),
    tasks = new Set<string>()
  let observedCompletion = false
  for (const run of runs) {
    check(
      typeof run.runId === 'string' && /^[a-f0-9-]{36}$/.test(run.runId) && !ids.has(run.runId),
      'missing or repeated real Run',
    )
    ids.add(run.runId as string)
    check(
      typeof run.taskId === 'string' &&
        /^[a-f0-9-]{36}$/.test(run.taskId) &&
        !tasks.has(run.taskId),
      'missing or repeated real task',
    )
    tasks.add(run.taskId as string)
    check(
      run.status === 'completed' &&
        run.approved === true &&
        finite(run.artifactCount) &&
        run.artifactCount > 0,
      'real execution did not finish',
    )
    check(
      run.memberReadOnly === true && run.runtimeObserved === true,
      'member/runtime evidence absent',
    )
    check(finite(run.runtimePid) && run.runtimePid > 0, 'missing real Runtime pid')
    const samples = array(run.samples)
    check(
      JSON.stringify(samples.map((row) => row.theme)) === '["light","dark"]',
      'missing GPU themes',
    )
    for (const sample of samples) {
      moving(sample)
      visibleText(sample.visibleText)
    }
    still(run.approval, 'approval', false, false)
    const states = array(run.states).filter((row) => row.runId === run.runId)
    const names = states.map((row) => row.state)
    check(
      names.includes('thinking') && names.includes('approval') && names.includes('completed'),
      'missing real state transitions',
    )
    check(
      names.indexOf('thinking') < names.indexOf('approval') &&
        names.indexOf('approval') < names.indexOf('completed'),
      'state order is not causal',
    )
    for (const state of states) {
      check(
        typeof state.active === 'boolean' && typeof state.completing === 'boolean',
        'missing actual state flags',
      )
      check(
        state.active !== true || ['thinking', 'tool', 'finalizing'].includes(state.state as string),
        'non-working state pretends to work',
      )
      check(
        state.completing !== true || (state.state === 'completed' && state.active === false),
        'completion revives business work',
      )
      if (state.completing === true) observedCompletion = true
    }
  }
  check(observedCompletion, 'finite live completion transition was not observed')
  const completionStates = array(runs[0]!.states).filter((row) => row.runId === runs[0]!.runId)
  const completedAt = completionStates.findIndex((row) => row.state === 'completed')
  const lastApproval = completionStates.findLastIndex(
    (row, index) => index < completedAt && row.state === 'approval',
  )
  const activeAfterApproval = completionStates.findIndex(
    (row, index) =>
      index > lastApproval &&
      index < completedAt &&
      row.active === true &&
      ['thinking', 'tool', 'finalizing'].includes(row.state as string),
  )
  const unknownAfterActive = completionStates.findIndex(
    (row, index) =>
      index > activeAfterApproval &&
      index < completedAt &&
      row.state === 'unknown' &&
      row.active === false,
  )
  check(
    lastApproval >= 0 &&
      activeAfterApproval > lastApproval &&
      unknownAfterActive > activeAfterApproval &&
      completedAt > unknownAfterActive,
    'paced fixture did not observe real active-to-unknown-to-completed',
  )
  const lastCompletion = completionStates.at(-1)!
  check(
    lastCompletion.state === 'completed' &&
      lastCompletion.active === false &&
      lastCompletion.completing === false &&
      lastCompletion.renderer === 'fallback' &&
      lastCompletion.motion === 'still',
    'observed completion did not converge after GPU interruption',
  )
  const completionLoss = object(result.completionLoss),
    interrupted = object(completionLoss.fault)
  const armedAt = object(interrupted.armedAt),
    armScroll = object(armedAt.scroll),
    armRect = object(armedAt.rect)
  check(
    ['thinking', 'tool', 'finalizing'].includes(armedAt.state as string) &&
      armedAt.active === true &&
      armedAt.paused === false &&
      armedAt.renderer === 'webgl' &&
      armedAt.motion === 'running' &&
      armedAt.followingStopped === true,
    'completion loss was not armed during visible user-controlled work',
  )
  check(
    finite(armScroll.height) &&
      finite(armScroll.client) &&
      armScroll.height > armScroll.client &&
      finite(armRect.width) &&
      armRect.width > 0 &&
      finite(armRect.height) &&
      armRect.height > 0,
    'completion probe lacked genuine reading geometry',
  )
  check(
    finite(armRect.x) &&
      armRect.x >= 0 &&
      finite(armRect.y) &&
      armRect.y >= 0 &&
      (armRect.x as number) + (armRect.width as number) <= 1440 &&
      (armRect.y as number) + (armRect.height as number) <= 960,
    'armed core is not within the actual viewport',
  )
  check(completionLoss.runId === runs[0]!.runId, 'completion loss is not tied to the real 1440 Run')
  check(
    interrupted.armed === true &&
      interrupted.attempted === true &&
      interrupted.lost === true &&
      interrupted.triggerState === 'completed' &&
      interrupted.triggerActive === false &&
      interrupted.hadCompleting === true &&
      interrupted.rendererBefore === 'webgl' &&
      interrupted.reason === null,
    'completion was not genuinely interrupted by native GPU loss',
  )
  terminalResources(completionLoss.terminal)
  const keyboard = object(result.keyboard)
  check(keyboard.input === 'keyboard', 'real keyboard modality missing')
  moving(keyboard)
  still(result.reduced, 'thinking', true, true)
  const fault = object(result.contextLoss),
    fallback = object(fault.fallback)
  check(
    fault.before === 'approval' &&
      fault.after === 'approval' &&
      fault.lost === true &&
      fault.restored === true &&
      fault.renderer === 'webgl',
    'GPU fault did not restore the same real phase',
  )
  check(
    fallback.state === 'approval' && fallback.renderer === 'fallback' && fallback.visible === true,
    'context loss did not expose a legible fallback',
  )
  const fallbackRun = object(result.fallback)
  check(
    typeof fallbackRun.runId === 'string' &&
      /^[a-f0-9-]{36}$/.test(fallbackRun.runId) &&
      !ids.has(fallbackRun.runId),
    'missing independent fallback Run',
  )
  check(
    fallbackRun.completed === true &&
      finite(fallbackRun.blockedCalls) &&
      fallbackRun.blockedCalls > 0,
    'GPU failure path was not really driven',
  )
  for (const key of ['on', 'off', 'resumed']) {
    const state = object(fallbackRun[key])
    check(
      state.state === 'thinking' &&
        state.active === true &&
        state.renderer === 'fallback' &&
        state.visible === true,
      'fallback did not retain truthful work',
    )
    check(
      key === 'off'
        ? state.paused === true && state.runningCss === 0
        : state.paused === false && finite(state.runningCss) && state.runningCss > 0,
      'fallback offscreen animation policy failed',
    )
  }
  const off = object(fallbackRun.off),
    scroll = object(fallbackRun.scrollFacts)
  check(
    finite(scroll.top) &&
      scroll.top > 0 &&
      finite(scroll.range) &&
      scroll.range > 0 &&
      finite(off.y) &&
      finite(scroll.y) &&
      off.y < scroll.y,
    'fallback was not genuinely scrolled out of view',
  )
  const permanent = object(result.lostBeforeCompletion),
    permanentFault = object(permanent.fault),
    permanentObserved = object(permanent.observation)
  check(
    typeof permanent.runId === 'string' &&
      /^[a-f0-9-]{36}$/.test(permanent.runId) &&
      !ids.has(permanent.runId) &&
      permanent.runId !== fallbackRun.runId,
    'permanent GPU loss was not driven by an independent Run',
  )
  check(
    permanent.runStatus === 'completed' && permanent.approved === true,
    'permanently lost GPU Run did not really finish with approval',
  )
  check(
    permanentFault.beforeState === 'thinking' &&
      permanentFault.beforeRenderer === 'webgl' &&
      permanentFault.lost === true &&
      permanentFault.contextLost === true &&
      permanentFault.afterState === 'thinking' &&
      permanentFault.afterRenderer === 'fallback',
    'GPU was not genuinely lost during thinking',
  )
  check(
    permanentObserved.restoredEvents === 0 && permanentObserved.sawCompleting === false,
    'lost GPU was restored or began an invalid completion animation',
  )
  terminalResources(permanent.terminal)
  const rows = array(result.brandRows)
  check(
    JSON.stringify(rows.map((row) => [row.width, row.theme])) ===
      '[[1440,"light"],[1440,"dark"],[390,"light"],[390,"dark"],[320,"light"],[320,"dark"]]',
    'incomplete brand layouts',
  )
  const tokenReports: Record<string, unknown>[] = []
  for (const row of rows) {
    const dark = row.theme === 'dark'
    for (const kind of ['normal', 'sendNormal']) {
      const pair = text(row[kind])
      same(pair.background, [25, 91, 221])
      same(pair.foreground, [255, 255, 255])
    }
    for (const kind of ['hover', 'sendHover']) {
      const pair = text(row[kind])
      same(pair.background, [18, 71, 177])
      same(pair.foreground, [255, 255, 255])
    }
    const selected = text(row.selected)
    same(selected.background, dark ? [32, 55, 89] : [232, 241, 255])
    same(selected.foreground, dark ? [179, 211, 255] : [18, 63, 136])
    ring(object(row.focus).shadow)
    const geometry = object(row.geometry)
    check(
      geometry.viewport === row.width &&
        finite(geometry.scroll) &&
        geometry.scroll > 0 &&
        geometry.scroll <= Number(row.width),
      'page overflow',
    )
    check(row.historyStatic === true, 'historical completion replays celebration')
    check(row.historyCanvasCount === 0, 'historical completion allocated a GPU canvas')
    if (row.width === 1440) {
      const w = text(row.w)
      same(w.background, [25, 91, 221])
      same(w.foreground, [255, 255, 255])
      check(
        typeof w.shadow === 'string' && w.shadow.includes('rgb(19, 184, 166)'),
        'brand mark missing teal detail',
      )
      tokenReports.push(object(row.tokenFacts))
    }
  }
  check(
    JSON.stringify(tokenReports.map((row) => row.theme)) === '["light","dark"]',
    'missing resolved theme reports',
  )
  const expectedPairs = [
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
  for (const report of tokenReports) {
    const pairs = array(report.textPairs)
    check(
      JSON.stringify(pairs.map((pair) => [pair.fg, pair.bg])) === JSON.stringify(expectedPairs),
      'missing resolved text pairs',
    )
    for (const pair of pairs) text(pair)
    const focus = array(report.focus)
    check(
      JSON.stringify(focus.map((row) => row.bg)) === JSON.stringify(backgrounds),
      'missing resolved focus backgrounds',
    )
    for (const row of focus) {
      const layers = ring(row.shadow),
        bg = color(row.background)
      check(
        layers.some((layer) => contrastRatio(layer.color, bg) >= 3),
        'focus contrast below AA',
      )
    }
  }
  return {
    component: 'web.agent-brand.verify',
    ok: true,
    checks,
    runs: runs.length,
    layouts: rows.length,
    textPairs: 32,
    focusBackgrounds: 22,
  }
}
