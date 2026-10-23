import { expect, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { waitForRunStatus, waitForRuntimeReleased } from './helpers.js'

async function sampleTransition(target: Locator) {
  return target.evaluate((node) => {
    const animations = node.getAnimations().filter((animation) => animation.playState === 'running')
    if (animations.length === 0) throw new Error('No real transition was generated')
    const read = () => {
      const css = getComputedStyle(node)
      const matrix = new DOMMatrixReadOnly(css.transform)
      return {
        x: matrix.m41,
        opacity: Number(css.opacity),
        height: node.getBoundingClientRect().height,
      }
    }
    const durations = animations.map((animation) => Number(animation.effect!.getTiming().duration))
    for (const animation of animations) {
      animation.pause()
      animation.currentTime = Number(animation.effect!.getTiming().duration) * 0.2
    }
    const early = read()
    for (const animation of animations)
      animation.currentTime = Number(animation.effect!.getTiming().duration) * 0.8
    const late = read()
    for (const animation of animations) animation.finish()
    return { declaredDuration: getComputedStyle(node).transitionDuration, durations, early, late }
  })
}

export async function auditMotionProject(page: Page, evidence: string) {
  await page.setViewportSize({ width: 1440, height: 960 })
  const shell = page.locator('[data-collectui="depth-card"]').first()
  const layer = shell.locator('.cu-depth-layer')
  await expect(shell).toBeVisible()
  await page.getByRole('button', { name: '搜索', exact: true }).focus()
  const box = (await shell.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.85, box.y + 15)
  await expect
    .poll(() => layer.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe('none')
  const depthTransform = await layer.evaluate((node) => getComputedStyle(node).transform)
  await page.screenshot({ path: join(evidence, 'motion-project-depth.png') })
  await page.mouse.move(5, 5)
  await expect.poll(() => layer.evaluate((node) => node.getAttribute('style') ?? '')).toBe('')
  const idleWrites = await layer.evaluate(async (node) => {
    let writes = 0
    const observer = new MutationObserver(() => writes++)
    observer.observe(node, { attributes: true, attributeFilter: ['style'] })
    await new Promise((resolve) => setTimeout(resolve, 150))
    observer.disconnect()
    return writes
  })
  expect(idleWrites).toBe(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.move(box.x + box.width * 0.9, box.y + 15)
  const reducedTransform = await layer.evaluate((node) => getComputedStyle(node).transform)
  expect(reducedTransform).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  return { depthTransform, reducedTransform, idleWrites, returned: true }
}

/** The second document is produced by a real rerun and a real approval, never a projection seed. */
export async function auditMotionWorkspace(
  page: Page,
  member: Page,
  evidence: string,
  firstRunId: string,
) {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '关闭工作区详情', exact: true }).click()
  await page.locator(`button[data-run-id="${firstRunId}"]`).click()
  await page.getByTestId('rerun-button').click()
  await page.getByTestId('rerun-prompt').fill('生成第二份验收材料')
  await page.getByTestId('rerun-confirm-button').click()
  await expect(page.getByTestId('rerun-prompt')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭工作区详情', exact: true }).click()
  const runButtons = page.locator('.conversation-run-head button[data-run-id]')
  await expect(runButtons).toHaveCount(2)
  const secondRunId = (await runButtons.last().getAttribute('data-run-id'))!
  await waitForRunStatus(secondRunId, 'waiting_approval', 120_000)
  await page.getByTestId('approve-button').click()
  await waitForRunStatus(secondRunId, 'completed', 120_000)
  await waitForRuntimeReleased(secondRunId)
  await expect(page.getByRole('button', { name: /查看交付物/ })).toHaveCount(2)
  await expect(member.getByRole('button', { name: /查看交付物/ })).toHaveCount(1)

  let posts = 0,
    contentReads = 0
  const observe = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST') posts++
    if (request.method() === 'GET' && /\/artifacts\/[^/]+\/content$/.test(request.url()))
      contentReads++
  }
  page.on('request', observe)
  const rows = []
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    const records = page.getByTestId('run-records').first()
    const summary = records.locator('summary')
    await summary.click()
    const reveal = await sampleTransition(records.locator('.cu-page-expand'))
    expect(reveal.late.height - reveal.early.height).toBeGreaterThan(1)
    await summary.click()
    await expect(records.locator('.cu-page-expand')).toHaveAttribute('inert', '')
    await summary.click()
    await expect(records).toHaveAttribute('data-open', '')
    await expect
      .poll(() =>
        records.locator('.cu-page-expand').evaluate((node) => node.getAnimations().length),
      )
      .toBe(0)
    await page.screenshot({ path: join(evidence, `motion-timeline-${width}.png`) })
    await summary.click()

    const trigger = page.getByRole('button', { name: /查看交付物/ }).first()
    await trigger.click()
    const drawer = page.getByRole('region', { name: '工作区详情' })
    const inspector = await sampleTransition(drawer)
    expect(inspector.early.x - inspector.late.x).toBeGreaterThan(1)
    const mark = drawer.locator('[data-collectui="card-spread"]')
    await expect(mark.locator('i')).toHaveCount(2)
    const fanBefore = await mark
      .locator('i')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).transform))
    await mark.hover()
    await expect
      .poll(() =>
        mark
          .locator('i')
          .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).transform)),
      )
      .not.toEqual(fanBefore)
    const fanAfter = await mark
      .locator('i')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).transform))
    if (
      (await drawer.getByTestId('artifact-preview-button').getAttribute('aria-expanded')) !== 'true'
    )
      await drawer.getByTestId('artifact-preview-button').click()
    const preview = drawer.getByTestId('artifact-preview')
    await expect(preview).toBeVisible()
    const text = await preview.textContent()
    await drawer.getByRole('button', { name: '关闭文件预览', exact: true }).click()
    await expect(drawer.getByTestId('artifact-preview-button')).toBeFocused()
    await drawer.getByTestId('artifact-preview-button').click()
    await expect(preview).toHaveText(text!)
    await expect
      .poll(() =>
        drawer.evaluate((root) =>
          [root, ...root.querySelectorAll('*')].every((node) => node.getAnimations().length === 0),
        ),
      )
      .toBe(true)
    await page.screenshot({ path: join(evidence, `motion-artifact-${width}.png`) })
    const retained = await drawer.elementHandle()
    await drawer.getByRole('button', { name: '关闭工作区详情', exact: true }).click()
    await expect(trigger).toBeFocused()
    const closing = page.locator('.workspace-inspector[data-closing]')
    await expect(closing).toHaveAttribute('inert', '')
    await trigger.click()
    await expect(drawer).toBeVisible()
    expect(await drawer.evaluate((node, old) => node === old, retained)).toBe(true)
    await retained?.dispose()
    await expect.poll(() => drawer.evaluate((node) => node.getAnimations().length)).toBe(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await drawer.evaluate((node) => ({
      duration: getComputedStyle(node).transitionDuration,
      transform: getComputedStyle(node).transform,
    }))
    expect(reduced).toEqual({ duration: '0s', transform: 'none' })
    const geometry = await drawer.evaluate((node) => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      client: node.clientWidth,
      content: node.scrollWidth,
    }))
    expect(geometry.scroll).toBeLessThanOrEqual(width)
    expect(geometry.content).toBeLessThanOrEqual(geometry.client + 1)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await drawer.getByRole('button', { name: '关闭工作区详情', exact: true }).click()
    rows.push({
      width,
      reveal,
      inspector,
      fanBefore,
      fanAfter,
      geometry,
      reduced,
      interrupted: true,
      closedInert: true,
      previewRetained: true,
      focusReturned: true,
    })
  }
  page.off('request', observe)
  expect(posts).toBe(0)
  // Each immutable first-artifact component retains its single successful read across every reopen.
  expect(contentReads).toBe(1)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.locator(`button[data-run-id="${firstRunId}"]`).click()
  await page.getByTestId('open-run-console').click()
  const consoleFrame = page.locator('[data-collectui="tool-calls-5"]')
  await expect(consoleFrame.getByTestId('console-count')).toBeVisible()
  await page.getByTestId('console-filter-error').click()
  await expect(page.getByTestId('console-empty')).toBeVisible()
  await page.getByTestId('console-filter-all').click()
  await page.screenshot({ path: join(evidence, 'motion-tool-output.png') })
  await page.getByTestId('console-close').click()
  await expect(page.getByTestId('run-console')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭工作区详情', exact: true }).click()
  // Leave the original file inspector open for the existing responsive/publication audit.
  await page
    .getByRole('button', { name: /查看交付物/ })
    .first()
    .click()
  return { rows, posts, contentReads, toolsReal: true, secondRunId, candidatePrivate: true }
}

export async function saveMotionEvidence(directory: string, project: unknown, workspace: unknown) {
  await writeFile(
    join(directory, 'motion.json'),
    JSON.stringify({ ok: true, component: 'web.motion', project, workspace }, null, 2) + '\n',
  )
}

/** Short read-only recording starts after authentication and code issuance, with no secrets on screen. */
export async function recordMotionDemo(owner: Page, taskId: string, evidence: string) {
  const browser = owner.context().browser()!
  // Same owner in a separate recording window; never share state with the member context.
  const context = await browser.newContext({
    storageState: await owner.context().storageState(),
    viewport: { width: 1440, height: 960 },
    recordVideo: { dir: evidence, size: { width: 1440, height: 960 } },
  })
  const page = await context.newPage()
  const video = page.video()!
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++
  })
  const settled = (node: Locator) =>
    expect
      .poll(() =>
        node.evaluate((root) =>
          [root, ...root.querySelectorAll('*')].every(
            (element) => element.getAnimations().length === 0,
          ),
        ),
      )
      .toBe(true)
  try {
    await page.goto(new URL('/', owner.url()).href)
    const card = page.locator('[data-collectui="depth-card"]').first()
    await expect(card).toBeVisible()
    const box = (await card.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.85, box.y + 20)
    await expect
      .poll(() =>
        card.locator('.cu-depth-layer').evaluate((node) => getComputedStyle(node).transform),
      )
      .not.toBe('none')
    await card.locator('.cu-depth-layer').evaluate(async (node) => {
      let last = '',
        stable = 0
      const deadline = performance.now() + 3000
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          const next = node.getAttribute('style') ?? ''
          stable = next === last ? stable + 1 : 0
          last = next
          if (stable >= 8) resolve()
          else if (performance.now() > deadline) reject(new Error('Depth spring did not settle'))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    })
    await card.getByRole('button', { name: '任务列表', exact: true }).click()
    await settled(card)
    await card.getByRole('button', { name: '收起任务列表', exact: true }).click()
    await settled(card)
    await page.goto(new URL(`/tasks/${taskId}`, owner.url()).href)
    const file = page.getByRole('button', { name: /查看交付物/ }).first()
    await file.click()
    const drawer = page.getByRole('region', { name: '工作区详情' })
    await settled(drawer)
    await drawer.getByTestId('artifact-preview-button').click()
    await expect(drawer.getByTestId('artifact-preview')).toBeVisible()
    await settled(drawer)
    await drawer.getByRole('button', { name: '关闭文件预览', exact: true }).click()
    await settled(drawer)
    await drawer.getByTestId('artifact-preview-button').click()
    await settled(drawer)
    await drawer.getByRole('button', { name: '关闭工作区详情', exact: true }).click()
    await settled(page.locator('.workspace-inspector'))
    const records = page.getByTestId('run-records').first()
    await records.locator('summary').click()
    await settled(records)
    await records.locator('summary').click()
    await settled(records)
    expect(posts).toBe(0)
  } finally {
    await context.close()
  }
  await video.saveAs(join(evidence, 'motion-preview.webm'))
  await video.delete()
}
