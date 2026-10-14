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
import { expectNoContrastOffenders, sweepContrast } from './contrast-sweep.js'
import { contrastRatio, parseCssColor } from '../contrast.js'

const PASSWORD = 'correct horse battery staple'
const tag = randomUUID().slice(0, 8)
const evidence = join(process.cwd(), 'artifacts/evidence/run-micro', tag)

test('Run 状态/工具事实 × 两人实时视图 × 窄屏/主题/键盘/减少动态 × 提示层/铃铛/可关闭 toast', async ({
  browser,
}) => {
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
    // #315：继承 fieldset 禁用的按钮适用 inactive 例外；同区域说明仍必须可读。
    await owner.setContent(
      '<fieldset disabled><button style="color:#ddd;background:#fff">禁用按钮</button><p style="color:#ddd;background:#fff">受阻说明</p></fieldset>',
    )
    const disabledSweep = await sweepContrast(owner)
    expect(disabledSweep.offenders.map((row) => row.text)).toContain('受阻说明')
    expect(disabledSweep.offenders.some((row) => row.text === '禁用按钮')).toBe(false)
    await owner.goto('/setup')
    await owner.fill('#setup-token', env().setupToken)
    await owner.fill('#team-name', `Micro 验收 ${tag}`)
    await owner.fill('#setup-username', `alice-micro-${tag}`)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', PASSWORD)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

    /*
     * #308 完成提醒开关（Micro 铃铛）两条真实路径。
     * 先在**没有权限**的情况下点一次：headless Chromium 会拒绝，开关不许因此变成已开、
     * 也不许响铃（图形不能替代授权结果）；再授予通知权限并重载，点击后才是真的开。
     */
    await mkdir(evidence, { recursive: true })
    const bell = owner.locator('.bell-toggle')
    await expect(bell).toHaveAttribute('data-on', 'false')
    await expect(bell).toHaveAttribute('data-ring', '0')
    await bell.screenshot({ path: join(evidence, 'bell-off.png') })
    await owner.getByRole('button', { name: '完成提醒' }).click()
    await expect(owner.getByText('浏览器已拒绝通知权限')).toBeVisible()
    await expect(owner.locator('.bell-toggle')).toHaveCount(0)
    await ownerContext.grantPermissions(['notifications'], { origin: env().webOrigin })
    await owner.reload()
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await owner.getByRole('button', { name: '完成提醒' }).click()
    await expect(owner.locator('.bell-toggle')).toHaveAttribute('data-on', 'true')
    await expect(owner.locator('.bell-toggle')).toHaveAttribute('data-ring', '1')
    await owner.locator('.bell-toggle').screenshot({ path: join(evidence, 'bell-on.png') })
    expect(
      await owner.evaluate(() => window.localStorage.getItem('whalepod.notifications.system')),
    ).toBe('on')
    const bellFact = {
      component: 'web.bell',
      deniedStaysOff: true,
      deniedShowsReadOnly: true,
      grantedTurnsOn: true,
      ringAfterGrant: 1,
    }

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
    const node = await startNode({ pairingCode: (pairing.data as { code: string }).code })
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
    await owner.getByLabel('指令').fill('生成团队验收报告')
    await owner.getByRole('button', { name: '开始执行' }).click()
    const runButton = owner.locator('button[data-run-id]').first()
    await expect(runButton).toBeVisible()
    const runId = (await runButton.getAttribute('data-run-id'))!
    observedRunId = runId
    expect(runId).toMatch(/^[0-9a-f-]{36}$/)
    /*
     * #308 提示层：运行列表项只显示序号，完整 Run id 必须可达。
     * 鼠标路径要**先等**（冷启动，测出等待下界而不是上界）；键盘路径不等待；
     * Escape 关闭且撤掉 aria-describedby（描述只在提示真的可见时挂）。
     */
    const hintStarted = Date.now()
    await runButton.hover()
    await expect(owner.getByRole('tooltip')).toHaveText(runId, { timeout: 3_000 })
    const hintWaitedMs = Date.now() - hintStarted
    expect(hintWaitedMs).toBeGreaterThanOrEqual(300)
    // 提示层 portal 到 body：元素截图拍不到浮层，必须整页截图 + 裁剪「运行项 ∪ 提示」的并集。
    const hintClip = await owner.evaluate(() => {
      const layer = document.querySelector('.hint-layer')?.getBoundingClientRect()
      const trigger = document.querySelector('button[data-run-id]')?.getBoundingClientRect()
      if (layer === undefined || trigger === undefined) return null
      const pad = 8
      const x = Math.max(0, Math.min(trigger.left, layer.left) - pad)
      const y = Math.max(0, Math.min(trigger.top, layer.top) - pad)
      const right = Math.max(trigger.right, layer.right) + pad
      const bottom = Math.max(trigger.bottom, layer.bottom) + pad
      return { x, y, width: right - x, height: bottom - y }
    })
    expect(hintClip).not.toBeNull()
    await owner.screenshot({ path: join(evidence, 'hint-run-id.png'), clip: hintClip! })
    const describedId = await runButton.getAttribute('aria-describedby')
    expect(describedId).not.toBeNull()
    expect(await owner.locator(`#${describedId}`).getAttribute('role')).toBe('tooltip')
    // 鼠标路径的收场是「指针移开」——提示不许挂在屏幕上不走（也不许留着描述）。
    await owner.mouse.move(2, 2)
    await expect(owner.getByRole('tooltip')).toHaveCount(0)
    expect(await runButton.getAttribute('aria-describedby')).toBeNull()
    // 键盘路径：焦点到了就显示（不用等冷启动的 400ms），Escape 关闭并撤掉描述。
    await runButton.focus()
    await expect(owner.getByRole('tooltip')).toHaveText(runId)
    const keyboardDescribed = await runButton.getAttribute('aria-describedby')
    expect(keyboardDescribed).not.toBeNull()
    await owner.keyboard.press('Escape')
    await expect(owner.getByRole('tooltip')).toHaveCount(0)
    expect(await runButton.getAttribute('aria-describedby')).toBeNull()
    const hintFact = {
      component: 'web.hint',
      mouseWaitedMs: hintWaitedMs,
      describedOnlyWhileVisible: true,
      escapeCloses: true,
      keyboardShowsAtOnce: true,
    }
    await runButton.click()
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    await expect(owner.getByTestId('approval-card')).toBeVisible()
    await expect(member.getByTestId('approval-waiting')).toBeVisible()
    await expect(member.getByTestId('approval-card')).toHaveCount(0)
    await member.locator(`button[data-run-id="${runId}"]`).click()
    const activity = []
    for (const page of [owner, member]) {
      const badge = page.locator(`button[data-run-id="${runId}"] .status-mark`)
      await expect(badge).toHaveAttribute('data-paused', '')
      await expect(badge).not.toHaveAttribute('data-indeterminate')
      await expect(badge).toHaveText('等待审批')
      await expect(page.getByTestId('run-activity')).toHaveText('等待责任人审批')
      await expect(page.getByTestId('run-activity')).not.toHaveAttribute('data-working')
      activity.push({
        component: 'web.activity',
        viewer: page === owner ? 'owner' : 'member',
        runId,
        status: 'waiting_approval',
        working: false,
      })
    }
    await owner.getByTestId('open-run-console').click()
    await owner.getByTestId('console-filter-approval').focus()
    await owner.keyboard.press('Enter')
    await expect(owner.getByTestId('console-filter-approval')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(owner.getByTestId('console-event').first()).toBeVisible()
    await expect(owner.getByRole('group', { name: '事件筛选' })).toHaveAttribute('data-instant', '')
    const keyboardFilterDuration = await owner
      .locator('.rubber-segment__thumb')
      .evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(keyboardFilterDuration).toBe('0s')
    await owner.getByTestId('console-filter-tool').click()
    await expect(owner.getByTestId('console-filter-tool')).toHaveAttribute('aria-pressed', 'true')
    const pointerFilterDuration = await owner
      .locator('.rubber-segment__thumb')
      .evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(pointerFilterDuration).toBe('0.16s')
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
    for (const page of [owner, member]) {
      await expect(page.getByTestId('run-activity')).toHaveText('本次运行已完成')
      await expect(page.getByTestId('run-activity')).not.toHaveAttribute('data-working')
      activity.push({
        component: 'web.activity',
        viewer: page === owner ? 'owner' : 'member',
        runId,
        status: 'completed',
        working: false,
      })
    }
    const room = (await hubApi(cookie, 'GET', `/tasks/${taskId}`)).data as {
      task: { status: string }
    }
    expect(room.task.status).toBe('in_progress')

    /*
     * #308 可关闭 toast（浏览器路径）。真实触发点是「下载失败」——#229 登记的唯一
     * 就地失败通道：在 fetch 边界注入 500，页面走它自己的失败分支（不碰任何别的状态）。
     * 顺手在真实浏览器里量三件事：fuse 时长 = 卡片真实窗口、悬停时 fuse 与计时一起暂停、
     * 关闭按钮是真的关闭（关掉之后不再回来）。
     */
    await owner.route('**/api/v1/artifacts/*/content', (route) => route.fulfill({ status: 500 }))
    // 交付物此刻还是 candidate：先走真实的「发布」，下载入口才会出现（#250 的两态）。
    await owner.getByTestId('artifact-publish-button').first().click()
    const downloadButton = owner.getByTestId('artifact-download-button').first()
    await expect(downloadButton).toBeVisible()
    await downloadButton.click()
    const toast = owner.locator('.toast-item').first()
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('下载失败')
    const fuseMs = await toast.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--toast-fuse-ms').trim(),
    )
    expect(fuseMs).toBe('3840ms')
    await toast.hover()
    await expect(toast).toHaveAttribute('data-paused', 'true')
    const fusePlayState = await toast
      .locator('.toast-item__fuse')
      .evaluate((el) => getComputedStyle(el).animationPlayState)
    expect(fusePlayState).toBe('paused')
    // 截图留证：卡上能看到已烧掉一段的 fuse 与关闭按钮（此刻悬停暂停）；再留一张带位置的全屏。
    await toast.screenshot({ path: join(evidence, 'toast-fuse.png') })
    await owner.screenshot({ path: join(evidence, 'toast-context.png') })
    await owner.mouse.move(2, 2)
    await expect(toast).toHaveAttribute('data-paused', 'false')
    await toast.getByRole('button', { name: '关闭提示' }).click()
    await expect(owner.locator('.toast-item')).toHaveCount(0)
    // 关掉之后不许再自动消退回来（同一张卡不复活）。
    await owner.waitForTimeout(4_200)
    await expect(owner.locator('.toast-item')).toHaveCount(0)
    await owner.unroute('**/api/v1/artifacts/*/content')
    const toastFact = {
      component: 'web.toast',
      trigger: 'artifact-download-500',
      fuseMs,
      fusePlayStateOnHover: fusePlayState,
      closedByButton: true,
      staysClosed: true,
    }

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
          phase: item.event['type'] === 'run.phase' ? item.event['phase'] : undefined,
        })),
      })
    }
    const layout = []
    for (const width of [1280, 390, 320]) {
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
    /*
     * #308：减少动态下铃铛不响、fuse 不走——**规则必须被浏览器真的加载**（删规则会红），
     * 而不是只在本文件里声明过；铃铛此刻是已开状态（data-ring=1），条件选择器是活的。
     */
    const batch2Suppressed = await owner.evaluate(() => {
      const wanted = ['.bell-toggle__glyph', '.toast-item__fuse']
      const found: string[] = []
      for (const sheet of [...document.styleSheets]) {
        for (const rule of [...sheet.cssRules]) {
          if (!(rule instanceof CSSMediaRule)) continue
          if (!rule.conditionText.includes('prefers-reduced-motion')) continue
          if (!window.matchMedia(rule.conditionText).matches) continue
          for (const inner of [...rule.cssRules]) {
            if (
              inner instanceof CSSStyleRule &&
              wanted.includes(inner.selectorText) &&
              inner.style.animationName === 'none'
            ) {
              found.push(inner.selectorText)
            }
          }
        }
      }
      return found
    })
    expect(batch2Suppressed).toContain('.bell-toggle__glyph')
    expect(batch2Suppressed).toContain('.toast-item__fuse')
    const bellRingUnderReduce = await owner
      .locator('.bell-toggle__glyph')
      .evaluate((element) => getComputedStyle(element).animationName)
    expect(bellRingUnderReduce).toBe('none')
    await owner.getByTestId('open-run-console').click()
    await owner.getByTestId('console-filter-tool').click()
    await expect(owner.getByTestId('tool-call-chip').last()).toHaveAttribute('data-status', 'done')
    await expect(owner.getByTestId('console-filter-tool')).toBeFocused()
    const reducedFilterDuration = await owner
      .locator('.rubber-segment__thumb')
      .evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(reducedFilterDuration).toBe('0s')
    await owner
      .getByRole('dialog', { name: 'Run Console' })
      .screenshot({ path: join(evidence, 'console-desktop.png') })
    await owner.setViewportSize({ width: 390, height: 900 })
    await expect(owner.locator('.app-sidebar')).toHaveCount(0)
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      391,
    )
    await owner
      .getByRole('dialog', { name: 'Run Console' })
      .screenshot({ path: join(evidence, 'console-mobile.png') })
    await owner.keyboard.press('Escape')
    await expect(owner.getByTestId('open-run-console')).toBeFocused()
    await owner.setViewportSize({ width: 1280, height: 900 })
    await owner.emulateMedia({ reducedMotion: 'no-preference' })

    // Slow the transport without manufacturing a response: release forwards the real request to Hub.
    await setRuntimeFixture('basic')
    const instructionUrl = `**/api/v1/tasks/${taskId}/instructions`
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    let pendingRequests = 0
    await owner.route(instructionUrl, async (route) => {
      pendingRequests += 1
      await requestGate
      await route.continue()
    })
    await selectFromMenu(owner.getByLabel('执行方式'), /继续会话/)
    const box = owner.getByLabel('指令', { exact: true })
    await box.fill('检查报告')
    const sent = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/instructions`) &&
        response.request().method() === 'POST',
    )
    await box.press('Control+Enter')
    const pendingButton = owner.getByRole('button', { name: '发送中…', exact: true })
    await expect(pendingButton).toBeDisabled()
    await expect(pendingButton).toHaveAttribute('aria-busy', 'true')
    await expect(pendingButton).toHaveAttribute('data-feedback', 'pending')
    await expect(pendingButton).toHaveAttribute('data-instant', '')
    await box.press('Control+Enter')
    expect(pendingRequests).toBe(1)
    await owner
      .locator('.instruction-composer')
      .screenshot({ path: join(evidence, 'composer-pending.png') })
    releaseRequest()
    const sentResponse = await sent
    expect(sentResponse.status()).toBe(201)
    const outcome = (await sentResponse.json()).data as { outcome: string; runId: string }
    expect(outcome.outcome).toBe('started_run')
    await owner.unroute(instructionUrl)
    const sendButton = owner.getByRole('button', { name: '发送追问', exact: true })
    await expect(sendButton).toHaveAttribute('data-feedback', 'started_run')
    await expect(owner.getByTestId('instruction-outcome')).toContainText('已起新运行')
    await expect(box).toHaveValue('')
    await waitForRunStatus(outcome.runId, 'completed', 120_000)
    await waitForRuntimeReleased(outcome.runId)
    await owner
      .locator('.instruction-composer')
      .screenshot({ path: join(evidence, 'composer-accepted.png') })

    // Real public revoke endpoint removes the only available execution target in this disposable team.
    expect((await hubApi(cookie, 'DELETE', `/devices/${node.deviceId}`, {})).status).toBe(200)
    await selectFromMenu(owner.getByLabel('执行方式'), /继续会话/)
    const failedSend = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/instructions`) &&
        response.request().method() === 'POST',
    )
    await box.fill('这句要保留')
    await box.press('Control+Enter')
    const failedResponse = await failedSend
    expect(failedResponse.status()).toBe(409)
    const failedEnvelope = (await failedResponse.json()).error as {
      code: string
      requestId: string
    }
    expect(failedEnvelope.code).toBe('DEVICE_REVOKED')
    expect(failedEnvelope.requestId).toBeTruthy()
    await expect(owner.getByRole('button', { name: '继续会话', exact: true })).toHaveAttribute(
      'data-feedback',
      'failed',
    )
    await expect(box).toHaveValue('这句要保留')
    await expect(owner.getByTestId('instruction-offline-guidance')).toBeVisible()
    await expect(owner.getByTestId('instruction-outcome')).toHaveCount(0)
    await expect(owner.getByRole('alert')).toContainText(failedEnvelope.requestId)
    const afterFailure = (await hubApi(cookie, 'GET', `/tasks/${taskId}`)).data as {
      task: { status: string }
      runs: Array<{ id: string; status: string }>
    }
    expect(afterFailure.task.status).toBe('in_progress')
    expect(afterFailure.runs.map((run) => run.id).sort()).toEqual([runId, outcome.runId].sort())
    await owner
      .locator('.instruction-composer')
      .screenshot({ path: join(evidence, 'composer-failed.png') })
    const sends = {
      component: 'web.instruction',
      pendingRequests,
      accepted: { httpStatus: 201, outcome: outcome.outcome, runId: outcome.runId },
      failed: {
        httpStatus: 409,
        code: failedEnvelope.code,
        requestIdPresent: true,
        draftRetained: true,
        runCreated: false,
      },
    }
    await owner.setViewportSize({ width: 320, height: 900 })
    await expect(owner.locator('.app-sidebar')).toHaveCount(0)
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      321,
    )
    await owner
      .locator('.instruction-composer')
      .screenshot({ path: join(evidence, 'composer-320.png') })
    await owner.setViewportSize({ width: 390, height: 900 })
    await expect(owner.locator('.app-sidebar')).toHaveCount(0)
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      391,
    )
    await owner
      .locator('.instruction-composer')
      .screenshot({ path: join(evidence, 'composer-mobile.png') })
    /*
     * #308 布局证据（放在任务页判据之后，避免打扰这一页的选中状态）：提示层在按钮外面
     * 包了一层锚点，必须证明按钮自己的盒子没变——复制按钮走 inline-flex 锚点，
     * 运行列表项走 block 锚点（后者由既有 320/390 溢出判据覆盖）。这里量设备页的
     * 「复制配对码」：生成配对码是真实用户动作，锚点与按钮的盒子必须完全一致。
     */
    await owner.setViewportSize({ width: 1280, height: 900 })
    await owner.goto('/devices')
    await owner.getByRole('button', { name: '生成配对码' }).click()
    const copyButton = owner.getByRole('button', { name: '复制配对码' })
    await expect(copyButton).toBeVisible()
    const anchorBox = await copyButton.evaluate((button) => {
      const anchor = button.closest('[data-testid="hint-anchor"]') as HTMLElement | null
      if (anchor === null) return { anchored: false }
      const a = anchor.getBoundingClientRect()
      const b = button.getBoundingClientRect()
      return {
        anchored: true,
        anchorWidth: Math.round(a.width),
        buttonWidth: Math.round(b.width),
        anchorHeight: Math.round(a.height),
        buttonHeight: Math.round(b.height),
        anchorLeft: Math.round(a.left),
        buttonLeft: Math.round(b.left),
      }
    })
    expect(anchorBox.anchored).toBe(true)
    expect(anchorBox.anchorWidth).toBe(anchorBox.buttonWidth)
    expect(anchorBox.anchorHeight).toBe(anchorBox.buttonHeight)
    expect(anchorBox.anchorLeft).toBe(anchorBox.buttonLeft)
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1281,
    )
    const hintAnchorFact = { component: 'web.hint', ...anchorBox, boxUnchanged: true }
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
          activity,
          sends,
          filters: {
            component: 'web.console',
            keyboardFilterDuration,
            pointerFilterDuration,
            reducedFilterDuration,
            nativeButtons: true,
            focusReturned: true,
          },
          projections,
          layout,
          reducedMotion: {
            matched: true,
            terminalRingAnimation: ringAnimation,
            activeRingSuppressed,
            bellRingSuppressed: batch2Suppressed.includes('.bell-toggle__glyph'),
            fuseSuppressed: batch2Suppressed.includes('.toast-item__fuse'),
          },
          batch2: {
            issue: 308,
            hint: hintFact,
            hintAnchor: hintAnchorFact,
            bell: bellFact,
            toast: toastFact,
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
