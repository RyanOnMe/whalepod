/**
 * #141 邀请链 E2E 草案（Q5 真人路径，两个真实浏览器上下文）。
 *
 * 场景（逐项对应 Issue #141「怎样算修好」第 3 条）：
 *   Owner 在 UI「成员」页选角色 → 生成一次性邀请链接（复制按钮 + 有效期）→
 *   Bob 在**全新浏览器上下文**打开链接（无任何 Cookie）→ 看到「哪个团队/什么角色/
 *   何时过期」→ 在链接页上建号（设用户名与口令）→ 落到项目页并看到「已加入 <团队名>」→
 *   Owner 刷新成员页，名单里出现 Bob；另一条用例验失效链接的友好错误态
 *   （页面不出现裸错误码）。
 *
 * 调度：已注册为 playwright project `p1-141` 并挂在根 `test:e2e` 串行链末位。单 Hub 只容
 * 一个团队，每次调用冷启一套真实 Hub/PG/vite（5173/18080）——**不能与其它 project 并行**，
 * 也不能在 demo 栈开着时跑（会抢节点的在线判定）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { env, fillAndEnter } from './helpers.js'

const OWNER_PASSWORD = 'correct horse battery staple'
const BOB_PASSWORD = 'correct horse battery staple'
// 账号与团队带唯一后缀：模块态不跨进程，唯一名防止同实例重放互踩（username 全局唯一）。
const RUN_TAG = randomUUID().slice(0, 8)
const OWNER_NAME = `alice-${RUN_TAG}`
const BOB_NAME = `bob-${RUN_TAG}`
const TEAM_NAME = `邀请验收团队 ${RUN_TAG}`

/** Owner 建团队 + 一个项目，落到项目页。 */
async function setupTeamAndProject(owner: Page): Promise<void> {
  await owner.goto('/setup')
  await owner.fill('#setup-token', env().setupToken)
  await owner.fill('#team-name', TEAM_NAME)
  await owner.fill('#setup-username', OWNER_NAME)
  await owner.fill('#setup-display-name', 'Alice')
  await fillAndEnter(owner, '#setup-password', OWNER_PASSWORD)
  await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  // #152：「创建项目」表单默认收起（与「创建任务」同款折叠入口），先点开再填。
  await owner.getByRole('button', { name: '新建项目' }).click()
  await fillAndEnter(owner, '#project-name', '邀请链项目')
  await expect(owner.getByRole('heading', { name: '邀请链项目' })).toBeVisible()
}

/** Owner 从主导航进「成员」页，选角色并生成邀请；返回页面显示的完整链接。 */
async function createInviteViaUi(owner: Page, role: 'member' | 'admin'): Promise<string> {
  await owner
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '成员' })
    .click()
  await expect(owner.getByRole('heading', { name: '成员', exact: true })).toBeVisible()
  await owner.selectOption('#invite-role', role)
  await owner.getByRole('button', { name: '生成邀请链接' }).click()
  const link = owner.locator('code.invite-link')
  await expect(link).toBeVisible()
  // 有效期可见（Issue 判据 1）
  await expect(owner.getByText('有效期至')).toBeVisible()
  const text = await link.innerText()
  expect(text).toContain('/invites/')
  return text.trim()
}

test.describe('#141 邀请链：Owner 生成 → Bob 新浏览器加入', () => {
  let ownerContext: BrowserContext
  let bobContext: BrowserContext

  test.beforeEach(async ({ browser }) => {
    ownerContext = await browser.newContext()
    bobContext = await browser.newContext()
  })
  test.afterEach(async () => {
    await ownerContext.close()
    await bobContext.close()
  })

  test('Bob 从零到加入 + 失效链接人话错误态（单 Hub 单团队，故合为一条自洽用例）', async () => {
    const owner = await ownerContext.newPage()
    await setupTeamAndProject(owner)
    const inviteUrl = await createInviteViaUi(owner, 'member')

    // ---- Bob：全新上下文（无任何 Cookie）打开邀请链接 ----
    const bob = await bobContext.newPage()
    await bob.goto(inviteUrl)
    await expect(bob.getByRole('heading', { name: '加入团队' })).toBeVisible()
    // 未登录时说清「哪个团队、什么角色、何时过期」
    await expect(
      bob.getByText(new RegExp(`团队「${TEAM_NAME}」邀请你以 Member 身份加入`)),
    ).toBeVisible()
    // 建号腿（键盘可达：逐字段填 + Enter 提交）
    await bob.fill('#invite-signup-username', BOB_NAME)
    await bob.fill('#invite-signup-display-name', 'Bob')
    await fillAndEnter(bob, '#invite-signup-password', BOB_PASSWORD)

    // 落到项目页并提示「已加入 <团队名>」
    await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await expect(bob.getByText(`已加入 ${TEAM_NAME}`)).toBeVisible()

    // ---- Owner 视角：成员名单里出现 Bob（Issue 判据 3 的收尾） ----
    await owner.reload()
    await owner
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '成员' })
      .click()
    const bobRow = owner.locator('li.member-item', { hasText: BOB_NAME })
    await expect(bobRow).toBeVisible()
    await expect(bobRow.getByText(`@${BOB_NAME}`)).toBeVisible()

    // ---- 失效链接：给人话错误态，不出现裸错误码（同一用例内续跑） ----
    // 为什么合并在一条里：单 Team 部署下 Hub 只容一次 Setup，第二条独立用例
    // 再走 setupTeamAndProject 会撞在已初始化的实例上（页面跳登录 → 超时），
    // 这不是产品缺陷而是用例生命周期写错——首轮 Q5 实测踩到并修正。
    const strangerContext = await bobContext.browser()!.newContext()
    try {
      const stranger = await strangerContext.newPage()
      await stranger.goto(`${inviteUrl}-tampered`)
      const alert = stranger.getByRole('alert')
      await expect(alert).toBeVisible()
      await expect(alert).toContainText('这条邀请链接')
      await expect(alert).not.toContainText('NOT_FOUND')
      await expect(alert).not.toContainText('CONFLICT')
      await expect(alert).not.toContainText('404')
      await expect(alert).not.toContainText('409')
    } finally {
      await strangerContext.close()
    }
  })
})

/**
 * 登记说明（主协调者执行，勿并行）：
 * 1. playwright.config.ts 的 projects 加 `{ name: 'p1-141', testMatch: /invite-accept\.spec\.ts/ }`；
 * 2. 根 package.json 的 test:e2e 串行链追加 `&& playwright test --project=p1-141`；
 * 3. 之后可挂进 scripts/q5-loop.sh 的 20 次口径。
 *
 * 用例生命周期约束（本文件首轮 Q5 实测得出）：**单 Team 部署下 Hub 只容一次 Setup**，
 * 所以本文件只能有**一条**用例（一条用例内串完「加入成功」与「失效链接」两个场景）；
 * 新增第二条独立用例必须先登录既有团队，不能重跑 Setup。
 */
