/**
 * #158 下拉落页的**两档截图与定位审计**（Q5，playwright project `p1-158`）。
 *
 * 为什么单独一个 project：本用例要**真跑到 7 个落页点全部渲染出来**（成员页 / 项目页 /
 * Agent 页 / Task Room 的 RunLauncher），并且要覆盖 1280×720 与 390×844 两档；把它塞进
 * `p1-140`（实时观察，判据是"对端零操作"）会弄脏那套语义——单 Hub 只容一个团队，所以它
 * 自己独占一套冷启环境。
 *
 * 判据（Issue #158 的验收 + 我未验证清单里最实的两条）：
 * 1. **两档截图**：7 个落页点各截一次（`artifacts/evidence/select-menu/<viewport>/`），
 *    截图是**给人复核的取证**，判定本身仍靠下面的断言（红线：不看截图判完成）。
 * 2. **390 档菜单定位（当场判掉）**：vendored `Menu.module.css` 的 `.list` 有
 *    `min-width: 218px`，窄宿主里列表会横向溢出触发器。判据：列表**不超出视口**、
 *    宿主容器**不出现横向滚动**（`scrollWidth <= clientWidth + 1`）。
 *    为什么只判这两条而不判"列表宽度"：218px 是 vendored 的设计宽度，溢出触发器本身不算
 *    错（卡片就是比控件宽），**溢出视口**才是错。
 * 3. **S3 回焦**：键盘选中一项后焦点必须回到触发器（真实浏览器里的落点，jsdom 只能给近似）。
 * 4. **对比度顺带扫**（#159 的门现成）：迁移后的触发器是可见控件，扫描面比原生 select 大。
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  assertMenuTriggerTokens,
  assertNotNativeSelect,
  env as readEnv,
  fillAndEnter,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  setRuntimeFixture,
  startNode,
} from './helpers.js'
// #159 的对比度门（同一套判定，迁移后触发器是可见控件，顺带扫一遍）
import { expectNoContrastOffenders } from './contrast-sweep.js'

const env = readEnv()

const PASSWORD = 'correct horse battery staple'
const RUN_TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-sm-${RUN_TAG}`
const BOB_NAME = `bob-sm-${RUN_TAG}`
const PROJECT_NAME = `下拉审计项目 ${RUN_TAG}`
/** Issue #158 明确要求的两档（与 #152 的验收档位一致）。 */
const VIEWPORTS = [
  { name: 'desktop-1280x720', width: 1280, height: 720 },
  { name: 'mobile-390x844', width: 390, height: 844 },
] as const
const SHOT_DIR = join(process.cwd(), 'artifacts', 'evidence', 'select-menu')

test.describe('#158 七处下拉的两档审计', () => {
  let ownerContext: BrowserContext
  let bobContext: BrowserContext

  test.beforeEach(async ({ browser }) => {
    ownerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    bobContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  })
  test.afterEach(async () => {
    await ownerContext.close()
    await bobContext.close()
  })

  test('7 个落页点 × 两档：截图 + 窄屏定位判据 + 键盘回焦（单 Hub 单团队，故合为一条）', async () => {
    const owner = await ownerContext.newPage()

    // ---- Owner：真实 Setup 页开通团队 ----
    await owner.goto('/setup')
    await owner.fill('#setup-token', env.setupToken)
    await owner.fill('#team-name', `下拉审计团队 ${RUN_TAG}`)
    await owner.fill('#setup-username', ALICE_NAME)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', PASSWORD)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    const ownerCookie = await sessionCookie(ownerContext)
    const members = (await hubApi(ownerCookie, 'GET', '/team/members')).data as
      | Array<{ userId: string; role: string }>
      | undefined
    const ownerId = members?.find((m) => m.role === 'owner')?.userId ?? ''
    expect(ownerId, 'Setup 后的团队里应该有一个 owner').not.toBe('')

    // ---- 落页点 3/7：#invite-role（成员页邀请角色） ----
    await owner
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '成员' })
      .click()
    await expect(owner.getByRole('heading', { name: '成员', exact: true })).toBeVisible()
    const inviteRole = owner.locator('#invite-role')
    await assertNotNativeSelect(inviteRole, owner.locator('.members-invite'), '角色')
    await assertMenuTriggerTokens(inviteRole)
    for (const vp of VIEWPORTS) {
      await owner.setViewportSize({ width: vp.width, height: vp.height })
      await auditMenuAt(owner, inviteRole, `invite-role-${vp.name}`, vp)
    }
    await owner.setViewportSize({ width: 1280, height: 720 })
    // 顺带扫一次对比度（成员页此刻渲染了邀请表单；#158 迁移后的触发器是可见控件）
    await expectNoContrastOffenders(owner)

    // ---- 项目 ----
    await owner.goto('/')
    await owner.getByRole('button', { name: '新建项目' }).click()
    await fillAndEnter(owner, '#project-name', PROJECT_NAME)
    await expect(owner.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()

    // ---- Bob 账号：必须在「指派」之前建好 ----
    // 本审计首轮实测踩到：先建任务再邀 Bob，责任人下拉里只有 Alice（名册里根本没有 Bob），
    // `selectFromMenu(assignee, /Bob/)` 必然找不到项。邀请链自身的真人路径由 p1-141 覆盖，
    // 这里用 HTTP 旁路（与 p1-19 同惯例）。
    const invite = await hubApi(ownerCookie, 'POST', '/invites', { role: 'member' })
    expect(invite.status).toBe(201)
    const accepted = await fetch(`${env.hubOrigin}/api/v1/invites/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.webOrigin,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        token: (invite.data as { token: string }).token,
        username: BOB_NAME,
        displayName: 'Bob',
        password: PASSWORD,
      }),
    })
    expect(accepted.status).toBe(201)
    const bobUserId = ((await accepted.json()) as { data: { userId: string } }).data.userId
    // 名册是 staleTime:0（每次挂载核对），reload 一次拿到含 Bob 的新名册
    await owner.reload()

    // ---- 落页点 4/7：#task-assignee-*（创建任务的责任人） ----
    const taskForm = owner.locator('form[aria-label="创建任务"]')
    await owner.getByRole('button', { name: '创建任务' }).click()
    await owner.locator('input[id^="task-title-"]').fill('审计用任务')
    const assignee = taskForm.locator('button[id^="task-assignee-"]')
    await assertNotNativeSelect(assignee, taskForm, '责任人')
    await assertMenuTriggerTokens(assignee)
    for (const vp of VIEWPORTS) {
      await owner.setViewportSize({ width: vp.width, height: vp.height })
      await auditMenuAt(owner, assignee, `task-assignee-${vp.name}`, vp)
    }
    await owner.setViewportSize({ width: 1280, height: 720 })

    // 指派给 Bob（真人路径：点开 → 点选项），然后建任务落到 Task Room
    await selectFromMenu(assignee, /Bob/)
    await taskForm.getByRole('button', { name: /创建任务/ }).click()
    await owner.waitForURL(/\/tasks\//)
    const taskId = new URL(owner.url()).pathname.split('/').pop() ?? ''
    expect(taskId).not.toBe('')

    // ---- 落页点 5-8/7：RunLauncher 四处（Agent / Revision / 设备 / Workspace） ----
    // Agent 需要 Plugin Pack（真 Hub 上没有种子 → 经控制面 seed，与 p1-19 同惯例）。
    // Agent 必须由 **Owner（Alice）** 建：本审计第二轮实测踩到——Bob 是 member，
    // `/agents` 对他只渲染只读说明，`#agent-plugin-pack` 根本不在页面上。
    const pack = await seedPluginPack(ownerId)
    expect(pack.pluginPackId).not.toBe('')
    const bob = await bobContext.newPage()
    await createAgentViaUi(owner, `审计代理 ${RUN_TAG}`)

    // Bob 接受任务 → 只有"已接受指派的责任人"才看得见 RunLauncher
    await bob.goto('/login')
    await bob.fill('#login-username', BOB_NAME)
    await fillAndEnter(bob, '#login-password', PASSWORD)
    await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await bob.goto(`/tasks/${taskId}`)
    await bob.getByRole('button', { name: '接受任务' }).click()
    await expect(bob.getByText('你已接受此任务。')).toBeVisible()

    // 设备：经控制面起真 node（配一个 workspace），设备投影到 Hub 后 RunLauncher 才选得到
    await bob.goto('/devices')
    const codeRes = await hubApi(
      await sessionCookie(bobContext),
      'POST',
      '/devices/pairing-codes',
      {},
    )
    expect(codeRes.status).toBe(201)
    const node = await startNode({ pairingCode: (codeRes.data as { code: string }).code })
    expect(node.deviceId).not.toBe('')
    await setRuntimeFixture('approval')
    await bob.reload()
    await bob.goto(`/tasks/${taskId}`)
    await expect(bob.getByRole('heading', { name: '启动 Run' })).toBeVisible()

    const launcher = bob.locator('.run-launcher')
    const launchPoints = [
      { label: '选择 Agent', id: 'run-agent', shot: 'run-agent' },
      { label: '选择 Revision', id: 'run-revision', shot: 'run-revision' },
      { label: '选择设备', id: 'run-device', shot: 'run-device' },
      { label: '选择 Workspace', id: 'run-workspace', shot: 'run-workspace' },
    ] as const
    for (const point of launchPoints) {
      const trigger = bob.getByLabel(point.label)
      await assertNotNativeSelect(trigger, launcher, point.label)
      await assertMenuTriggerTokens(trigger)
    }
    // Agent → 设备 → Workspace 依次可选项（Revision 由 Agent 带出来，缺省即当前 Revision）
    await selectFromMenu(bob.getByLabel('选择 Agent'), `审计代理 ${RUN_TAG}`)
    await selectFromMenu(bob.getByLabel('选择设备'), /e2e-node（在线）/)
    await selectFromMenu(bob.getByLabel('选择 Workspace'), 'e2e-ws')

    // 两档截图：RunLauncher 四处（Agent 已选，其余按可选项打开）
    for (const vp of VIEWPORTS) {
      await bob.setViewportSize({ width: vp.width, height: vp.height })
      for (const point of launchPoints) {
        const trigger = bob.getByLabel(point.label)
        if (!(await trigger.isEnabled())) continue // disabled 的下拉没有可开的列表，只截控件
        await auditMenuAt(bob, trigger, `${point.shot}-${vp.name}`, vp)
      }
    }
    await bob.setViewportSize({ width: 1280, height: 720 })
    await expectNoContrastOffenders(bob)

    // ---- 落页点 1-2/7：#agent-plugin-pack / #revision-plugin-pack（Agent 页） ----
    await owner.goto('/agents')
    await expect(owner.getByRole('heading', { name: 'Agent 管理' })).toBeVisible()
    const packTrigger = owner.locator('#agent-plugin-pack')
    await assertNotNativeSelect(packTrigger, owner.locator('form'), 'Plugin Pack')
    await assertMenuTriggerTokens(packTrigger)
    for (const vp of VIEWPORTS) {
      await owner.setViewportSize({ width: vp.width, height: vp.height })
      await auditMenuAt(owner, packTrigger, `agent-plugin-pack-${vp.name}`, vp)
    }
    await owner.setViewportSize({ width: 1280, height: 720 })

    // 新建 Revision 表单里的第二个 Pack 下拉（同一个组件、不同的 id）
    await owner.goto('/agents')
    await owner.getByRole('button', { name: /审计代理/ }).click()
    const detail = owner.getByRole('region', { name: /Agent 详情/ })
    await detail.getByRole('button', { name: '新建 Revision' }).click()
    const revisionPack = detail.locator('#revision-plugin-pack')
    await expect(revisionPack).toBeAttached()
    await assertNotNativeSelect(revisionPack, detail, 'Plugin Pack')
    for (const vp of VIEWPORTS) {
      await owner.setViewportSize({ width: vp.width, height: vp.height })
      await auditMenuAt(owner, revisionPack, `revision-plugin-pack-${vp.name}`, vp)
    }
    await owner.setViewportSize({ width: 1280, height: 720 })

    // ---- S3：真实浏览器里的回焦落点（jsdom 只能给近似） ----
    const focusProbe = owner.locator('#revision-plugin-pack')
    await focusProbe.click()
    await expect(owner.getByRole('menu')).toBeVisible()
    await owner.getByRole('menuitem').first().focus()
    await owner.keyboard.press('Enter')
    await expect(focusProbe).toBeFocused()
  })
})

/**
 * 打开一个下拉、截图、判定窄屏定位、按 Esc 收起来。
 *
 * 定位判据（390 档当场判掉的那条）：
 * - 列表**不超出视口**（`min-width: 218px` 在窄屏会用到视口边缘，不能被裁掉）；
 * - 宿主容器**没有横向滚动**（`scrollWidth <= clientWidth + 1`，1px 给亚像素）。
 */
async function auditMenuAt(
  page: Page,
  trigger: ReturnType<Page['locator']>,
  shotName: string,
  viewport: { name: string; width: number; height: number },
): Promise<void> {
  // **每一档都判一次 token 来源**（评审 A-1 的补充）：`assertMenuTriggerTokens` 早先只在
  // 1280 档调用过，于是"有人往 `@media (max-width: 390px)` 里把触发器改松"这件事在浏览器侧
  // 也没有判据。源码侧现在有 `@media` 感知的扫描器（`select-menu.spec.tsx`），这里补浏览器
  // 侧的同档复核——两档各判一次，覆盖面才与截图范围一致。
  await assertMenuTriggerTokens(trigger)
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const box = await menu.boundingBox()
  expect(box, `${shotName}：菜单没有可测的包围盒`).not.toBeNull()
  const b = box as { x: number; y: number; width: number; height: number }

  // ① 不超出视口（左右都要留边：vendored Menu 的 portal 定位有 12px MARGIN，本仓未接线 portal，
  //    所以这里判的是 in-place 定位的实际结果）
  expect(b.x, `${shotName}：菜单左边越出视口（x=${b.x}）`).toBeGreaterThanOrEqual(0)
  expect(
    b.x + b.width,
    `${shotName}：菜单右边越出视口（右边界 ${Math.round(b.x + b.width)} > 视口 ${viewport.width}）`,
  ).toBeLessThanOrEqual(viewport.width + 0.5)

  // ② 宿主容器无横向滚动（列表溢出容器但容器能滚 = 页面出现横向滚动条，390 档最典型的坏味道）
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
  })
  expect(
    overflow.scrollWidth,
    `${shotName}：页面出现横向滚动（scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}）`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1)

  await page.screenshot({
    path: join(SHOT_DIR, viewport.name, `${shotName}.png`),
    fullPage: false,
  })

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
}

/** 经真实 Agent 页建一个 Agent（Plugin Pack 走真人路径：点开 → 点选项）。 */
async function createAgentViaUi(page: Page, name: string): Promise<void> {
  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Agent 管理' })).toBeVisible()
  await page.fill('#agent-name', name)
  await page.fill('#agent-persona', '你是下拉审计用的代理。')
  await page.fill('#agent-provider', 'replay')
  await page.fill('#agent-model', 'replay-model')
  await page.fill('#agent-credential-slot', 'default')
  const packTrigger = page.locator('#agent-plugin-pack')
  // 同 full-chain：菜单项文案是 pack.name（control 面种子包叫 `e2e-pack`），不是 UUID
  await selectFromMenu(packTrigger, 'e2e-pack')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  await expect(page.getByText(name).first()).toBeVisible()
}
