/** #306：真实 HTTP/WS、已编译 Hub、真实 Node/Runtime replay；不直写运行状态。 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  env,
  fillAndEnter,
  getRunFact,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  setRuntimeFixture,
  startNode,
  waitForRunStatus,
  waitForRuntimeReleased,
} from './helpers.js'
import { expectNoContrastOffenders } from './contrast-sweep.js'
import { contrastRatio, parseCssColor } from '../contrast.js'

const PASSWORD = 'correct horse battery staple'
const tag = randomUUID().slice(0, 8)
const evidence = join(process.cwd(), 'artifacts/evidence/run-micro', tag)

test('Run 状态/工具事实 × 两人实时视图 × 窄屏/主题/键盘/减少动态', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const owner = await ownerContext.newPage()
  const member = await memberContext.newPage()
  const errors: string[] = []
  let observedRunId: string | undefined
  owner.on('pageerror', (error) => errors.push(error.name))
  member.on('pageerror', (error) => errors.push(error.name))
  try {
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
    await fillAndEnter(owner, '#project-name', 'Micro 集成验收')
    await owner.getByRole('button', { name: '创建任务' }).click()
    const taskForm = owner.locator('form[aria-label="创建任务"]')
    await taskForm.locator('input[id^="task-title-"]').fill('产出团队验收报告')
    await selectFromMenu(taskForm.locator('button[id^="task-assignee-"]'), /Alice/)
    await taskForm.getByRole('button', { name: /创建任务/ }).click()
    await owner.waitForURL(/\/tasks\//)
    const taskId = new URL(owner.url()).pathname.split('/').pop()!
    await owner.getByRole('button', { name: '接受任务' }).click()
    await expect(owner.getByText('你已接受此任务。')).toBeVisible()
    await member.goto(`/tasks/${taskId}`)

    await selectFromMenu(owner.getByLabel('选择 Agent'), 'Builder')
    await selectFromMenu(owner.getByLabel('选择设备'), /e2e-node（在线）/)
    await selectFromMenu(owner.getByLabel('选择 Workspace'), 'e2e-ws')
    await owner.getByLabel('Run prompt').fill('生成团队验收报告')
    await owner.getByRole('button', { name: '启动 Run' }).click()
    const runButton = owner.locator('button[data-run-id]').first()
    await expect(runButton).toBeVisible()
    const runId = (await runButton.getAttribute('data-run-id'))!
    observedRunId = runId
    expect(runId).toMatch(/^[0-9a-f-]{36}$/)
    await runButton.click()
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    await expect(owner.getByTestId('approval-card')).toBeVisible()
    await expect(member.getByTestId('approval-waiting')).toBeVisible()
    await expect(member.getByTestId('approval-card')).toHaveCount(0)
    for (const page of [owner, member]) {
      const badge = page.locator(`button[data-run-id="${runId}"] .status-mark`)
      await expect(badge).toHaveAttribute('data-paused', '')
      await expect(badge).not.toHaveAttribute('data-indeterminate')
      await expect(badge).toHaveText('等待审批')
    }
    await owner.getByTestId('open-run-console').click()
    await owner.getByTestId('console-filter-approval').focus()
    await owner.keyboard.press('Enter')
    await expect(owner.getByTestId('console-filter-approval')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(owner.getByTestId('console-event').first()).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(owner.getByTestId('run-console')).toHaveCount(0)
    await expect(owner.getByTestId('open-run-console')).toBeFocused()
    await owner.getByTestId('approve-button').focus()
    await owner.keyboard.press('Enter')
    await waitForRunStatus(runId, 'completed', 120_000)
    await waitForRuntimeReleased(runId)
    const chip = owner.getByTestId('tool-call-chip').first()
    await expect(chip).toHaveAttribute('data-status', 'done')
    await expect(chip).toContainText('publish_artifact')
    await expect(member.locator(`button[data-run-id="${runId}"] .status-mark`)).toHaveAttribute(
      'data-status',
      'done',
    )
    await expect(owner.locator('[data-indeterminate]')).toHaveCount(0)
    const room = (await hubApi(cookie, 'GET', `/tasks/${taskId}`)).data as {
      task: { status: string }
    }
    expect(room.task.status).toBe('in_progress')

    await mkdir(evidence, { recursive: true })
    const projections = []
    for (const [audience, sessionCookieValue] of [
      ['owner', cookie],
      ['member', await sessionCookie(memberContext)],
    ] as const) {
      const response = await hubApi(sessionCookieValue, 'GET', `/runs/${runId}/events`)
      expect(response.status).toBe(200)
      const events = (
        response.data as {
          events: Array<{ seq: number; audience: string; event: Record<string, unknown> }>
        }
      ).events
      expect(
        events.some(
          (item) => item.event['type'] === 'tool.finished' && item.event['outcome'] === 'succeeded',
        ),
      ).toBe(true)
      // 仅写允许的关联字段；参数、preview、响应、Cookie、设备路径永不入包。
      projections.push({
        component: 'hub.run-projection',
        viewer: audience,
        runId,
        events: events.map((item) => ({
          seq: item.seq,
          audience: item.audience,
          type: item.event['type'],
          callId: item.event['callId'],
          outcome: item.event['outcome'],
        })),
      })
    }
    const layout = []
    for (const width of [1280, 390]) {
      await owner.setViewportSize({ width, height: 900 })
      // 壳由 matchMedia 驱动 React 互斥渲染：等真实断点切换，不量旧的 264px 侧栏。
      await expect(owner.locator('.app-sidebar')).toHaveCount(width >= 1024 ? 1 : 0)
      for (const dark of [false, true]) {
        await owner.evaluate((enabled) => {
          document.body.toggleAttribute('data-ds-dark-theme', enabled)
        }, dark)
        const dimensions = await owner.evaluate(() => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll('body *')]
            .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
            .map((element) => ({
              tag: element.tagName,
              class: element.getAttribute('class') ?? '',
              right: element.getBoundingClientRect().right,
            })),
        }))
        expect(dimensions.documentWidth, JSON.stringify(dimensions.overflow)).toBeLessThanOrEqual(
          width + 1,
        )
        // 深色全站尚未启用且有 #236 已知缺口；本切片量新增 chip 的实际配对。
        // 浅色额外扫全页；其余深色问题登记为边界，不在此扩张主题改造。
        if (!dark) await expectNoContrastOffenders(owner)
        const paint = await chip.evaluate((element) => ({
          color: getComputedStyle(element).color,
          background: getComputedStyle(element).backgroundColor,
        }))
        const ratio = contrastRatio(parseCssColor(paint.color), parseCssColor(paint.background))
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        await chip.screenshot({
          path: join(evidence, `chip-${width}-${dark ? 'dark' : 'light'}.png`),
        })
        layout.push({ component: 'web.micro', dark, contrast: ratio, ...dimensions })
      }
    }
    await owner.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await owner.setViewportSize({ width: 1280, height: 900 })
    await owner.getByTestId('run-live-panel').screenshot({ path: join(evidence, 'run-panel.png') })
    await owner.emulateMedia({ reducedMotion: 'reduce' })
    expect(
      await owner.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    ).toBe(true)
    const ringAnimation = await owner
      .locator('.status-mark__ring')
      .first()
      .evaluate((element) => getComputedStyle(element).animationName)
    expect(ringAnimation).toBe('none')
    // 终态无动画之外，浏览器必须实际加载匹配的减少动态规则；删规则会红。
    const activeRingSuppressed = await owner.evaluate(() =>
      [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some(
          (rule) =>
            rule instanceof CSSMediaRule &&
            rule.conditionText.includes('prefers-reduced-motion') &&
            window.matchMedia(rule.conditionText).matches &&
            [...rule.cssRules].some(
              (inner) =>
                inner instanceof CSSStyleRule &&
                inner.selectorText === '.status-mark[data-indeterminate] .status-mark__ring' &&
                inner.style.animationName === 'none',
            ),
        ),
      ),
    )
    expect(activeRingSuppressed).toBe(true)
    await owner.getByTestId('open-run-console').click()
    await owner.getByTestId('console-filter-tool').click()
    await expect(owner.getByTestId('tool-call-chip').last()).toHaveAttribute('data-status', 'done')
    await expect(owner.getByTestId('console-filter-tool')).toBeFocused()
    expect(errors).toEqual([])
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          issue: 306,
          passed: true,
          component: 'web.micro',
          runId,
          taskStatus: room.task.status,
          projections,
          layout,
          reducedMotion: {
            matched: true,
            terminalRingAnimation: ringAnimation,
            activeRingSuppressed,
          },
          pageErrors: errors,
          runFact: await getRunFact(runId),
        },
        null,
        2,
      ) + '\n',
    )
  } catch (error) {
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'failure.json'),
      JSON.stringify(
        {
          issue: 306,
          component: 'web.micro',
          passed: false,
          runId: observedRunId,
          error: error instanceof Error ? error.name : 'UnknownError',
          runFact: observedRunId === undefined ? undefined : await getRunFact(observedRunId),
        },
        null,
        2,
      ) + '\n',
    )
    throw error
  } finally {
    await ownerContext.close()
    await memberContext.close()
  }
})
