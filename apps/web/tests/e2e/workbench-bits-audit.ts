import { expect, type Page, type Request } from '@playwright/test'
import { join } from 'node:path'

const widths = [1440, 390, 320]
function mutations(page: Page) {
  let posts = 0
  const observe = (request: Request) => {
    if (request.method() === 'POST') posts++
  }
  page.on('request', observe)
  return () => {
    page.off('request', observe)
    return posts
  }
}

export async function auditWorkbenchStart(page: Page, evidence: string) {
  const stop = mutations(page)
  const rows = []
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 })
    const empty = page
      .locator('[data-collectui="empty-state-1"]')
      .filter({ has: page.getByRole('heading', { name: '还没有项目', exact: true }) })
    await expect(empty).toBeVisible()
    await expect(page.locator('.crossfade-stack > .room-skeleton')).not.toBeVisible()
    await expect(empty.getByRole('button', { name: '创建项目', exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, `workbench-empty-${width}.png`) })
    const trigger = page.getByRole('button', { name: '搜索', exact: true })
    await expect(trigger).toHaveCount(1)
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '全局搜索' })
    const input = dialog.getByLabel('搜索关键词')
    await expect(input).toBeFocused()
    await input.fill('whalepod-ui-probe-no-match')
    await expect(
      dialog.getByRole('heading', { name: '没有匹配的任务、项目或 Agent', exact: true }),
    ).toBeVisible()
    const search = await dialog.boundingBox()
    const clip = await dialog.evaluate((root) => {
      const outer = root.getBoundingClientRect()
      const inner = root.querySelector('.cu-wb-command')!.getBoundingClientRect()
      return {
        client: root.clientWidth,
        scroll: root.scrollWidth,
        contained: inner.left >= outer.left && inner.right <= outer.right + 1,
        footerVisible: [...root.querySelectorAll('.cu-wb-command-foot>span')].every((span) => {
          const r = span.getBoundingClientRect()
          return r.left >= inner.left && r.right <= inner.right + 1
        }),
      }
    })
    expect(clip.contained && clip.footerVisible).toBe(true)
    expect(clip.scroll).toBeLessThanOrEqual(clip.client)
    await page.screenshot({ path: join(evidence, `workbench-search-${width}.png`) })
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: '关闭搜索' })).toBeFocused()
    await page.keyboard.press('Tab')
    const clear = dialog.getByRole('button', { name: '清空搜索' })
    await expect(clear).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await page.screenshot({ path: join(evidence, `workbench-search-empty-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
    const profileCount = await page.locator('[data-collectui="app-sidebar-4"]').count()
    const mobileNameVisible = await page.locator('.app-topbar-user-name').isVisible()
    rows.push({
      width,
      search,
      clip,
      empty: await empty.boundingBox(),
      profileCount,
      mobileNameVisible,
      scroll: await page.evaluate(() => document.documentElement.scrollWidth),
      uniqueSearch: true,
      keyboardClear: true,
      closeRestoresFocus: true,
    })
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  return { rows, posts: stop() }
}

export async function auditWorkbenchRoom(page: Page, evidence: string) {
  const stop = mutations(page)
  const rows = []
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 })
    const welcome = page.locator('.workspace-welcome [data-collectui="empty-state-1"]')
    await expect(welcome).toBeVisible()
    const trigger = page.getByRole('button', { name: '搜索', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '全局搜索' })
    await dialog.getByLabel('搜索关键词').fill('整理交付验收报告')
    const result = dialog.getByRole('option', { name: /整理交付验收报告/ })
    await expect(result).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(result).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: join(evidence, `workbench-results-${width}.png`) })
    const url = page.url()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()
    expect(page.url()).toBe(url)
    const open = page.getByRole('button', { name: '任务约定', exact: true })
    await open.click()
    const heading = page.locator('.workspace-inspector-head[data-collectui="app-dialog-6"]')
    await expect(heading.getByRole('heading', { name: '任务约定', exact: true })).toHaveCount(1)
    const drawer = await heading.boundingBox()
    await page.screenshot({ path: join(evidence, `workbench-drawer-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect(open).toBeFocused()
    await expect(page.getByRole('region', { name: '工作区详情' })).not.toBeVisible()
    rows.push({
      width,
      drawer,
      welcome: await welcome.boundingBox(),
      resultNavigation: true,
      drawerFocus: true,
      scroll: await page.evaluate(() => document.documentElement.scrollWidth),
    })
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  return { rows, posts: stop() }
}

export async function auditWorkbenchRun(page: Page, evidence: string) {
  const rows = []
  const records = page.locator('details.run-records')
  await records.locator('summary').click()
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const activity = page.getByTestId('run-activity')
    const tool = page.getByTestId('tool-call-chip').first()
    await expect(activity).toHaveAttribute('data-collectui', 'agent-activity-3')
    await expect(activity).toHaveAttribute('data-status', 'completed')
    await expect(activity).not.toHaveAttribute('data-working')
    await expect(tool).toHaveAttribute('data-collectui', 'tool-calls-2')
    await expect(tool).toHaveAttribute('data-status', 'done')
    await expect(tool).toContainText('publish_artifact')
    await tool.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, `workbench-run-${width}.png`) })
    const reducedArcRule = await page.evaluate(() =>
      [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some(
          (rule) =>
            rule instanceof CSSMediaRule &&
            rule.conditionText.includes('prefers-reduced-motion') &&
            matchMedia(rule.conditionText).matches &&
            [...rule.cssRules].some(
              (inner) =>
                inner instanceof CSSStyleRule &&
                inner.selectorText.includes('.cu-wb-activity[data-working] .cu-wb-arc') &&
                inner.style.animationName === 'none',
            ),
        ),
      ),
    )
    rows.push({
      width,
      tool: await tool.boundingBox(),
      activity: await activity.boundingBox(),
      status: await activity.getAttribute('data-status'),
      working: await activity.getAttribute('data-working'),
      reducedArcRule,
      scroll: await page.evaluate(() => document.documentElement.scrollWidth),
    })
  }
  await records.locator('summary').click()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 960 })
  return { rows }
}
