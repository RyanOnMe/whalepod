/** P1-437: real Run facts drive the branded Agent core; probes never assign UI phases. */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sweepContrast } from './contrast-sweep.js'
import { compositeOver, contrastRatio, parseCssColor, WHITE } from '../contrast.js'
import {
  env,
  fillAndEnter,
  getRunFact,
  hubApi,
  nodeControl,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  setRuntimeFixture,
  showAgentCreation,
  startNode,
  stopNode,
  waitForRunStatus,
  waitForRuntimeReleased,
} from './helpers.js'

const tag = randomUUID().slice(0, 8)
const evidence = join(process.cwd(), 'artifacts/evidence/tidal-brand-theme', tag)
const password = 'correct horse battery staple'
const textPairs = [
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
const focusBackgrounds = [
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
type Theme = 'light' | 'dark'
interface GpuConsoleObservation {
  surface: string
  level: string
  message: string
}
function observeGpuConsole(page: Page, surface: string, logs: GpuConsoleObservation[]) {
  page.on('console', (message) => {
    if (!['warning', 'error'].includes(message.type())) return
    const raw = message.text()
    // Only Chromium/WebGL driver prefixes, never arbitrary app console output or arguments.
    if (
      !/^(?:\[\.WebGL-|WebGL:|ANGLE:|\[GroupMarkerNotSet\(|GPU process|Failed to create (?:a )?WebGL)/.test(
        raw,
      )
    )
      return
    if (/Bearer|Cookie|password|setup-token|pairing-code/i.test(raw)) return
    const safe = raw
      .replace(/https?:\/\/[^\s)]+/g, '<url>')
      .replace(/(?:\/Users\/|\/home\/|\/private\/var\/folders\/)[^\s"']+/g, '<path>')
      .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
      .slice(0, 400)
    if (logs.length < 32 && !logs.some((row) => row.surface === surface && row.message === safe))
      logs.push({ surface, level: message.type(), message: safe })
  })
}
interface ObservedState {
  runId: string
  state: string
  active: boolean
  completing: boolean
  paused: boolean
  renderer: string | null
  motion: string | null
  documentVisible: boolean
}
declare global {
  interface Window {
    __agentBrandStates?: ObservedState[]
    __agentBrandObserver?: MutationObserver
    __agentBrandBlocked?: number
    __agentBrandCompletionLoss?: {
      armed: boolean
      attempted: boolean
      lost: boolean
      triggerState: string | null
      triggerActive: boolean
      hadCompleting: boolean
      rendererBefore: string | null
      reason: string | null
      armedAt: {
        state: string | null
        active: boolean
        paused: boolean
        renderer: string | null
        motion: string | null
        followingStopped: boolean
        rect: { x: number; y: number; width: number; height: number }
        scroll: { top: number; height: number; client: number }
      }
    }
    __agentBrandLostBeforeCompletion?: { restoredEvents: number; sawCompleting: boolean }
    __agentBrandHoverFailure?: {
      target: string
      hovered: boolean
      connected: boolean
      uiInput: string | null
      background: string
      rect: { x: number; y: number; width: number; height: number }
      point: { x: number; y: number }
      hitTag: string | null
      hitClass: string | null
    }
    __agentBrandGpuFailure?: {
      reason: string
      renderer: string | null
      state: string | null
      active: boolean
      paused: boolean
      motion: string | null
      canvasPresent: boolean
      connected: boolean
      width: number
      height: number
      visibility: string
      error: number | null
    }
  }
}

async function theme(page: Page, value: Theme) {
  // Existing application theme contract; this lane does not add a theme-setting product flow.
  await page.evaluate(
    (dark) => document.body.toggleAttribute('data-ds-dark-theme', dark),
    value === 'dark',
  )
}
async function colors(node: Locator) {
  return node.evaluate((element) => {
    const css = getComputedStyle(element)
    return { foreground: css.color, background: css.backgroundColor, shadow: css.boxShadow }
  })
}
async function measureTokens(page: Page, value: Theme) {
  const facts = await page.evaluate(
    ({ pairs, backgrounds }) => {
      const probe = document.createElement('span')
      probe.dataset.agentBrandProbe = ''
      probe.style.cssText =
        'position:fixed;left:-1000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none'
      document.body.append(probe)
      const pairsRead = pairs.map(([fg, bg]) => {
        probe.style.color = `var(${fg})`
        probe.style.backgroundColor = `var(${bg})`
        const css = getComputedStyle(probe)
        return { fg, bg, foreground: css.color, background: css.backgroundColor }
      })
      probe.style.boxShadow = 'var(--focus-ring)'
      const focusRead = backgrounds.map((bg) => {
        probe.style.backgroundColor = `var(${bg})`
        const css = getComputedStyle(probe)
        return { bg, background: css.backgroundColor, shadow: css.boxShadow }
      })
      probe.remove()
      return { textPairs: pairsRead, focus: focusRead }
    },
    { pairs: textPairs, backgrounds: focusBackgrounds },
  )
  return { theme: value, ...facts }
}

async function contrastVisibilityProbe(browser: import('@playwright/test').Browser) {
  // Anonymous, non-product page: this self-test drives the native disclosure, not app state.
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.setContent(`<!doctype html><html><head><style>body{background:white;color:black;font:16px sans-serif}a,.low{color:white;background:white}</style></head><body>
      <details id="outer"><summary>展开外层</summary><a id="probe-outer-link" href="#outer-target">低对比外层链接</a>
        <details id="inner"><summary>展开内层</summary><a id="probe-inner-link" href="#inner-target">低对比内层链接</a></details>
      </details></body></html>`)
    const read = async () => {
      const sweep = await sweepContrast(page)
      const disclosure = await page.evaluate(() => ({
        outerOpen: document.querySelector<HTMLDetailsElement>('#outer')?.open ?? false,
        innerOpen: document.querySelector<HTMLDetailsElement>('#inner')?.open ?? false,
      }))
      return {
        ...disclosure,
        checked: sweep.checked,
        offenders: sweep.offenders.map(({ selector, color, background, ratio }) => ({
          selector,
          color,
          background,
          ratio,
        })),
        undecidable: sweep.undecidable.map(({ selector, reason }) => ({ selector, reason })),
      }
    }
    const closed = await read()
    await page.locator('#outer > summary').click()
    await expect(page.locator('#outer')).toHaveAttribute('open', '')
    const opened = await read()
    await page.locator('#inner > summary').click()
    await expect(page.locator('#inner')).toHaveAttribute('open', '')
    const nestedOpened = await read()
    await page.locator('#outer > summary').click()
    await expect(page.locator('#outer')).not.toHaveAttribute('open')
    const reclosed = await read()
    await page.setContent(`<!doctype html><html><head><style>body{background:white;color:black;font:16px sans-serif}.low{color:white;background:white}</style></head><body>
      <details><summary><span class="low" id="probe-summary-low">低对比可见摘要</span></summary><span class="low" id="probe-body-low">隐藏正文</span></details>
      </body></html>`)
    const summaryChecked = await read()
    const facts = {
      component: 'harness.contrast-visibility',
      closed,
      opened,
      nestedOpened,
      reclosed,
      summaryChecked,
    }
    await writeFile(join(evidence, 'visibility-probe.json'), JSON.stringify(facts, null, 2) + '\n')
    expect(closed.checked).toBeGreaterThan(0)
    expect(closed.offenders).toEqual([])
    expect(opened.offenders.map((row) => row.selector)).toEqual(['a#probe-outer-link'])
    expect(nestedOpened.offenders.map((row) => row.selector)).toEqual([
      'a#probe-outer-link',
      'a#probe-inner-link',
    ])
    expect(reclosed.innerOpen).toBe(true)
    expect(reclosed.offenders).toEqual([])
    expect(summaryChecked.offenders.map((row) => row.selector)).toEqual([
      'span#probe-summary-low.low',
    ])
    for (const row of [closed, opened, nestedOpened, reclosed, summaryChecked])
      expect(row.undecidable).toEqual([])
    return facts
  } finally {
    await context.close()
  }
}

/** Read actual same-canvas pixels inside rAF, after the production draw scheduled for that frame. */
async function gpu(core: Locator, gap = 10) {
  return core.evaluate(async (root, frames) => {
    const canvas = root.querySelector('canvas')
    let context: WebGLRenderingContext | null = null
    let creationThrew = false
    try {
      context = canvas?.getContext('webgl') ?? null
    } catch {
      creationThrew = true
    }
    const reason = !canvas
      ? 'missing-canvas'
      : creationThrew
        ? 'creation-threw'
        : !context
          ? 'creation-null'
          : context.isContextLost()
            ? 'context-lost'
            : 'ready'
    if (reason !== 'ready' || !canvas || !context) {
      const diagnostic = {
        reason,
        renderer: root.getAttribute('data-renderer'),
        state: root.getAttribute('data-state'),
        active: root.hasAttribute('data-active'),
        paused: root.hasAttribute('data-paused'),
        motion: root.getAttribute('data-motion'),
        canvasPresent: canvas !== null,
        connected: canvas?.isConnected ?? false,
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        visibility: document.visibilityState,
        error: context?.getError() ?? null,
      }
      window.__agentBrandGpuFailure = diagnostic
      throw new Error('Agent GPU unavailable: ' + JSON.stringify(diagnostic))
    }
    const gl = context
    const observed = canvas as HTMLCanvasElement & { __brandGpu?: { draws: number } }
    if (!observed.__brandGpu) {
      const counter = { draws: 0 },
        draw = gl.drawArrays.bind(gl)
      gl.drawArrays = (mode, first, count) => {
        counter.draws++
        draw(mode, first, count)
      }
      observed.__brandGpu = counter
    }
    const counter = observed.__brandGpu
    const start = counter.draws
    const read = () => {
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
      gl.readPixels(
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
      let hash = 2166136261,
        nonempty = 0,
        colored = 0,
        blue = 0,
        teal = 0
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i]!, 16777619)
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i]!,
          g = pixels[i + 1]!,
          b = pixels[i + 2]!,
          a = pixels[i + 3]!
        if (a < 24) continue
        nonempty++
        if (Math.max(r, g, b) - Math.min(r, g, b) > 18) colored++
        if (b > r * 1.1 && b > g * 1.15) blue++
        if (g > r * 1.1 && g > b * 0.9) teal++
      }
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
      const location = program && gl.getUniformLocation(program, 'uTime')
      return {
        hash: (hash >>> 0).toString(16),
        nonempty,
        colored,
        blue,
        teal,
        time: program && location ? Number(gl.getUniform(program, location)) : null,
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
        error: gl.getError(),
        state: root.getAttribute('data-state'),
        renderer: root.getAttribute('data-renderer'),
        active: root.hasAttribute('data-active'),
        paused: root.hasAttribute('data-paused'),
        motion: root.getAttribute('data-motion'),
      }
    }
    const snapshots: ReturnType<typeof read>[] = []
    await new Promise<void>((resolve) => {
      let frame = 0
      const tick = () => {
        frame++
        if (frame === 2 || frame === frames + 2) snapshots.push(read())
        if (frame >= frames + 2) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return {
      frames: snapshots,
      drawCalls: counter.draws - start,
      runningCss: root
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
    }
  }, gap)
}
async function observeStates(page: Page) {
  await page.evaluate(() => {
    window.__agentBrandObserver?.disconnect()
    window.__agentBrandStates = []
    const read = () => {
      for (const node of document.querySelectorAll('[data-testid="agent-state-core"]')) {
        const row = {
          runId: node.closest('.conversation-run')?.getAttribute('data-run-id') ?? '',
          state: node.getAttribute('data-state') ?? '',
          active: node.hasAttribute('data-active'),
          completing: node.hasAttribute('data-completing'),
          paused: node.hasAttribute('data-paused'),
          renderer: node.getAttribute('data-renderer'),
          motion: node.getAttribute('data-motion'),
          documentVisible: document.visibilityState === 'visible',
        }
        const last = window.__agentBrandStates!.at(-1)
        if (JSON.stringify(row) !== JSON.stringify(last)) window.__agentBrandStates!.push(row)
      }
    }
    window.__agentBrandObserver = new MutationObserver(read)
    window.__agentBrandObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'data-state',
        'data-active',
        'data-completing',
        'data-paused',
        'data-renderer',
        'data-motion',
      ],
    })
    read()
  })
}

async function contextFault(core: Locator) {
  const before = await core.getAttribute('data-state')
  const events = await core.evaluate(async (root) => {
    const canvas = root.querySelector('canvas')!
    const extension = canvas.getContext('webgl')?.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('WEBGL_lose_context is required for the real fault probe')
    const lost = new Promise<boolean>((resolve) =>
      canvas.addEventListener('webglcontextlost', () => resolve(true), { once: true }),
    )
    extension.loseContext()
    await lost
    const fallback = {
      state: root.getAttribute('data-state'),
      renderer: root.getAttribute('data-renderer'),
      visible:
        getComputedStyle(root.querySelector('.cu-agent-core-fallback')!).visibility === 'visible',
    }
    const restored = new Promise<boolean>((resolve) =>
      canvas.addEventListener('webglcontextrestored', () => resolve(true), { once: true }),
    )
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    extension.restoreContext()
    await restored
    return { lost: true, restored: true, fallback }
  })
  await expect(core).toHaveAttribute('data-renderer', 'webgl')
  return {
    before,
    ...events,
    after: await core.getAttribute('data-state'),
    renderer: await core.getAttribute('data-renderer'),
  }
}
async function armLossDuringCompletion(core: Locator) {
  await core.evaluate((root) => {
    const box = root.getBoundingClientRect(),
      scroll = root.closest<HTMLElement>('[data-testid="conversation-scroll"]')!
    const armedAt = {
      state: root.getAttribute('data-state'),
      active: root.hasAttribute('data-active'),
      paused: root.hasAttribute('data-paused'),
      renderer: root.getAttribute('data-renderer'),
      motion: root.getAttribute('data-motion'),
      followingStopped: Boolean(document.querySelector('[data-testid="conversation-jump"]')),
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      scroll: { top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight },
    }
    const observation = {
      armed: true,
      armedAt,
      attempted: false,
      lost: false,
      triggerState: null as string | null,
      triggerActive: false,
      hadCompleting: false,
      rendererBefore: null as string | null,
      reason: null as string | null,
    }
    window.__agentBrandCompletionLoss = observation
    const observer = new MutationObserver(() => {
      if (!root.hasAttribute('data-completing') || root.getAttribute('data-state') !== 'completed')
        return
      observer.disconnect()
      observation.attempted = true
      observation.triggerState = root.getAttribute('data-state')
      observation.triggerActive = root.hasAttribute('data-active')
      observation.hadCompleting = true
      observation.rendererBefore = root.getAttribute('data-renderer')
      const canvas = root.querySelector('canvas'),
        gl = canvas?.getContext('webgl')
      const extension = gl?.getExtension('WEBGL_lose_context')
      if (!canvas || !gl || gl.isContextLost() || !extension) {
        observation.reason = 'completion-had-no-working-GPU'
        return
      }
      canvas.addEventListener(
        'webglcontextlost',
        () => {
          observation.lost = true
        },
        { once: true },
      )
      extension.loseContext()
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-completing'] })
  })
}
async function terminalSnapshot(core: Locator) {
  return core.evaluate((root) => {
    const marker = root.querySelector('.cu-agent-core-marker')!
    const css = getComputedStyle(marker),
      box = marker.getBoundingClientRect()
    return {
      state: root.getAttribute('data-state'),
      active: root.hasAttribute('data-active'),
      completing: root.hasAttribute('data-completing'),
      renderer: root.getAttribute('data-renderer'),
      motion: root.getAttribute('data-motion'),
      canvasCount: root.querySelectorAll('canvas').length,
      marker: marker.textContent,
      markerVisible:
        css.display !== 'none' &&
        css.visibility === 'visible' &&
        Number(css.opacity) === 1 &&
        box.width > 0 &&
        box.height > 0,
      runningCss: root
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
    }
  })
}
async function assertTerminalResources(core: Locator) {
  await expect(core).toHaveAttribute('data-state', 'completed')
  await expect(core).not.toHaveAttribute('data-active')
  await expect(core).not.toHaveAttribute('data-completing')
  await expect(core.locator('canvas')).toHaveCount(0)
  await expect(core.locator('.cu-agent-core-marker')).toHaveText('✓')
  await expect(core.locator('.cu-agent-core-marker')).toBeVisible()
  await expect(core.locator('.cu-agent-core-marker')).toHaveCSS('opacity', '1')
  await expect.poll(async () => (await terminalSnapshot(core)).runningCss).toBe(0)
  return terminalSnapshot(core)
}
async function recordCompletionInterruption(page: Page, core: Locator, runId: string) {
  try {
    await expect
      .poll(() => page.evaluate(() => window.__agentBrandCompletionLoss?.lost ?? false))
      .toBe(true)
    await assertTerminalResources(core)
  } finally {
    const fault = await page.evaluate(() => window.__agentBrandCompletionLoss ?? null),
      terminal = await terminalSnapshot(core)
    const sequence = await page.evaluate(
      (id) => (window.__agentBrandStates ?? []).filter((row) => row.runId === id),
      runId,
    )
    await writeFile(
      join(evidence, 'completion-loss.json'),
      JSON.stringify(
        { component: 'harness.agent-completion-loss', runId, fault, terminal, sequence },
        null,
        2,
      ) + '\n',
    )
  }
  return {
    runId,
    fault: await page.evaluate(() => window.__agentBrandCompletionLoss ?? null),
    terminal: await terminalSnapshot(core),
  }
}
async function loseWithoutRestoring(core: Locator) {
  return core.evaluate(async (root) => {
    const canvas = root.querySelector('canvas'),
      gl = canvas?.getContext('webgl'),
      extension = gl?.getExtension('WEBGL_lose_context')
    if (!canvas || !gl || gl.isContextLost() || !extension)
      throw new Error('Expected real GPU before permanent context-loss probe')
    const observation = { restoredEvents: 0, sawCompleting: false }
    window.__agentBrandLostBeforeCompletion = observation
    canvas.addEventListener('webglcontextrestored', () => observation.restoredEvents++)
    const observer = new MutationObserver((records) => {
      if (
        root.hasAttribute('data-completing') ||
        records.some((record) => record.oldValue !== null)
      )
        observation.sawCompleting = true
    })
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-completing'],
      attributeOldValue: true,
    })
    const beforeState = root.getAttribute('data-state'),
      beforeRenderer = root.getAttribute('data-renderer')
    const lost = new Promise<void>((resolve) =>
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    )
    extension.loseContext()
    await lost
    return {
      beforeState,
      beforeRenderer,
      lost: true,
      contextLost: gl.isContextLost(),
      afterState: root.getAttribute('data-state'),
      afterRenderer: root.getAttribute('data-renderer'),
    }
  })
}
async function visibleThinkingText(page: Page, width: number, value: Theme) {
  // Wait finite transitions only. The live Agent and stream cursor may legitimately keep moving.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getComputedTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0)
  const swept = await sweepContrast(page)
  const chip = page.getByTestId('instruction-state').first()
  await expect(chip).toHaveText('已受理')
  const actual = await chip.evaluate((element) => {
    const css = getComputedStyle(element),
      box = element.getBoundingClientRect()
    const layers = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      layers.push({
        background: style.backgroundColor,
        opacity: Number(style.opacity),
        image: style.backgroundImage,
        backdrop: style.backdropFilter,
      })
    }
    return {
      className: element.getAttribute('class') ?? '',
      foreground: css.color,
      rawBackground: css.backgroundColor,
      layers,
      visible:
        box.width > 0 &&
        box.height > 0 &&
        css.visibility === 'visible' &&
        box.bottom > 0 &&
        box.top < innerHeight,
    }
  })
  let background = WHITE
  for (const layer of [...actual.layers].reverse())
    background = compositeOver(parseCssColor(layer.background), background)
  const foreground = compositeOver(parseCssColor(actual.foreground), background)
  const acceptedChip = {
    ...actual,
    label: '已受理',
    background: `rgb(${background.r}, ${background.g}, ${background.b})`,
    ratio: contrastRatio(foreground, background),
  }
  const facts = {
    checked: swept.checked,
    offenders: swept.offenders.map(({ selector, color, background, ratio }) => ({
      selector,
      color,
      background,
      ratio,
    })),
    undecidable: swept.undecidable.map(({ selector, reason }) => ({ selector, reason })),
    acceptedChip,
  }
  // No text bodies are retained, including failed samples. The one short chip label is fixed UI copy.
  await writeFile(
    join(evidence, `visible-text-${value}-${width}.json`),
    JSON.stringify(facts, null, 2) + '\n',
  )
  expect(facts.checked).toBeGreaterThan(0)
  expect(facts.offenders).toEqual([])
  expect(facts.undecidable).toEqual([])
  expect(
    actual.layers.every(
      (layer) => layer.opacity === 1 && layer.image === 'none' && layer.backdrop === 'none',
    ),
  ).toBe(true)
  expect(acceptedChip.visible).toBe(true)
  expect(acceptedChip.ratio).toBeGreaterThanOrEqual(4.5)
  return facts
}
async function settledPosition(node: Locator) {
  await node.scrollIntoViewIfNeeded()
  await node.evaluate(async (element) => {
    await new Promise<void>((resolve, reject) => {
      let previous = '',
        stable = 0
      const deadline = performance.now() + 3000
      const tick = () => {
        const box = element.getBoundingClientRect()
        const next = JSON.stringify([box.x, box.y, box.width, box.height])
        stable = next === previous ? stable + 1 : 0
        previous = next
        if (stable >= 5) resolve()
        else if (performance.now() > deadline)
          reject(new Error('Brand action did not reach a stable position'))
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
}
async function actualHover(page: Page, node: Locator, target: string) {
  await settledPosition(node)
  const box = (await node.boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await node.hover({ position: { x: box.width / 2, y: box.height / 2 } })
  try {
    await expect.poll(() => node.evaluate((element) => element.matches(':hover'))).toBe(true)
    await expect(page.locator('html')).toHaveAttribute('data-ui-input', 'pointer')
    await expect(node).toHaveCSS('background-color', 'rgb(18, 71, 177)')
    expect(await node.evaluate((element) => element.matches(':hover'))).toBe(true)
  } catch (error) {
    await node.evaluate(
      (element, input) => {
        const box = element.getBoundingClientRect()
        const hit = document.elementFromPoint(input.point.x, input.point.y)
        window.__agentBrandHoverFailure = {
          target: input.target,
          hovered: element.matches(':hover'),
          connected: element.isConnected,
          uiInput: document.documentElement.getAttribute('data-ui-input'),
          background: getComputedStyle(element).backgroundColor,
          rect: { x: box.x, y: box.y, width: box.width, height: box.height },
          point: input.point,
          hitTag: hit?.tagName ?? null,
          hitClass: hit?.getAttribute('class') ?? null,
        }
      },
      { target, point },
    )
    throw error
  }
}
async function recordBrand(page: Page, taskId: string, width: number, value: Theme) {
  await page.setViewportSize({ width, height: 960 })
  await page.goto('/')
  await theme(page, value)
  // These real queries change the height above the form. Resolve them before placing a pointer.
  await expect(
    page.getByRole('heading', { name: 'WhalePod 潮汐工作区', exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('projects-skeleton')).toHaveCount(0)
  await expect(page.locator('.personal-attention')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('button', { name: '重新读取待办', exact: true })).toHaveCount(0)
  await expect
    .poll(() =>
      page
        .locator('.personal-attention,.project-list')
        .evaluateAll((nodes) =>
          nodes.every((node) =>
            node
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState !== 'running'),
          ),
        ),
    )
    .toBe(true)
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  const primary = page
    .getByRole('form', { name: '创建项目' })
    .getByRole('button', { name: '创建项目', exact: true })
  await expect(primary).toBeEnabled()
  await page.mouse.move(0, 0)
  const normal = await colors(primary)
  await actualHover(page, primary, 'project-primary')
  const hover = await colors(primary)
  await primary.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(primary).toBeFocused()
  const focus = await colors(primary)
  let w = null
  if (width === 1440) w = await colors(page.locator('.app-rail-brand'))
  else await page.getByLabel('主导航菜单', { exact: true }).click()
  const selected = await colors(page.locator("nav a[aria-current='page']").first())
  if (width !== 1440) await page.getByLabel('主导航菜单', { exact: true }).click()
  const tokenFacts = width === 1440 ? await measureTokens(page, value) : null
  await page.getByRole('button', { name: '收起', exact: true }).first().click()
  await page.screenshot({ path: join(evidence, `brand-${value}-${width}.png`) })
  await page.goto(`/tasks/${taskId}`)
  await theme(page, value)
  await page.getByLabel('指令', { exact: true }).fill('未发送的品牌验收草稿')
  const send = page.locator('.workspace-dock .instruction-send')
  await expect(send).toBeEnabled()
  await page.mouse.move(0, 0)
  const sendNormal = await colors(send)
  await actualHover(page, send, 'composer-send')
  const sendHover = await colors(send)
  await page.getByLabel('指令', { exact: true }).clear()
  const history = page.getByTestId('agent-state-core')
  await expect(history).toHaveAttribute('data-state', 'completed')
  await expect(history).not.toHaveAttribute('data-completing')
  const historyCanvasCount = await history.locator('canvas').count()
  expect(historyCanvasCount).toBe(0)
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  return {
    width,
    theme: value,
    normal,
    hover,
    focus,
    selected,
    w,
    sendNormal,
    sendHover,
    geometry,
    historyStatic: true,
    historyCanvasCount,
    tokenFacts,
  }
}

async function diagnosticProbe<T>(
  code: string,
  read: () => Promise<T>,
): Promise<{ available: true; data: T } | { available: false; code: string }> {
  // Diagnostic-only bound: never replace the original failure with a stalled observer.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ available: false; code: string }>((resolve) => {
    timer = setTimeout(() => resolve({ available: false, code: 'DIAGNOSTIC_TIMEOUT' }), 2000)
  })
  try {
    return await Promise.race([
      read()
        .then((data) => ({ available: true as const, data }))
        .catch(() => ({ available: false as const, code })),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
async function productionFailureTriage(sequence: ObservedState[] | null) {
  const runIds = [
    ...new Set((sequence ?? []).map((row) => row.runId).filter((id) => /^[a-f0-9-]{36}$/.test(id))),
  ]
  const runs = []
  for (const runId of runIds) {
    const observation = await diagnosticProbe('RUN_FACTS_UNAVAILABLE', async () => {
      const fact = await getRunFact(runId)
      const grouped = new Map<
        string,
        { type: string; audience: string; count: number; sequences: number[] }
      >()
      for (const row of fact.runEvents) {
        const key = JSON.stringify([row.type, row.audience])
        const group = grouped.get(key) ?? {
          type: row.type,
          audience: row.audience,
          count: 0,
          sequences: [],
        }
        group.count++
        group.sequences.push(row.seq)
        grouped.set(key, group)
      }
      const statuses = new Map<string, number>()
      for (const row of fact.approvals)
        statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1)
      return {
        lifecycle: {
          component: 'hub.run',
          status: fact.run.status,
          failureCode: fact.run.failureCode,
        },
        events: {
          component: 'hub.run.events',
          total: fact.runEvents.length,
          groups: [...grouped.values()].map((group) => ({
            type: group.type,
            audience: group.audience,
            count: group.count,
            minSeq: Math.min(...group.sequences),
            maxSeq: Math.max(...group.sequences),
            uniqueSeqs: new Set(group.sequences).size,
          })),
        },
        approvals: {
          component: 'hub.approval',
          statuses: [...statuses].map(([status, count]) => ({ status, count })),
        },
        artifacts: { component: 'hub.artifact', count: fact.artifacts.length },
        outbox: {
          component: 'hub.outbox-worker',
          commands: fact.outbox.map((row) => ({
            type: row.type,
            attempts: row.attempts,
            acked: row.acked,
            failed: row.failed,
          })),
        },
      }
    })
    runs.push({ runId, ...observation })
  }
  const runtime = await diagnosticProbe('RUNTIME_FACTS_UNAVAILABLE', async () => {
    const facts = await nodeControl<{ runtimes: Array<{ runId: string; pid: number }> }>(
      '/runtimes',
    )
    return facts.runtimes.map((row) => ({ runId: row.runId, pid: row.pid }))
  })
  return {
    component: 'web.agent-brand.triage',
    ok: false,
    source: {
      component: 'web.agent-state',
      runIds,
      code:
        sequence === null
          ? 'OBSERVED_RUN_IDS_UNAVAILABLE'
          : runIds.length === 0
            ? 'NO_OBSERVED_RUN_IDS'
            : null,
    },
    runs,
    runtime: { component: 'node.supervisor', ...runtime },
  }
}

test('潮汐品牌与真实 Agent 状态：GPU、审批、键盘、减少动态效果和三档主题', async ({ browser }) => {
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const visibilityProbe = await contrastVisibilityProbe(browser)
  const setupContext = await browser.newContext({
    baseURL: env().webOrigin,
    viewport: { width: 1440, height: 960 },
  })
  const memberContext = await browser.newContext({
    baseURL: env().webOrigin,
    viewport: { width: 1440, height: 960 },
  })
  let owner = await setupContext.newPage()
  const member = await memberContext.newPage()
  const browserErrors: string[] = []
  const gpuConsole: GpuConsoleObservation[] = []
  observeGpuConsole(owner, 'setup-owner', gpuConsole)
  observeGpuConsole(member, 'member', gpuConsole)
  for (const page of [owner, member])
    page.on('pageerror', (error) => browserErrors.push(error.name))
  let recording: Awaited<ReturnType<typeof browser.newContext>> | undefined
  let degradedContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  let lostContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  let nodeStarted = false
  const runs = [],
    brandRows = []
  let keyboard = null,
    reduced = null,
    contextLoss = null,
    readOnlyPosts = 0,
    fallback = null,
    completionLoss = null,
    lostBeforeCompletion = null
  try {
    await owner.goto('/setup')
    await owner.fill('#setup-token', env().setupToken)
    await owner.fill('#team-name', `WhalePod 潮汐 ${tag}`)
    await owner.fill('#setup-username', `alice-tide-${tag}`)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', password)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    const cookie = await sessionCookie(setupContext)
    const session = (await hubApi(cookie, 'GET', '/auth/session')).data as { userId: string }
    const invite = await hubApi(cookie, 'POST', '/invites', { role: 'member' })
    expect(invite.status).toBe(201)
    const joined = await fetch(`${env().hubOrigin}/api/v1/invites/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env().webOrigin,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        token: (invite.data as { token: string }).token,
        username: `bob-tide-${tag}`,
        displayName: 'Bob',
        password,
      }),
    })
    expect(joined.status).toBe(201)
    await member.goto('/login')
    await member.fill('#login-username', `bob-tide-${tag}`)
    await fillAndEnter(member, '#login-password', password)
    await expect(member.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await seedPluginPack(session.userId)
    await owner.goto('/agents')
    await showAgentCreation(owner)
    await owner.fill('#agent-name', 'Tide Builder')
    await owner.fill('#agent-persona', '整理交付验收报告。')
    await owner.fill('#agent-provider', 'replay')
    await owner.fill('#agent-model', 'replay-model')
    await owner.locator('.agent-advanced > summary').click()
    await owner.fill('#agent-credential-slot', 'default')
    await selectFromMenu(owner.locator('#agent-plugin-pack'), 'e2e-pack')
    await owner.getByRole('button', { name: '创建 Agent', exact: true }).click()
    await expect(owner.getByText('Tide Builder').first()).toBeVisible()
    const pairing = await hubApi(cookie, 'POST', '/devices/pairing-codes', {})
    expect(pairing.status).toBe(201)
    await startNode({ pairingCode: (pairing.data as { code: string }).code })
    nodeStarted = true
    await setRuntimeFixture('approval')
    await owner.goto('/')
    await owner.getByRole('button', { name: '新建项目', exact: true }).click()
    await fillAndEnter(owner, '#project-name', 'WhalePod 潮汐工作区')
    // Recording begins after all password/token/pairing interactions. Same owner only.
    recording = await browser.newContext({
      baseURL: env().webOrigin,
      storageState: await setupContext.storageState(),
      viewport: { width: 1440, height: 960 },
      recordVideo: { dir: evidence, size: { width: 1440, height: 960 } },
    })
    owner = await recording.newPage()
    observeGpuConsole(owner, 'recorded-owner', gpuConsole)
    owner.on('pageerror', (error) => browserErrors.push(error.name))
    const video = owner.video()!
    for (const width of [1440, 390, 320]) {
      await owner.setViewportSize({ width, height: 960 })
      await owner.goto('/')
      await theme(owner, 'light')
      await owner.getByRole('button', { name: '创建任务', exact: true }).first().click()
      const form = owner.getByRole('form', { name: '创建任务' })
      await form.locator('input[id^="task-title-"]').fill(`验收 Agent 状态 ${width}`)
      await selectFromMenu(form.locator('button[id^="task-assignee-"]'), /Alice/)
      await form.getByRole('button', { name: /创建任务/ }).click()
      await owner.waitForURL(/\/tasks\//)
      const taskId = new URL(owner.url()).pathname.split('/').pop()!
      await owner.getByRole('button', { name: '接受任务', exact: true }).click()
      await expect(owner.getByTestId('task-assignment-state')).toHaveText('已接受')
      await member.goto(`/tasks/${taskId}`)
      await selectFromMenu(owner.getByLabel('选择 Agent', { exact: true }), 'Tide Builder')
      await owner.getByLabel('执行设置', { exact: true }).click()
      await selectFromMenu(owner.getByLabel('选择设备', { exact: true }), /e2e-node（在线）/)
      await selectFromMenu(owner.getByLabel('选择 Workspace', { exact: true }), 'e2e-ws')
      await owner.getByLabel('执行设置', { exact: true }).click()
      await owner.getByLabel('指令', { exact: true }).fill('生成潮汐状态验收报告')
      const send = owner.getByRole('button', { name: '开始执行', exact: true })
      await expect(send).toBeEnabled()
      await observeStates(owner)
      await send.click()
      const runButton = owner.locator('.conversation-run-head button[data-run-id]').first()
      await expect(runButton).toBeVisible()
      const runId = (await runButton.getAttribute('data-run-id'))!
      const core = owner.getByTestId('agent-state-core')
      await expect(core).toHaveAttribute('data-state', 'thinking', { timeout: 120_000 })
      await core.scrollIntoViewIfNeeded()
      await expect(core).toHaveAttribute('data-renderer', 'webgl')
      const samples = []
      for (const value of ['light', 'dark'] as const) {
        await theme(owner, value)
        const rendered = await gpu(core)
        const visibleText = await visibleThinkingText(owner, width, value)
        samples.push({ theme: value, ...rendered, visibleText })
        if (width === 1440 && value === 'light') {
          // Non-US characters can use insertText; a real navigation key establishes keyboard modality.
          await owner.getByLabel('指令', { exact: true }).press('ArrowLeft')
          await owner
            .getByLabel('指令', { exact: true })
            .pressSequentially('键盘草稿', { delay: 20 })
          keyboard = {
            input: await owner.locator('html').getAttribute('data-ui-input'),
            ...(await gpu(core)),
          }
          await owner.getByLabel('指令', { exact: true }).clear()
        }
        if (width === 390 && value === 'light') {
          await owner.emulateMedia({ reducedMotion: 'reduce' })
          await expect(core).toHaveAttribute('data-paused', '')
          await expect(core).toHaveAttribute('data-motion', 'still')
          reduced = await gpu(core)
          await owner.emulateMedia({ reducedMotion: 'no-preference' })
          await expect(core).toHaveAttribute('data-motion', 'running')
        }
        await owner.screenshot({ path: join(evidence, `agent-thinking-${value}-${width}.png`) })
      }
      const runtime = await nodeControl<{ runtimes: { runId: string; pid: number }[] }>('/runtimes')
      const runtimePid = runtime.runtimes.find((row) => row.runId === runId)?.pid ?? 0
      expect(runtimePid).toBeGreaterThan(0)
      await waitForRunStatus(runId, 'waiting_approval', 120_000)
      await expect(core).toHaveAttribute('data-state', 'approval')
      await expect(core).not.toHaveAttribute('data-active')
      await expect(owner.getByTestId('approval-card')).toBeVisible()
      const hint = member.getByTestId('execution-activity-hint')
      if (await hint.isVisible()) await hint.click()
      await expect(member.getByTestId('agent-state-core')).toHaveAttribute('data-state', 'approval')
      await expect(member.getByTestId('approval-card')).toHaveCount(0)
      await expect(member.getByTestId('approval-waiting')).toBeVisible()
      await core.scrollIntoViewIfNeeded()
      await expect(core).not.toHaveAttribute('data-paused')
      const approval = await gpu(core)
      if (width === 1440) contextLoss = await contextFault(core)
      await owner.screenshot({ path: join(evidence, `agent-approval-${width}.png`) })
      await theme(owner, 'light')
      await owner.getByTestId('approve-button').click()
      await core.scrollIntoViewIfNeeded()
      await expect(core).toHaveAttribute('data-state', 'thinking')
      if (width === 1440) {
        // Read actual tool records, then wheel upward as a reader. This leaves enough genuine
        // transcript history to exit following; no repeated forced scroll or phase hold is used.
        const records = owner.getByTestId('run-records')
        if ((await records.getAttribute('data-open')) === null)
          await records.locator('summary').click()
        await expect
          .poll(() =>
            records.evaluate(
              (node) =>
                node
                  .getAnimations({ subtree: true })
                  .filter(
                    (animation) =>
                      animation.playState === 'running' &&
                      animation.effect?.getComputedTiming().iterations !== Infinity,
                  ).length,
            ),
          )
          .toBe(0)
        await core.hover()
        await owner.mouse.wheel(0, -480)
        await expect(owner.getByTestId('conversation-jump')).toBeVisible()
        await expect(core).toHaveAttribute('data-state', 'thinking')
        await expect(core).toHaveAttribute('data-active', '')
        await expect(core).toHaveAttribute('data-renderer', 'webgl')
        await expect(core).not.toHaveAttribute('data-paused')
        await expect(core).toHaveAttribute('data-motion', 'running')
        await expect(core).toBeInViewport()
        await armLossDuringCompletion(core)
      }
      await waitForRunStatus(runId, 'completed', 120_000)
      await waitForRuntimeReleased(runId)
      if (width === 1440) completionLoss = await recordCompletionInterruption(owner, core, runId)
      await expect(core).toHaveAttribute('data-state', 'completed')
      await expect(core).not.toHaveAttribute('data-active')
      await expect(core).not.toHaveAttribute('data-completing')
      await owner.screenshot({ path: join(evidence, `agent-completed-${width}.png`) })
      const states = await owner.evaluate(() => window.__agentBrandStates ?? [])
      const fact = await getRunFact(runId)
      expect(fact.run.status).toBe('completed')
      expect(fact.approvals.some((row) => row.status === 'allowed_once')).toBe(true)
      expect(fact.artifacts.length).toBeGreaterThan(0)
      runs.push({
        width,
        taskId,
        runId,
        samples,
        approval,
        states,
        memberReadOnly: true,
        runtimeObserved: true,
        runtimePid,
        status: fact.run.status,
        approved: true,
        artifactCount: fact.artifacts.length,
      })
      const watch = (request: import('@playwright/test').Request) => {
        if (request.method() === 'POST') readOnlyPosts++
      }
      owner.on('request', watch)
      for (const value of ['light', 'dark'] as const)
        brandRows.push(await recordBrand(owner, taskId, width, value))
      owner.off('request', watch)
    }
    await recording.close()
    recording = undefined
    await video.saveAs(join(evidence, 'agent-brand-preview.webm'))
    await video.delete()
    // Explicit GPU creation failure in a separate owner context; the recording is already closed.
    degradedContext = await browser.newContext({
      baseURL: env().webOrigin,
      storageState: await setupContext.storageState(),
      viewport: { width: 1440, height: 960 },
    })
    await degradedContext.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext
      window.__agentBrandBlocked = 0
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        kind: string,
        ...args: unknown[]
      ) {
        if (kind === 'webgl') {
          window.__agentBrandBlocked!++
          return null
        }
        return Reflect.apply(original, this, [kind, ...args])
      } as typeof HTMLCanvasElement.prototype.getContext
    })
    const degraded = await degradedContext.newPage()
    observeGpuConsole(degraded, 'gpu-disabled-owner', gpuConsole)
    degraded.on('pageerror', (error) => browserErrors.push(error.name))
    await degraded.goto('/')
    await degraded.getByRole('button', { name: '创建任务', exact: true }).first().click()
    const degradedForm = degraded.getByRole('form', { name: '创建任务' })
    await degradedForm.locator('input[id^="task-title-"]').fill('核验 GPU 不可用时的真实退化')
    await selectFromMenu(degradedForm.locator('button[id^="task-assignee-"]'), /Alice/)
    await degradedForm.getByRole('button', { name: /创建任务/ }).click()
    await degraded.waitForURL(/\/tasks\//)
    await degraded.getByRole('button', { name: '接受任务', exact: true }).click()
    await selectFromMenu(degraded.getByLabel('选择 Agent', { exact: true }), 'Tide Builder')
    await degraded.getByLabel('执行设置', { exact: true }).click()
    await selectFromMenu(degraded.getByLabel('选择设备', { exact: true }), /e2e-node（在线）/)
    await selectFromMenu(degraded.getByLabel('选择 Workspace', { exact: true }), 'e2e-ws')
    await degraded.getByLabel('执行设置', { exact: true }).click()
    // A real long instruction creates a genuine scroll range; no projection/DOM status is seeded.
    await degraded
      .getByLabel('指令', { exact: true })
      .fill(
        '生成验收报告。\n' +
          Array.from({ length: 90 }, (_, i) => `验收条目 ${i + 1}：核对真实运行和可读状态。`).join(
            '\n',
          ),
      )
    await degraded.getByRole('button', { name: '开始执行', exact: true }).click()
    const fallbackCore = degraded.getByTestId('agent-state-core')
    await expect(fallbackCore).toHaveAttribute('data-state', 'thinking', { timeout: 120_000 })
    await expect(fallbackCore).toHaveAttribute('data-renderer', 'fallback')
    await fallbackCore.scrollIntoViewIfNeeded()
    await expect(fallbackCore).not.toHaveAttribute('data-paused')
    const readFallback = () =>
      fallbackCore.evaluate((root) => ({
        state: root.getAttribute('data-state'),
        renderer: root.getAttribute('data-renderer'),
        active: root.hasAttribute('data-active'),
        paused: root.hasAttribute('data-paused'),
        runningCss: root
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running').length,
        visible:
          getComputedStyle(root.querySelector('.cu-agent-core-fallback')!).visibility === 'visible',
        y: root.getBoundingClientRect().y,
      }))
    await expect.poll(async () => (await readFallback()).runningCss).toBeGreaterThan(0)
    const on = await readFallback()
    await degraded.screenshot({ path: join(evidence, 'agent-fallback-visible.png') })
    const scroller = degraded.getByTestId('conversation-scroll')
    await scroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    await expect(fallbackCore).toHaveAttribute('data-paused', '')
    const off = await readFallback()
    expect(off.runningCss).toBe(0)
    const scrollFacts = await scroller.evaluate((node) => ({
      top: node.scrollTop,
      range: node.scrollHeight - node.clientHeight,
      y: node.getBoundingClientRect().y,
    }))
    expect(scrollFacts.top).toBeGreaterThan(0)
    expect(off.y).toBeLessThan(scrollFacts.y)
    await fallbackCore.scrollIntoViewIfNeeded()
    await expect(fallbackCore).not.toHaveAttribute('data-paused')
    await expect.poll(async () => (await readFallback()).runningCss).toBeGreaterThan(0)
    const resumed = await readFallback()
    const fallbackRunId = (await degraded
      .locator('.conversation-run-head button[data-run-id]')
      .first()
      .getAttribute('data-run-id'))!
    await waitForRunStatus(fallbackRunId, 'waiting_approval', 120_000)
    await expect(fallbackCore).toHaveAttribute('data-state', 'approval')
    await degraded.getByTestId('approve-button').click()
    await waitForRunStatus(fallbackRunId, 'completed', 120_000)
    await waitForRuntimeReleased(fallbackRunId)
    fallback = {
      runId: fallbackRunId,
      on,
      off,
      resumed,
      scrollFacts,
      blockedCalls: await degraded.evaluate(() => window.__agentBrandBlocked ?? 0),
      completed: true,
    }
    // A fifth real Run keeps its lost GPU unavailable through approval and completion.
    lostContext = await browser.newContext({
      baseURL: env().webOrigin,
      storageState: await setupContext.storageState(),
      viewport: { width: 1440, height: 960 },
    })
    const lostPage = await lostContext.newPage()
    observeGpuConsole(lostPage, 'permanently-lost-owner', gpuConsole)
    lostPage.on('pageerror', (error) => browserErrors.push(error.name))
    await lostPage.goto('/')
    await lostPage.getByRole('button', { name: '创建任务', exact: true }).first().click()
    const lossForm = lostPage.getByRole('form', { name: '创建任务' })
    await lossForm.locator('input[id^="task-title-"]').fill('核验 GPU 中断后的完成状态')
    await selectFromMenu(lossForm.locator('button[id^="task-assignee-"]'), /Alice/)
    await lossForm.getByRole('button', { name: /创建任务/ }).click()
    await lostPage.waitForURL(/\/tasks\//)
    await lostPage.getByRole('button', { name: '接受任务', exact: true }).click()
    await selectFromMenu(lostPage.getByLabel('选择 Agent', { exact: true }), 'Tide Builder')
    await lostPage.getByLabel('执行设置', { exact: true }).click()
    await selectFromMenu(lostPage.getByLabel('选择设备', { exact: true }), /e2e-node（在线）/)
    await selectFromMenu(lostPage.getByLabel('选择 Workspace', { exact: true }), 'e2e-ws')
    await lostPage.getByLabel('执行设置', { exact: true }).click()
    await lostPage.getByLabel('指令', { exact: true }).fill('生成终态资源验收报告')
    await lostPage.getByRole('button', { name: '开始执行', exact: true }).click()
    const permanentlyLost = lostPage.getByTestId('agent-state-core')
    await expect(permanentlyLost).toHaveAttribute('data-state', 'thinking', { timeout: 120_000 })
    await permanentlyLost.scrollIntoViewIfNeeded()
    await expect(permanentlyLost).toHaveAttribute('data-renderer', 'webgl')
    const permanentFault = await loseWithoutRestoring(permanentlyLost)
    await expect(permanentlyLost).toHaveAttribute('data-renderer', 'fallback')
    const permanentRunId = (await lostPage
      .locator('.conversation-run-head button[data-run-id]')
      .first()
      .getAttribute('data-run-id'))!
    await waitForRunStatus(permanentRunId, 'waiting_approval', 120_000)
    await lostPage.getByTestId('approve-button').click()
    await permanentlyLost.scrollIntoViewIfNeeded()
    await expect(permanentlyLost).toHaveAttribute('data-state', 'thinking')
    await expect(permanentlyLost).not.toHaveAttribute('data-paused')
    await waitForRunStatus(permanentRunId, 'completed', 120_000)
    await waitForRuntimeReleased(permanentRunId)
    try {
      await assertTerminalResources(permanentlyLost)
    } finally {
      const observation = await lostPage.evaluate(
        () => window.__agentBrandLostBeforeCompletion ?? null,
      )
      const terminal = await terminalSnapshot(permanentlyLost)
      await writeFile(
        join(evidence, 'lost-before-completion.json'),
        JSON.stringify(
          {
            component: 'harness.agent-lost-before-completion',
            runId: permanentRunId,
            fault: permanentFault,
            observation,
            terminal,
          },
          null,
          2,
        ) + '\n',
      )
    }
    const permanentFact = await getRunFact(permanentRunId)
    lostBeforeCompletion = {
      runId: permanentRunId,
      runStatus: permanentFact.run.status,
      approved: permanentFact.approvals.some((row) => row.status === 'allowed_once'),
      fault: permanentFault,
      observation: await lostPage.evaluate(() => window.__agentBrandLostBeforeCompletion ?? null),
      terminal: await terminalSnapshot(permanentlyLost),
    }
    expect(browserErrors).toEqual([])
    expect(readOnlyPosts).toBe(0)
    await writeFile(
      join(evidence, 'facts.json'),
      JSON.stringify(
        {
          component: 'web.agent-brand',
          ok: true,
          browserErrors,
          runs,
          brandRows,
          keyboard,
          reduced,
          contextLoss,
          fallback,
          completionLoss,
          lostBeforeCompletion,
          readOnlyPosts,
          videoAfterAuth: true,
          visibilityProbe,
          themeActivation: 'existing-body-attribute',
        },
        null,
        2,
      ) + '\n',
    )
  } catch (error) {
    const failure = await owner
      .evaluate(() => window.__agentBrandGpuFailure ?? null)
      .catch(() => null)
    const hoverFailure = await owner
      .evaluate(() => window.__agentBrandHoverFailure ?? null)
      .catch(() => null)
    const completionObservation = await owner
      .evaluate(() => ({
        fault: window.__agentBrandCompletionLoss ?? null,
        sequence: window.__agentBrandStates ?? [],
        surfaces: [...document.querySelectorAll('[data-testid="agent-state-core"]')].map((root) => {
          const box = root.getBoundingClientRect()
          return {
            state: root.getAttribute('data-state'),
            active: root.hasAttribute('data-active'),
            completing: root.hasAttribute('data-completing'),
            paused: root.hasAttribute('data-paused'),
            renderer: root.getAttribute('data-renderer'),
            motion: root.getAttribute('data-motion'),
            rect: { x: box.x, y: box.y, width: box.width, height: box.height },
          }
        }),
      }))
      .catch(() => null)

    try {
      const triage = await productionFailureTriage(completionObservation?.sequence ?? null)
      await writeFile(join(evidence, 'run-triage.json'), JSON.stringify(triage, null, 2) + '\n')
    } catch {
      process.stderr.write(
        JSON.stringify({ component: 'web.agent-brand.triage', code: 'RUN_TRIAGE_WRITE_FAILED' }) +
          '\n',
      )
    }
    try {
      await writeFile(
        join(evidence, 'gpu-diagnostics.json'),
        JSON.stringify(
          {
            component: 'web.agent-brand.gpu',
            ok: false,
            failure,
            hoverFailure,
            completionObservation,
            console: gpuConsole,
          },
          null,
          2,
        ) + '\n',
      )
    } catch {
      process.stderr.write(
        JSON.stringify({ component: 'web.agent-brand.gpu', code: 'GPU_DIAGNOSTIC_WRITE_FAILED' }) +
          '\n',
      )
    }
    throw error
  } finally {
    if (nodeStarted) await stopNode()
    await recording?.close()
    await degradedContext?.close()
    await lostContext?.close()
    await setupContext.close()
    await memberContext.close()
  }
})
