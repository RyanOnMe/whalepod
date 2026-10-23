import { expect, type Page } from '@playwright/test'
import { join } from 'node:path'

export async function auditPrompt(page: Page, width: number) {
  const frame = page.getByTestId('prompt-bar')
  const input = frame.getByRole('textbox', { name: '指令' })
  await expect(frame).toHaveAttribute('data-collectui', 'prompt-input-2')
  await input.focus()
  const inputShadow = await input.evaluate((element) => getComputedStyle(element).boxShadow)
  const frameShadow = await frame.evaluate((element) => getComputedStyle(element).boxShadow)
  expect(inputShadow).toBe('none')
  expect(frameShadow).not.toBe('none')
  return { width, inputShadow, frameShadow, inputCount: await frame.locator('textarea').count() }
}

export async function auditApproval(page: Page, evidence: string) {
  const rows = []
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveAttribute('data-collectui', 'agent-approval-1')
    await card.scrollIntoViewIfNeeded()
    const cardBounds = (await card.boundingBox())!
    const previewBounds = (await card.getByTestId('approval-preview').boundingBox())!
    const approve = (await card.getByTestId('approve-button').boundingBox())!
    const reject = (await card.getByTestId('reject-button').boundingBox())!
    expect(cardBounds.x).toBeGreaterThanOrEqual(0)
    expect(cardBounds.x + cardBounds.width).toBeLessThanOrEqual(width)
    expect(previewBounds.x).toBeGreaterThanOrEqual(cardBounds.x)
    expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(
      cardBounds.x + cardBounds.width,
    )
    expect(approve.height).toBeGreaterThanOrEqual(40)
    expect(reject.height).toBeGreaterThanOrEqual(40)
    await expect(card.getByTestId('approval-preview')).toBeVisible()
    await expect(card.getByTestId('approval-expires')).toBeVisible()
    rows.push({
      width,
      card: cardBounds,
      preview: previewBounds,
      approveHeight: approve.height,
      rejectHeight: reject.height,
    })
    await page.screenshot({ path: join(evidence, `app-ui-approval-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  return rows
}

export async function auditSendFocus(page: Page, evidence: string) {
  await page.bringToFront()
  const rows = []
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    const settings = page.getByLabel('执行设置', { exact: true })
    await settings.focus()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('region', { name: '执行参数' })).not.toBeVisible()
    const frame = page.getByTestId('prompt-bar')
    const send = frame.getByRole('button', { name: '开始执行', exact: true })
    await expect(send).toBeEnabled()
    // Start one actual tab stop before send; don't depend on the number of
    // other controls (native details/portals have their own tab sequences).
    await send.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(send).not.toBeFocused()
    const previous = await page.evaluate(() => ({
      focused: document.hasFocus(),
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
    }))
    await page.keyboard.press('Tab')
    const next = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
    }))
    await expect(send, JSON.stringify({ width, previous, next })).toBeFocused()
    const shadow = await send.evaluate((element) => getComputedStyle(element).boxShadow)
    expect(shadow).not.toContain('inset')
    expect(shadow).toMatch(/0px 0px 0px 2px/)
    expect(shadow).toMatch(/0px 0px 0px 4px/)
    rows.push({ width, focused: true, shadow })
    await page.screenshot({ path: join(evidence, `app-ui-send-focus-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  return rows
}

export async function auditFileActions(page: Page, width: number, evidence: string) {
  const panel = page.getByRole('region', { name: '工作区详情' })
  const trigger = panel.getByRole('button', { name: '更多文件操作' }).first()
  let posts = 0
  const count = (request: { method(): string }) => {
    if (request.method() === 'POST') posts++
  }
  page.on('request', count)
  try {
    await expect(panel.locator('[data-collectui="ai-chat-2"]')).toHaveCount(1)
    await expect(panel.getByTestId('artifact-download-button')).toBeVisible()
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: '发起复核', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: '根据意见修订', exact: true })).toBeFocused()
    const bounds = (await menu.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(960)
    const itemCount = await menu.getByRole('menuitem').count()
    expect(itemCount).toBe(3)
    await page.screenshot({ path: join(evidence, `app-ui-files-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await panel.locator('.workspace-inspector-head h2').click()
    await expect(menu).toHaveCount(0)
    await expect(panel).toBeVisible()
    expect(posts).toBe(0)
    return {
      width,
      menu: bounds,
      itemCount,
      posts,
      escapeRestoresFocus: true,
      outerPanelPreserved: true,
    }
  } finally {
    page.off('request', count)
  }
}
