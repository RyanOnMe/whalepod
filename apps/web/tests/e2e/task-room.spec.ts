/**
 * P1-07 验收场景（Issue #11）：真浏览器双上下文主链。
 *
 * Alice（首个用户，走真实 Setup 页）创建项目与 Task 并指派 Bob；
 * Bob（第二 BrowserContext，走真实登录页）在 Task Room 接受指派并留言；
 * Alice 重载后看到 Bob 的接受与留言。主链全程键盘可达：
 * 登录/创建表单用输入框内 Enter（隐式提交），留言经 Tab 到提交按钮激活。
 *
 * 前置：playwright webServer 已拉起真实 Hub + PostgreSQL + vite（见 playwright.config.ts）。
 * Bob 的账号经 HTTP API 以 Alice 会话开通（邀请开通不在本场景 UI 范围——成员管理
 * UI 属后续版本），Bob 之后的一切动作都走真实浏览器路径。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

interface E2eEnv {
  hubOrigin: string
  webOrigin: string
  setupToken: string
}

const env = JSON.parse(readFileSync(join(tmpdir(), 'whalepod-e2e-env.json'), 'utf8')) as E2eEnv

const ALICE_PASSWORD = 'correct horse battery staple'
const BOB_PASSWORD = 'correct horse battery staple'
// 账号与团队带唯一后缀：worker/环境复用下模块态不跨进程，唯一名防止任何
// 同实例重放互踩（全局 username 唯一是产品约束）。
const RUN_TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-${RUN_TAG}`
const BOB_NAME = `bob-${RUN_TAG}`

/** 以某个已登录会话的 Cookie 直调 Hub HTTP API（账号开通等非场景动作用）。 */
async function hubApi(
  cookie: string,
  method: 'POST',
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${env.hubOrigin}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Origin 与 Idempotency-Key 与浏览器同形（03 §4：非安全方法双闸门）。
      origin: env.webOrigin,
      'idempotency-key': randomUUID(),
      cookie,
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; data?: unknown }
  return { status: res.status, data: json.data }
}

async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(env.webOrigin)
  const session = cookies.find((c) => c.name === 'whalepod_session')
  if (session === undefined) throw new Error('会话 Cookie 不存在')
  return `${session.name}=${session.value}`
}

/** 键盘路径：填输入框后 Enter（表单隐式提交）。 */
async function fillAndEnter(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value)
  await page.press(selector, 'Enter')
}

/**
 * #152「零泄漏」机器判据：用户可见文本里不得出现内部词汇。
 *
 * - UUID 形态（`01a08c11-…`）：截断/完整 UUID 都不是名字（实测截图里的
 *   `by 01a08c11`）；
 * - 裸枚举词（pending/accepted/rejected/in_progress）：状态必须走中文标签表，
 *   内部枚举值不上屏。
 *
 * 只读 `innerText`（用户真正看得见的文本，display:none 不算），不扫 DOM 属性：
 * 判据是「人看到的」，不是「源码里有没有」。调用点都先等待目标区域渲染完成，
 * 避免扫到一个空页面就算通过。
 */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-/
const BARE_STATUS_ENUM = /\b(pending|accepted|rejected|in_progress)\b/

async function expectNoJargonVisible(page: Page): Promise<void> {
  const text = await page.locator('body').innerText()
  expect(text, '页面可见文本不应出现 UUID 形态').not.toMatch(UUID_SHAPE)
  expect(text, '页面可见文本不应出现裸状态枚举').not.toMatch(BARE_STATUS_ENUM)
}

test.describe('P1-07 验收：双浏览器上下文主链', () => {
  let aliceContext: BrowserContext
  let bobContext: BrowserContext

  test.beforeEach(async ({ browser }) => {
    aliceContext = await browser.newContext()
    bobContext = await browser.newContext()
  })
  test.afterEach(async () => {
    await aliceContext.close()
    await bobContext.close()
  })

  test('Alice 建 Task，Bob 第二上下文接受并留言，键盘可完成主链', async () => {
    const alice = await aliceContext.newPage()

    // ---- Alice：真实 Setup 页开通团队与 Owner ----
    await alice.goto('/setup')
    await alice.fill('#setup-token', env.setupToken)
    await alice.fill('#team-name', `验收团队 ${RUN_TAG}`)
    await alice.fill('#setup-username', ALICE_NAME)
    await alice.fill('#setup-display-name', 'Alice')
    await fillAndEnter(alice, '#setup-password', ALICE_PASSWORD)
    await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

    // ---- Alice：创建项目（键盘：名称输入框内 Enter） ----
    await fillAndEnter(alice, '#project-name', '验收项目')
    await expect(alice.getByText('验收项目').first()).toBeVisible()

    // ---- Bob 账号：Alice 会话经 HTTP API 开通 ----
    // 此处保留 HTTP 直连是**有意的分工**：本 spec 判的是 Task Room 双会话主链，
    // 邀请链自身的真人路径（成员页生成链接 → 新浏览器加入）由 `invite-accept.spec.ts`
    // （project p1-141）覆盖——那条曾经写在注释里的「成员管理 UI 属后续版本」已由 #141 兑现。
    const aliceCookie = await sessionCookie(aliceContext)
    const invite = await hubApi(aliceCookie, 'POST', '/invites', { role: 'member' })
    expect(invite.status).toBe(201)
    const inviteToken = (invite.data as { token: string }).token
    const accepted = await fetch(`${env.hubOrigin}/api/v1/invites/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.webOrigin,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        token: inviteToken,
        username: BOB_NAME,
        displayName: 'Bob',
        password: BOB_PASSWORD,
      }),
    })
    expect(accepted.status).toBe(201)
    const bobUserId = ((await accepted.json()) as { data: { userId: string } }).data.userId

    // ---- Alice：创建 Task 并指派 Bob（#136 起责任人为下拉选择器，默认选中自己） ----
    await alice.getByRole('button', { name: '创建任务' }).click()
    const taskIdInput = alice.locator('input[id^="task-title-"]')
    await taskIdInput.fill('起草验收报告')
    await alice.selectOption('select[id^="task-assignee-"]', bobUserId)
    await alice
      .locator('form[aria-label="创建任务"]')
      .getByRole('button', { name: /创建任务/ })
      .click()
    await alice.waitForURL(/\/tasks\//)
    const taskUrl = new URL(alice.url()).pathname
    const taskId = taskUrl.split('/').pop() ?? ''
    expect(taskId).not.toBe('')

    // Task Room 四区可见（header/assignment/comments/runs+artifacts 空态）
    await expect(alice.getByText('起草验收报告').first()).toBeVisible()
    await expect(alice.getByText('还没有留言')).toBeVisible()
    // #152：Task Room 一屏内不得出现 UUID 形态与裸状态枚举（责任人姓名走成员名录，
    // 分配状态走 ASSIGNMENT_STATUS_LABEL）。
    await expect(alice.locator('dt', { hasText: '当前责任人' })).toBeVisible()
    await expectNoJargonVisible(alice)

    // ---- #137：离开 Task Room 后能找回任务（项目页任务列表） ----
    // 判据：真人路径「返回项目页 → 展开任务列表 → 看到刚建的任务 → 点回 Task Room」。
    await alice.goto('/')
    await alice.getByRole('button', { name: '任务列表' }).click()
    const listedTask = alice.getByRole('button', { name: '起草验收报告' })
    await expect(listedTask).toBeVisible()
    // 责任人显示名来自成员接口（#136），不是短 UUID
    await expect(alice.getByRole('list', { name: '项目任务列表' })).toContainText('Bob（@bob')
    // #152：项目卡写的是创建者姓名（成员名录），不是截断 UUID；列表就绪后再取文本
    await expect(alice.locator('.project-meta').first()).toContainText('创建者')
    await expectNoJargonVisible(alice)
    await listedTask.click()
    await alice.waitForURL(new RegExp(`/tasks/${taskId}$`))
    await expect(alice.getByText('还没有留言')).toBeVisible()

    // ---- Bob：第二 BrowserContext 走真实登录页 ----
    const bob = await bobContext.newPage()
    await bob.goto('/login')
    await bob.fill('#login-username', BOB_NAME)
    await fillAndEnter(bob, '#login-password', BOB_PASSWORD)
    await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

    // ---- Bob：打开 Task Room，接受指派（键盘可达：Tab 到按钮 Enter） ----
    await bob.goto(`/tasks/${taskId}`)
    await expect(bob.getByText('你被指派负责此任务，请接受或拒绝。')).toBeVisible()
    const acceptButton = bob.getByRole('button', { name: '接受任务' })
    await acceptButton.focus()
    await bob.keyboard.press('Enter')
    await expect(bob.getByText('你已接受此任务。')).toBeVisible()

    // ---- Bob：留言（textarea 内 Enter 是换行；Tab 到提交按钮激活——键盘链成立点） ----
    await bob.fill('textarea[name="body"]', '收到，本周内出初稿。')
    await bob.keyboard.press('Tab')
    await bob.keyboard.press('Enter')
    await expect(bob.getByText('收到，本周内出初稿。')).toBeVisible()

    // ---- Alice：重载后看到 Bob 的接受与留言（同任务另一会话的真实可见性） ----
    await alice.reload()
    await expect(alice.getByText('收到，本周内出初稿。')).toBeVisible()
    // Bob 接受后任务状态仍是未开始（in_progress 随 Run 启动），可见的是
    // 「已接受」徽标 + 非责任人视角的第三方陈述措辞。
    await expect(alice.getByText('责任人已接受此任务。')).toBeVisible()
    // #152：留言作者与分配状态这一屏同样零内部词汇（`accepted` 只能以「已接受」出现）
    await expect(alice.locator('span.badge', { hasText: '已接受' }).first()).toBeVisible()
    await expectNoJargonVisible(alice)
    await expectNoJargonVisible(bob)

    // 键盘可达性证据：从留言输入框 Tab 一步即达提交按钮（与 DOM 顺序一致）。
    await bob.focus('textarea[name="body"]')
    await bob.keyboard.press('Tab')
    await expect(bob.getByRole('button', { name: '发送留言' })).toBeFocused()
  })
})
