/** #306：真实 HTTP/WS、已编译 Hub、真实 Node/Runtime replay；不直写运行状态。 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  env,
  fillAndEnter,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  setRuntimeFixture,
  startNode,
  stopNode,
  waitForRunStatus,
  waitForRuntimeReleased,
} from './helpers.js'

const PASSWORD = 'correct horse battery staple'
const tag = randomUUID().slice(0, 8)
const evidence = join(process.cwd(), 'artifacts/evidence/focused-workspace', tag)

test('聚焦工作区：独立草稿、实时审批、候选检查发布、桌面与窄屏布局', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const owner = await ownerContext.newPage()
  const member = await memberContext.newPage()
  const errors: string[] = []
  owner.on('pageerror', (error) => errors.push(error.name))
  member.on('pageerror', (error) => errors.push(error.name))
  const facts: Record<string, unknown>[] = []
  try {
    await mkdir(evidence, { recursive: true })
    await owner.goto('/setup')
    await owner.fill('#setup-token', env().setupToken)
    await owner.fill('#team-name', `Micro 验收 ${tag}`)
    await owner.fill('#setup-username', `alice-micro-${tag}`)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', PASSWORD)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

    const cookie = await sessionCookie(ownerContext)
    const session = (await hubApi(cookie, 'GET', '/auth/session')).data as { userId: string }

    // 用户/插件组合的前置条件走现有公开 HTTP / 已登记的静态 pack 种子，不创建运行事实。
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
        username: `bob-micro-${tag}`,
        displayName: 'Bob',
        password: PASSWORD,
      }),
    })
    expect(joined.status).toBe(201)
    await member.goto('/login')
    await member.fill('#login-username', `bob-micro-${tag}`)
    await fillAndEnter(member, '#login-password', PASSWORD)
    await expect(member.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

    await seedPluginPack(session.userId)
    await owner.goto('/agents')
    await owner.fill('#agent-name', 'Builder')
    await owner.fill('#agent-persona', '你是验收代理。')
    await owner.fill('#agent-provider', 'replay')
    await owner.fill('#agent-model', 'replay-model')
    await owner.fill('#agent-credential-slot', 'default')
    await selectFromMenu(owner.locator('#agent-plugin-pack'), 'e2e-pack')
    await owner.getByRole('button', { name: '创建 Agent' }).click()
    await expect(owner.getByText('Builder').first()).toBeVisible()

    const pairing = await hubApi(cookie, 'POST', '/devices/pairing-codes', {})
    expect(pairing.status).toBe(201)
    await startNode({ pairingCode: (pairing.data as { code: string }).code })
    await setRuntimeFixture('approval')
    await owner.goto('/')
    await owner.getByRole('button', { name: '新建项目' }).click()
    await fillAndEnter(owner, '#project-name', 'WhalePod 聚焦工作区')
    await owner.getByRole('button', { name: '创建任务' }).click()
    const taskForm = owner.locator('form[aria-label="创建任务"]')
    await taskForm.locator('input[id^="task-title-"]').fill('整理交付验收报告')
    await selectFromMenu(taskForm.locator('button[id^="task-assignee-"]'), /Alice/)
    await taskForm.getByRole('button', { name: /创建任务/ }).click()
    await owner.waitForURL(/\/tasks\//)
    const taskId = new URL(owner.url()).pathname.split('/').pop()!
    await owner.getByRole('button', { name: '接受任务' }).click()
    await expect(owner.getByText('你已接受此任务。')).toBeVisible()
    await member.goto(`/tasks/${taskId}`)

    await expect(owner.getByRole('heading', { name: '我们要完成什么？' })).toBeVisible()
    await owner.screenshot({ path: join(evidence, 'desktop-ready.png') })
    const microLayouts = []
    for (const width of [1440, 390, 320]) {
      await owner.setViewportSize({ width, height: 960 })
      const bar = owner.getByTestId('prompt-bar')
      const agent = bar.getByRole('button', { name: '选择 Agent' })
      await expect(bar.getByRole('textbox', { name: '指令' })).toHaveCount(1)
      await agent.click()
      const menu = owner.getByRole('menu', { name: '可用选项' })
      await expect(menu.getByRole('menuitem', { name: 'Builder' })).toBeFocused()
      const bounds = await menu.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(960)
      await owner.screenshot({ path: join(evidence, `micro-menu-${width}.png`) })
      await owner.keyboard.press('Escape')
      await expect(agent).toBeFocused()
      await expect(menu).toHaveCount(0)
      microLayouts.push({
        width,
        menu: bounds,
        portal: (await bar.getByRole('menu').count()) === 0,
      })
    }
    await owner.emulateMedia({ reducedMotion: 'reduce' })
    await owner.keyboard.press('Enter')
    const menu = owner.getByRole('menu', { name: '可用选项' })
    await expect(menu).toHaveCSS('transition-duration', '0s')
    await owner.keyboard.press('End')
    await owner.keyboard.press('Enter')
    await expect(owner.getByLabel('选择 Agent')).toContainText('Builder')
    await owner.emulateMedia({ reducedMotion: 'no-preference' })
    await owner.setViewportSize({ width: 1440, height: 960 })
    facts.push({
      component: 'web.micro',
      scenario: 'workspace-controls',
      layouts: microLayouts,
      keyboardSelect: true,
      reducedMotion: true,
      oneInstruction: true,
    })

    await owner.getByRole('button', { name: '团队讨论', exact: true }).click()
    await owner.getByLabel('留言').fill('先确认验收口径，再开始执行。')
    await owner.getByRole('button', { name: 'Agent 执行', exact: true }).click()
    await expect(owner.getByLabel('留言')).not.toBeVisible()
    await owner.getByRole('button', { name: '团队讨论', exact: true }).click()
    await expect(owner.getByLabel('留言')).toHaveValue('先确认验收口径，再开始执行。')
    await owner.getByRole('button', { name: '发送留言' }).click()
    await expect(member.getByText('先确认验收口径，再开始执行。')).not.toBeVisible()
    await member.getByRole('button', { name: '团队讨论', exact: true }).click()
    await expect(member.getByText('先确认验收口径，再开始执行。')).toBeVisible()
    await owner.getByRole('button', { name: 'Agent 执行', exact: true }).click()
    facts.push({
      component: 'web.workspace',
      scenario: 'discussion',
      draftRetained: true,
      separateChannel: true,
    })
    await selectFromMenu(owner.getByLabel('选择 Agent'), 'Builder')
    await owner.locator('.execution-settings > summary').click()
    await selectFromMenu(owner.getByLabel('选择设备'), /e2e-node（在线）/)
    await selectFromMenu(owner.getByLabel('选择 Workspace'), 'e2e-ws')
    await owner.getByLabel('指令').fill('生成团队验收报告')
    await owner.getByRole('button', { name: '开始执行' }).click()
    const runButton = owner.locator('button[data-run-id]').first()
    await expect(runButton).toBeVisible()
    const runId = (await runButton.getAttribute('data-run-id'))!
    expect(runId).toMatch(/^[0-9a-f-]{36}$/)
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    await expect(owner.getByTestId('approval-card')).toBeVisible()
    await expect(member.getByTestId('execution-activity-hint')).toContainText('执行等待审批')
    await member.getByTestId('execution-activity-hint').click()
    await expect(member.getByTestId('approval-waiting')).toBeVisible()
    await expect(member.getByTestId('approval-card')).toHaveCount(0)
    await owner.screenshot({ path: join(evidence, 'desktop-approval.png') })
    await owner.getByTestId('approve-button').click()
    await waitForRunStatus(runId, 'completed', 120_000)
    await waitForRuntimeReleased(runId)
    await expect(owner.getByRole('button', { name: /查看交付物/ }).first()).toBeVisible()
    await expect(member.getByRole('button', { name: /查看交付物/ })).toHaveCount(0)
    facts.push({
      component: 'web.approval',
      scenario: 'owner-member',
      runId,
      ownerCanApprove: true,
      memberWaits: true,
      candidatePrivate: true,
    })
    await owner
      .getByRole('button', { name: /查看交付物/ })
      .first()
      .click()
    const panel = owner.getByRole('region', { name: '工作区详情' })
    await expect(panel).toBeVisible()
    await owner.route('**/api/v1/artifacts/*/content', (route) => route.fulfill({ status: 500 }))
    await panel.getByTestId('artifact-preview-button').first().click()
    await expect(panel.getByTestId('artifact-preview-error')).toBeVisible()
    await owner.unroute('**/api/v1/artifacts/*/content')
    await panel.getByTestId('artifact-preview-button').first().click()
    await expect(panel.getByTestId('artifact-preview').first()).toBeVisible()
    await owner.screenshot({ path: join(evidence, 'desktop-artifact.png') })
    await panel.getByTestId('artifact-publish-button').first().click()
    await owner.getByRole('button', { name: '确认发布给团队' }).click()
    await expect(member.getByRole('button', { name: /查看交付物/ }).first()).toBeVisible()
    const room = (await hubApi(cookie, 'GET', `/tasks/${taskId}`)).data as {
      task: { status: string }
    }
    expect(room.task.status).toBe('in_progress')
    facts.push({
      component: 'web.artifact',
      scenario: 'inspect-publish',
      runId,
      previewFailureVisible: true,
      previewRetried: true,
      publishedShared: true,
      taskStatus: room.task.status,
    })
    const dimensions = []
    for (const width of [1440, 1024, 736, 390, 320]) {
      await owner.setViewportSize({ width, height: 960 })
      const bounds = await owner.evaluate(() => ({
        viewport: window.innerWidth,
        scroll: document.documentElement.scrollWidth,
      }))
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport)
      await expect(owner.getByRole('button', { name: '关闭工作区详情' })).toBeVisible()
      dimensions.push({ width, ...bounds })
      await owner.screenshot({ path: join(evidence, `artifact-${width}.png`) })
    }
    await owner.getByRole('button', { name: '关闭工作区详情' }).click()
    await expect(owner.getByRole('button', { name: /查看交付物/ }).first()).toBeFocused()
    await expect(owner.getByRole('button', { name: 'Agent 执行', exact: true })).toBeVisible()
    await owner.screenshot({ path: join(evidence, 'mobile-conversation.png') })
    await owner.getByRole('button', { name: '任务约定', exact: true }).click()
    await expect(owner.getByTestId('agreement-panel')).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(owner.getByRole('button', { name: '任务约定', exact: true })).toBeFocused()
    await expect(owner.getByRole('region', { name: '工作区详情' })).not.toBeVisible()
    facts.push({
      component: 'web.layout',
      scenario: 'responsive',
      dimensions,
      closeRestoresFocus: true,
      agreementReachable: true,
    })
    expect(errors).toEqual([])
    expect(facts).toHaveLength(5)
    await stopNode()
  } finally {
    await ownerContext.close()
    await memberContext.close()
  }
  await writeFile(
    join(evidence, 'facts.json'),
    JSON.stringify({ ok: true, facts, browserErrors: errors }, null, 2) + '\n',
  )
})
