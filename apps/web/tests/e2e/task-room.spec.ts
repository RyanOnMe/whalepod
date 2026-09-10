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
import { assertControlTokens } from './helpers.js'
import { expectNoContrastOffenders } from './contrast-sweep.js'
import {
  PERSON_SLOTS,
  ROSTER_PENDING_LABEL,
  personRosterFromMembers,
  personSlotProblems,
  type PersonRoster,
  type PersonSlot,
  type PersonSlotSample,
} from '../person-identity.js'

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
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
 *
 * **已知盲区（#162 补）**：`shortId()` 产出的是 8 位**不带连字符**的十六进制，
 * 从 `UUID_SHAPE` 底下整类穿过（「当前责任人 01a08c11」就是这么上屏的）。指人的
 * 位置改由 `expectPersonSlotsUseDisplayNames` 判——它位置敏感，且期望值取自真实
 * 名册，不是「页面里别出现十六进制」那种一刀切（Run 短 id、用户名里的随机 tag、
 * sha 前缀都合法长这个形状，一刀切会假红）。
 */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-/
const BARE_STATUS_ENUM = /\b(pending|accepted|rejected|in_progress)\b/

async function expectNoJargonVisible(page: Page): Promise<void> {
  const text = await page.locator('body').innerText()
  expect(text, '页面可见文本不应出现 UUID 形态').not.toMatch(UUID_SHAPE)
  expect(text, '页面可见文本不应出现裸状态枚举').not.toMatch(BARE_STATUS_ENUM)
}

/** GET /team/members 的响应元素（Hub 出网字段子集；data 即裸数组）。 */
interface RosterMember {
  userId: string
  username: string
  displayName: string
  enabled: boolean
}

/**
 * #162 判据的期望值来源：控制面 HTTP 取真身名册（与页面同一数据源）。
 * 判据里的成员名**不写死**——写死名字的判据只是在测测试自己；而且随机后缀的
 * 用户名（`bob-1a2b3c4d`）本来就是本次要防假红的那类形状。
 */
async function fetchRoster(cookie: string): Promise<{
  roster: PersonRoster
  members: RosterMember[]
}> {
  const res = await hubApi(cookie, 'GET', '/team/members')
  expect(res.status, 'GET /team/members 未返回 200（判据拿不到期望值）').toBe(200)
  const members = res.data as RosterMember[]
  expect(Array.isArray(members) && members.length > 0, '名册为空：判据失去期望值').toBe(true)
  return { roster: personRosterFromMembers(members), members }
}

/**
 * #162 判据：Task Room 里**指人的位置**必须说出「是谁」——成员显示名，或明确的
 * 兜底文案（「未知成员」/「已离开的成员」），或视角词「你」；不得是 `shortId()`
 * 的 8 位十六进制内部 id。
 *
 * 判定逻辑在 `../person-identity.js`（纯函数，组件测试与 e2e 共用一份，避免两处
 * 口径分叉）；这里只负责用真浏览器的 locator 取**可见文本**并保证判据真的覆盖到
 * 了元素——选择器失效或该区没渲染时必须红，不能静默通过（六原语·判定：缺一环必须失败）。
 */
async function expectPersonSlotsUseDisplayNames(
  page: Page,
  roster: PersonRoster,
  slots: readonly PersonSlot[],
  where: string,
): Promise<void> {
  const samples: PersonSlotSample[] = []
  for (const slot of slots) {
    const elements = page.locator(slot.selector)
    const count = await elements.count()
    expect(
      count,
      `#162 判据没覆盖到「${slot.what}」（${slot.selector} 无匹配元素）：选择器失效或该区未渲染`,
    ).toBeGreaterThan(0)
    /**
     * 前提等待：名册没落定时人名位置本来就该写「未知成员」，此时判「说了谁」没有意义。
     * 等它过去再采样；名册请求真挂了就一直等不到 → 超时判红（判定不了也是失败，
     * 不能因为「看起来是加载态」就静默放过）。
     */
    await expect(
      elements.first(),
      `#162 名册未落定（仍呈现「${ROSTER_PENDING_LABEL}」）：无法判定「${slot.what}」是否写了人名`,
    ).not.toContainText(ROSTER_PENDING_LABEL)
    const texts: string[] = []
    for (let index = 0; index < count; index += 1) {
      texts.push(await elements.nth(index).innerText())
    }
    samples.push({ slot, texts })
  }
  const problems = personSlotProblems(samples, roster)
  expect(problems, `#162 ${where}：人名位置出现内部 id 或说不出「是谁」`).toEqual([])
}

/**
 * #152 判据：项目页首屏（不滚动）必须看得见项目列表与「任务列表」入口。
 * 桌面与 390×844 两档都判——「创建项目」表单常驻展开曾把两者挤出首屏。
 */
async function assertProjectFirstScreen(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport)
  await page.evaluate(() => window.scrollTo(0, 0))
  const item = await page.locator('.project-list > li').first().boundingBox()
  const taskListButton = await page.getByRole('button', { name: '任务列表' }).first().boundingBox()
  expect(item, '项目列表首项未渲染').not.toBeNull()
  expect(taskListButton, '「任务列表」入口未渲染').not.toBeNull()
  const itemBottom = (item?.y ?? 0) + (item?.height ?? 0)
  const buttonBottom = (taskListButton?.y ?? 0) + (taskListButton?.height ?? 0)
  expect(
    itemBottom,
    `项目列表首项在视口外（bottom=${itemBottom} > ${viewport.height}）`,
  ).toBeLessThanOrEqual(viewport.height)
  expect(
    buttonBottom,
    `「任务列表」入口在视口外（bottom=${buttonBottom} > ${viewport.height}）`,
  ).toBeLessThanOrEqual(viewport.height)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
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

    // ---- #152：项目页首屏先看得见列表与「任务列表」入口，表单要手动展开 ----
    // 「创建项目」默认收起（与「创建任务」同款 aria-expanded 语义）——常驻展开的
    // 两个输入框 + 按钮会把列表与任务入口推到首屏之外。
    const newProjectToggle = alice.getByRole('button', { name: '新建项目' })
    await expect(newProjectToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(alice.locator('#project-name')).toHaveCount(0) // 收起时表单不在 DOM 里
    await newProjectToggle.click()
    await expect(alice.getByRole('button', { name: '收起' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(alice.locator('#project-name')).toBeVisible()

    // ---- Alice：创建项目（键盘：名称输入框内 Enter） ----
    await fillAndEnter(alice, '#project-name', '验收项目')
    await expect(alice.getByText('验收项目').first()).toBeVisible()
    // 建成即收起：新项目卡片就在下面，不需要用户再点一次「收起」
    await expect(alice.getByRole('button', { name: '新建项目' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await assertProjectFirstScreen(alice, { width: 1280, height: 720 })
    // #159：首屏可见性判据（上面那两条）与对比度是两件事——一个元素可以在首屏内、
    // 但仍然浅到读不清。项目页此刻已有项目卡片 + 折叠入口 + 任务列表，扫真实渲染。
    await expectNoContrastOffenders(alice)
    await assertProjectFirstScreen(alice, { width: 390, height: 844 })
    await expectNoContrastOffenders(alice)
    await alice.setViewportSize({ width: 1280, height: 720 })

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
    // #168：项目页这一屏同时有 `.field input` / `.field textarea` / `.button`（含
    // primary 与 quiet 两个变体）——正是"同一屏两族控件"的现场，所以在真实浏览器里采一遍
    // computed style：描边宽度与圆角必须等于 vendored Input 的度量，颜色必须等于 L1 token
    // 的解析值，min-height 必须等于 --touch-min。判据与单测共用
    // `src/shared/control-style-tokens.ts`（各写一份必漂移）。
    await assertControlTokens(taskIdInput, '.field input（任务标题）')
    await assertControlTokens(
      alice.locator('textarea[id^="task-desc-"]'),
      '.field textarea（任务描述）',
    )
    await assertControlTokens(
      alice.locator('form[aria-label="创建任务"] .button.button-primary'),
      '.button-primary（创建任务）',
    )
    await assertControlTokens(
      alice.locator('form[aria-label="创建任务"] .button.button-quiet'),
      '.button-quiet（取消）',
    )
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

    // ---- #162：指人的位置必须写显示名（此前是 `shortId()`，判据看不见） ----
    // 期望值取自真身名册（控制面 HTTP），不是写死的姓名；Bob 是本次指派的责任人。
    const { roster, members } = await fetchRoster(aliceCookie)
    const bobMember = members.find((member) => member.username === BOB_NAME)
    if (bobMember === undefined) {
      throw new Error(`名册里没有 ${BOB_NAME}（判据的期望人缺失）`)
    }
    // 判据先跑（这样变异回短 id 时，第一个红灯就是判据自己的诊断）。
    await expectPersonSlotsUseDisplayNames(
      alice,
      roster,
      [PERSON_SLOTS.assignee, PERSON_SLOTS.assignmentNote],
      'Task Room 首屏（Alice 视角）',
    )
    // 正向：这两处确实说出了 Bob 的显示名/用户名（不是「只要不是 id 就行」）。
    await expect(alice.locator('[data-testid="task-assignee"]')).toContainText(
      bobMember.displayName,
    )
    await expect(alice.locator('[data-testid="assignment-assignee-note"]')).toContainText(
      bobMember.username,
    )

    // #159：空态也要扫（空态引导文字往往是 secondary 灰，最容易掉到 AA 以下）。
    // 放在术语判据之后：那时 "当前责任人" 与留言区都已渲染出来，扫描不会取在渲染之前。
    await expectNoContrastOffenders(alice)
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

    // #162：留言作者同样是人名（Bob；Alice 视角下不是「你」），责任人仍写显示名。
    // 判据先跑，正向断言随后（变异回短 id 时先看到判据的诊断）。
    await expectPersonSlotsUseDisplayNames(
      alice,
      roster,
      [PERSON_SLOTS.assignee, PERSON_SLOTS.commentAuthor],
      'Alice 重载后的留言区',
    )
    await expect(alice.locator('[data-testid="comment-author"]').first()).toContainText(
      bobMember.displayName,
    )
    // Bob 看自己：两处都是视角词「你」——它不是姓名，但判据必须放行（否则假红）。
    await expectPersonSlotsUseDisplayNames(
      bob,
      roster,
      [PERSON_SLOTS.assignee, PERSON_SLOTS.commentAuthor],
      'Bob 自己视角',
    )

    // 键盘可达性证据：从留言输入框 Tab 一步即达提交按钮（与 DOM 顺序一致）。
    await bob.focus('textarea[name="body"]')
    await bob.keyboard.press('Tab')
    await expect(bob.getByRole('button', { name: '发送留言' })).toBeFocused()

    // #159：Task Room 是**内容最杂的一页**（责任人栏 + 留言时间线 + Run/Artifact 区），
    // 也是本项目里唯一有文本框、徽标、时间戳混排的页面。放到最后扫：此时是「已被接受
    // + 已有留言」的完整态，空态与满态的文字色并不保证同源，两个态都要扫到。
    await expectNoContrastOffenders(alice)
    await expectNoContrastOffenders(bob)
  })
})
