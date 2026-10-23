import { expect, type Page, type Request } from '@playwright/test'
import { join } from 'node:path'
import { selectFromMenu } from './helpers.js'

/** P1-425: public UI only. No projected states are inserted into the database. */
export async function auditPages({
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
  await owner.setViewportSize({ width: 1440, height: 960 })
  await owner.goto('/')
  // A real unaccepted task supplies an actionable inbox item through the normal form.
  await owner.getByRole('button', { name: '创建任务', exact: true }).click()
  const creation = owner.getByRole('form', { name: '创建任务', exact: true })
  await creation.locator('input[id^="task-title-"]').fill('待接手的验收工作')
  await expect(creation.locator('button[id^="task-assignee-"]')).toContainText('Alice')
  await creation.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(owner.getByRole('heading', { name: '待接手的验收工作', exact: true })).toBeVisible()
  const rows = []
  let posts = 0
  const observe = (request: Request) => {
    if (request.method() === 'POST') posts++
  }
  owner.on('request', observe)
  for (const width of [1440, 390, 320]) {
    await owner.setViewportSize({ width, height: 960 })
    await owner.goto('/')
    const card = owner.locator('[data-collectui="card-1"]')
    await expect(card).toHaveCount(1)
    const trigger = card.getByRole('button', { name: /^(收起)?任务列表$/ })
    await trigger.click()
    const panel = card.locator('[id^="project-tasks-"]')
    await expect(panel.getByRole('button', { name: '整理交付验收报告', exact: true })).toBeVisible()
    const pointerDuration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
    expect(pointerDuration).toBe('0.16s, 0.16s')
    const entryDuration = await card.evaluate(
      (el) => getComputedStyle(el.closest('li')!).transitionDuration,
    )
    expect(entryDuration).toBe('0.16s, 0.16s')
    await expect
      .poll(() =>
        card.evaluate((el) =>
          [el, ...el.querySelectorAll('*')].every((node) =>
            node.getAnimations().every((animation) => animation.playState !== 'running'),
          ),
        ),
      )
      .toBe(true)
    await owner.screenshot({ path: join(evidence, `pages-projects-${width}.png`) })
    const close = card.getByRole('button', { name: '收起任务列表', exact: true })
    await close.click()
    await expect(panel).toHaveAttribute('inert', '')
    await expect(panel).toHaveAttribute('aria-hidden', 'true')
    await expect.poll(() => panel.evaluate((el) => el.getBoundingClientRect().height)).toBe(0)
    await trigger.focus()
    await trigger.press('Enter')
    await expect(panel).toHaveAttribute('data-open', '')
    const keyboardDuration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
    expect(keyboardDuration).toBe('0s')
    await expect(trigger).toBeFocused()
    // A quick pointer close/reopen interrupts the pending unmount without losing controls.
    await close.click()
    await trigger.click()
    await expect(panel.getByRole('button', { name: '整理交付验收报告', exact: true })).toBeVisible()
    await owner.emulateMedia({ reducedMotion: 'reduce' })
    const reducedDuration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
    const reducedEntry = await card.evaluate(
      (el) => getComputedStyle(el.closest('li')!).transitionDuration,
    )
    expect(reducedDuration).toBe('0s')
    expect(reducedEntry).toBe('0s')
    await owner.emulateMedia({ reducedMotion: 'no-preference' })

    const inbox = owner.getByRole('region', { name: '需要我处理', exact: true })
    await expect(inbox.getByRole('link', { name: /接受任务 · 待接手的验收工作/ })).toBeVisible()
    const filters = inbox.getByRole('group', { name: '待办筛选' })
    await filters.getByRole('button', { name: '审批', exact: true }).click()
    await expect(inbox.getByRole('link', { name: /待接手的验收工作/ })).toHaveCount(0)
    await filters.getByRole('button', { name: '指派', exact: true }).click()
    const taskLink = inbox.getByRole('link', { name: /接受任务 · 待接手的验收工作/ })
    await expect(taskLink).toHaveAttribute('href', /\/tasks\/[^/]+#task-assignment$/)
    const item = inbox.locator('li').first()
    await expect.poll(() => item.evaluate((el) => el.getAnimations().length)).toBe(0)
    const original = await item.elementHandle()
    const response = owner.waitForResponse(
      (r) => r.url().endsWith('/tasks/attention') && r.status() === 200,
    )
    await inbox.getByRole('button', { name: '刷新待办', exact: true }).click()
    await response
    await expect(inbox).toHaveAttribute('aria-busy', 'false')
    const stableNode = await item.evaluate((el, old) => el === old, original)
    const replayed = await item.evaluate((el) => el.getAnimations().length)
    expect(stableNode).toBe(true)
    expect(replayed).toBe(0)
    await original?.dispose()
    await owner.screenshot({ path: join(evidence, `pages-inbox-${width}.png`) })
    const projectBounds = await card.boundingBox()
    const inboxBounds = await inbox.boundingBox()
    const homeScroll = await owner.evaluate(() => document.documentElement.scrollWidth)

    await owner.goto('/agents')
    await owner.getByRole('button', { name: '新建 Agent', exact: true }).click()
    const form = owner.getByRole('form', { name: '新建 Agent', exact: true })
    const credential = form.locator('#agent-credential-slot')
    await expect(credential).not.toBeVisible()
    const groups = await form.locator('fieldset').count()
    for (const name of ['基本信息', '角色', '模型', '工具与权限'])
      await expect(form.getByRole('group', { name, exact: true })).toBeVisible()
    expect(groups).toBe(4)
    await form.locator('#agent-name').fill('保留中的配置')
    await form.locator('#agent-persona').fill('检查交付结果。')
    const advanced = form.locator('.agent-advanced > summary')
    await advanced.click()
    await credential.fill('team-local')
    await advanced.click()
    await advanced.click()
    await expect(credential).toHaveValue('team-local')
    // Native constraint validation opens the disclosure before focusing the invalid field.
    await credential.fill('')
    await advanced.click()
    await selectFromMenu(form.locator('#agent-plugin-pack'), 'e2e-pack')
    await form.getByRole('button', { name: '创建 Agent', exact: true }).click()
    await expect(credential).toBeFocused()
    await expect(credential).toBeVisible()
    await credential.fill('default')
    await advanced.click()
    await expect(form.getByText(/完全权限会直接执行工具/)).toBeVisible()
    await owner.screenshot({ path: join(evidence, `pages-settings-${width}.png`) })
    const settingsBounds = await form.boundingBox()
    const settingsScroll = await owner.evaluate(() => document.documentElement.scrollWidth)

    await owner.goto(`/tasks/${taskId}`)
    await owner.getByRole('button', { name: '团队讨论', exact: true }).click()
    const draft = owner.getByRole('textbox', { name: '留言', exact: true })
    await draft.fill('页面精修草稿')
    await owner.getByRole('button', { name: 'Agent 执行', exact: true }).click()
    await owner.getByRole('button', { name: '团队讨论', exact: true }).click()
    await expect(draft).toHaveValue('页面精修草稿')
    const composer = owner.locator('[data-collectui="comments-1"].cu-page-composer')
    await expect(composer).toHaveCount(1)
    await expect(owner.getByTestId('prompt-bar')).toHaveCount(1)
    await owner.screenshot({ path: join(evidence, `pages-discussion-${width}.png`) })
    rows.push({
      width,
      projectBounds,
      inboxBounds,
      settingsBounds,
      discussionBounds: await composer.boundingBox(),
      homeScroll,
      settingsScroll,
      discussionScroll: await owner.evaluate(() => document.documentElement.scrollWidth),
      pointerDuration,
      keyboardDuration,
      reducedDuration,
      reducedEntry,
      entryDuration,
      closedInert: true,
      keyboardFocus: true,
      interrupted: true,
      stableNode,
      replayed,
      filterDeepLink: true,
      advancedRetained: true,
      invalidFocus: true,
      groups,
      draftRetained: true,
    })
  }
  // Only this deliberate send mutates, after the read-only audit counter is stopped.
  owner.off('request', observe)
  expect(posts).toBe(0)
  await owner.getByRole('button', { name: '发送留言', exact: true }).click()
  await expect(owner.getByRole('textbox', { name: '留言', exact: true })).toHaveValue('')
  await expect(owner.locator('.comment-body').filter({ hasText: '页面精修草稿' })).toBeVisible()
  await member.goto(`/tasks/${taskId}`)
  await member.getByRole('button', { name: '团队讨论', exact: true }).click()
  await expect(member.locator('.comment-body').filter({ hasText: '页面精修草稿' })).toBeVisible()
  await member.goto('/agents')
  await expect(member.getByRole('button', { name: '新建 Agent', exact: true })).toHaveCount(0)
  return { component: 'web.pages', rows, posts, commentShared: true, memberReadOnly: true }
}
