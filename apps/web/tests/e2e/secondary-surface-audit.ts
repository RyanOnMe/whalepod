import { expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import { hubApi, selectFromMenu, sessionCookie } from './helpers.js'

/** Audits real route/drawer controls in the same production environment as the workspace. */
export async function auditSecondarySurfaces({
  owner,
  member,
  taskId,
  evidence,
}: {
  owner: Page
  member: Page
  taskId: string
  evidence: string
}) {
  const rows: Array<{
    name: string
    width: number
    viewport: number
    scroll: number
    headerCount: number
    stackedHeaderCount: number
  }> = []
  const confirmations: Array<{ width: number; contained: boolean }> = []
  const capture = async (name: string, width: number) => {
    await expect
      .poll(() =>
        owner
          .locator('.crossfade-in:visible')
          .evaluateAll((elements) =>
            elements.every((element) => getComputedStyle(element).opacity === '1'),
          ),
      )
      .toBe(true)
    await expect(owner.locator('.crossfade-stack > .room-skeleton')).not.toBeVisible()
    /*
     * 「一个界面只有一个标题」要按**最上层**算：ADR-0019 起 Console 的入口在运行详情里，
     * 于是 Console 是弹在开着的详情抽屉之上的模态——此刻详情头的 h2 仍在（正常），该数的
     * 是模态自己的标题。原先的单选法把这一种正常叠放判成"两个标题"（2026-10-18 实测红）。
     * 同时把所有可见标题都记下来：超过 1 个时，只允许"模态压在面板上"这一种形态。
     */
    const dialogHeaders = await owner.locator('[role="dialog"]:visible h2:visible').count()
    const inspectorHeaders = await owner
      .locator('.workspace-inspector:not([hidden]) .workspace-inspector-head > h2:visible')
      .count()
    const pageHeaders = await owner.locator('.page-header h1:visible').count()
    const headerCount = dialogHeaders > 0 ? dialogHeaders : Math.max(inspectorHeaders, pageHeaders)
    const stackedHeaderCount = dialogHeaders + inspectorHeaders + pageHeaders
    expect(headerCount, `${name}/${width} 顶层标题`).toBe(1)
    if (stackedHeaderCount > 1) {
      expect(dialogHeaders, `${name}/${width} 只有模态可以压在面板上`).toBeGreaterThan(0)
      expect(stackedHeaderCount, `${name}/${width} 叠放层数`).toBeLessThanOrEqual(2)
    }
    const bounds = await owner.evaluate(() => ({
      viewport: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(bounds.scroll, `${name}/${width} overflow`).toBeLessThanOrEqual(bounds.viewport)
    rows.push({ name, width, ...bounds, headerCount, stackedHeaderCount })
    await owner.screenshot({ path: join(evidence, `surface-${name}-${width}.png`) })
  }
  await owner.setViewportSize({ width: 1440, height: 960 })
  await owner.goto(`/tasks/${taskId}`)
  await owner.getByRole('button', { name: '任务约定', exact: true }).click()
  await owner.getByRole('button', { name: '起草任务约定', exact: true }).click()
  await owner.getByLabel('任务约定：目标', { exact: true }).fill('交付可复核的团队验收报告')
  await owner
    .getByLabel('任务约定：验收条件', { exact: true })
    .fill('报告包含结论、依据与待确认事项。')
  await owner.getByRole('button', { name: '保存为新草稿', exact: true }).click()
  await owner.getByRole('button', { name: /确认这一版/ }).click()
  await expect(owner.getByTestId('agreement-current')).toContainText('v1')
  await owner.getByRole('button', { name: '关闭工作区详情' }).click()

  for (const width of [1440, 390, 320]) {
    await owner.setViewportSize({ width, height: 960 })
    await owner.goto(`/tasks/${taskId}`)
    for (const [name, label] of [
      ['agreement', '任务约定'],
      ['artifacts', '交付与复核'],
      ['run', '运行详情'],
    ] as const) {
      const trigger = owner.getByRole('button', { name: label, exact: true })
      await trigger.click()
      const panel = owner.getByRole('region', { name: '工作区详情' })
      await expect(panel).toBeVisible()
      if (name === 'agreement') {
        await expect(panel.getByRole('heading', { name: '任务约定', exact: true })).toHaveCount(1)
        await expect(panel.getByTestId('agreement-current')).toContainText('v1')
      }
      if (name === 'artifacts') {
        const downloads = panel.getByTestId('artifact-download-button')
        expect(await downloads.count()).toBeGreaterThan(0)
        for (const button of await downloads.all()) await expect(button).toBeVisible()
        for (const details of await panel.locator('.artifact-details').all())
          await expect(details).not.toHaveAttribute('open')
      }
      await capture(name, width)
      await owner.keyboard.press('Escape')
      await expect(panel).not.toBeVisible()
      await expect(trigger).toBeFocused()
    }
    // Console 的入口在运行详情里（ADR-0019 决定 2）：先打开详情再进 Console。
    await owner.getByRole('button', { name: '运行详情', exact: true }).click()
    await expect(owner.getByRole('region', { name: '工作区详情' })).toBeVisible()
    const consoleTrigger = owner.getByTestId('open-run-console')
    await consoleTrigger.click()
    const consolePanel = owner.getByRole('dialog', { name: /Run Console/ })
    await expect(consolePanel).toBeVisible()
    await expect(owner.getByTestId('console-event').first()).toBeVisible()
    await expect(owner.getByTestId('console-close')).toBeFocused()
    await expect(owner.locator('.console-backdrop')).toHaveCSS('opacity', '1')
    await expect(consolePanel).toHaveCSS('opacity', '1')
    await expect(consolePanel).toHaveCSS('transform', 'none')
    await capture('console', width)
    await owner.keyboard.press('Escape')
    await expect(consolePanel).not.toBeVisible()
    await expect(consoleTrigger).toBeFocused()

    const pages = [
      ['projects', '/', '项目'],
      ['permissions', `/tasks/${taskId}/permissions`, '任务权限'],
      ['devices', '/devices', '设备'],
      ['agents', '/agents', 'Agents'],
      ['members', '/members', '成员'],
      ['plugins', '/plugins', '插件管理'],
    ] as const
    for (const [name, path, title] of pages) {
      await owner.goto(path)
      await expect(owner.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
      await expect(owner.locator('.page-header')).toHaveCount(1)
      await expect(owner.locator('main h1')).toHaveCount(1)
      if (name === 'permissions')
        await expect(owner.getByTestId('driver-item').first()).toContainText('Alice')
      if (name === 'devices')
        await expect(owner.getByText('e2e-node', { exact: true })).toBeVisible()
      if (name === 'members')
        await expect(owner.locator('.member-name').filter({ hasText: 'Alice' })).toBeVisible()
      if (name === 'projects') {
        await expect(owner.getByText('正在更新待办…')).not.toBeVisible()
        await expect(owner.getByText('正在确认需处理事项…')).not.toBeVisible()
        await expect(owner.getByRole('heading', { name: 'WhalePod 聚焦工作区' })).toBeVisible()
      }
      if (name === 'plugins')
        await expect(owner.getByText('e2e-pack', { exact: true }).first()).toBeVisible()
      if (name === 'agents') {
        await expect(owner.getByLabel('名称', { exact: true })).not.toBeVisible()
        if (width === 1440) {
          const create = owner.getByRole('button', { name: '新建 Agent', exact: true })
          await create.click()
          await owner.getByLabel('名称', { exact: true }).fill('保留中的草稿')
          await create.click()
          await create.click()
          await expect(owner.getByLabel('名称', { exact: true })).toHaveValue('保留中的草稿')
          await owner.screenshot({ path: join(evidence, 'surface-agent-create.png') })
          await create.click()
        }
        await owner.getByRole('button', { name: /Builder/ }).click()
        await expect(owner.locator('.agent-detail .agent-current')).toBeVisible()
      }
      if (name === 'devices' && width === 1440) {
        const guide = owner.locator('summary', { hasText: '安装与配对指南' })
        await guide.click()
        await expect(owner.getByRole('heading', { name: 'CLI 安装与配对' })).toBeVisible()
        await owner.screenshot({ path: join(evidence, 'surface-device-guide.png') })
        await guide.click()
      }
      if (name === 'permissions') {
        await selectFromMenu(owner.getByLabel('选择审批档覆盖'), '完全权限（工具调用直接放行）')
        await owner.getByTestId('approval-policy-apply').click()
        await expect(owner.getByRole('dialog')).toBeVisible()
        await expect(owner.getByRole('button', { name: '确认放行完全权限' })).toBeFocused()
        const contained = await owner.locator('.confirm-dialog').evaluate((content) => {
          const dialog = content.closest('[role="dialog"]')!.getBoundingClientRect()
          return (
            [content, ...content.querySelectorAll('h2, p, button')].every((element) => {
              const box = element.getBoundingClientRect()
              return box.left >= dialog.left && box.right <= dialog.right && box.width > 0
            }) && content.scrollWidth <= content.clientWidth
          )
        })
        expect(contained, `confirmation/${width} content clipped`).toBe(true)
        confirmations.push({ width, contained })
        await owner.screenshot({ path: join(evidence, `surface-permission-confirm-${width}.png`) })
        await owner.keyboard.press('Escape')
        await expect(owner.getByRole('dialog')).not.toBeVisible()
        await expect(owner.getByTestId('approval-policy-state')).toContainText('未覆盖')
        const persisted = await hubApi(
          await sessionCookie(owner.context()),
          'GET',
          `/tasks/${taskId}`,
        )
        expect(
          (persisted.data as { task: { approvalPolicy: string | null } }).task.approvalPolicy,
        ).toBeNull()
      }
      await capture(name, width)
    }
  }
  await member.goto(`/tasks/${taskId}/permissions`)
  await expect(member.getByTestId('drivers-readonly')).toBeVisible()
  await expect(member.getByTestId('approval-policy-apply')).toHaveCount(0)
  return {
    component: 'web.surfaces',
    scenario: 'secondary-hierarchy',
    rows,
    confirmations,
    agreementHeadingUnique: true,
    draftPreserved: true,
    memberReadOnly: true,
    fullAccessCancelled: true,
    closeRestoresFocus: true,
  }
}
