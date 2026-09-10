/**
 * #140 实时观察验收（Q5 浏览器门）：**同组另一名成员不做任何操作**。
 *
 * 背景（为什么必须新开一条 Q5 用例）：既有 full-chain/task-room 两条用例用
 * 「显式 reload」驱动跨会话可见性（见 full-chain.spec.ts 头注释），因此
 * `event-router` 把 task/comment/approval/artifact 失效到 `['task', id]`
 * 而 Task Room 查询键是 `['task-room', id]` 这一漂移，全门绿也抓不到——
 * 真人看到的现象是「同事改了东西，我这边一直不动」。
 *
 * 本用例只做一件事：Alice 在 UI 上留言，Bob 的页面**零操作**（不 reload、
 * 不导航、不点击）必须在超时内出现该留言。这就是产品命题「两名成员围绕
 * 一个 Task 共同观察」的最小可证伪判据。
 *
 * 通道纪律（六原语·驱动）：项目与 Task 的**建**走 Hub HTTP（创建 UI 由 #136
 * 的用例覆盖，此处不重复）；**观察**必须走浏览器，且不得用 reload 兜底。
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

const PASSWORD = 'correct horse battery staple'
const RUN_TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-rt-${RUN_TAG}`
const BOB_NAME = `bob-rt-${RUN_TAG}`

/** 观察窗口：帧从 Outbox 经 WS 到浏览器重渲染，5 秒对本地栈是充裕的。 */
const OBSERVE_TIMEOUT_MS = 5_000

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

async function fillAndEnter(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value)
  await page.press(selector, 'Enter')
}

test.describe('#140 同组成员零操作实时可见', () => {
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

  test('Alice 留言后，Bob 不 reload 也能看到（任务级帧真的到达浏览器）', async () => {
    const alice = await aliceContext.newPage()

    // ---- Alice：真实 Setup 页开通团队 ----
    await alice.goto('/setup')
    await alice.fill('#setup-token', env.setupToken)
    await alice.fill('#team-name', `实时验收团队 ${RUN_TAG}`)
    await alice.fill('#setup-username', ALICE_NAME)
    await alice.fill('#setup-display-name', 'Alice')
    await fillAndEnter(alice, '#setup-password', PASSWORD)
    await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    const aliceCookie = await sessionCookie(aliceContext)

    // ---- Bob 账号（非 UI 范围） ----
    const invite = await hubApi(aliceCookie, 'POST', '/invites', { role: 'member' })
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

    // ---- 项目与 Task：Hub HTTP（创建 UI 不属本用例范围） ----
    const project = await hubApi(aliceCookie, 'POST', '/projects', { name: '实时验收项目' })
    expect(project.status).toBe(201)
    const projectId = (project.data as { id: string }).id
    const task = await hubApi(aliceCookie, 'POST', `/projects/${projectId}/tasks`, {
      title: '协作观察用例',
      assigneeUserId: bobUserId,
    })
    expect(task.status).toBe(201)
    const taskId = (task.data as { id: string }).id

    // ---- Bob：真实登录并停在 Task Room（此后零操作） ----
    const bob = await bobContext.newPage()
    await bob.goto('/login')
    await fillAndEnter(bob, '#login-username', BOB_NAME)
    await bob.fill('#login-password', PASSWORD)
    await bob.press('#login-password', 'Enter')
    await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await bob.goto(`/tasks/${taskId}`)
    await expect(bob.getByText('协作观察用例')).toBeVisible()

    // ---- Alice：同任务页面里经 UI 留言 ----
    await alice.goto(`/tasks/${taskId}`)
    await alice.fill('textarea[name="body"]', '这是 Alice 的实时留言。')
    await alice.keyboard.press('Tab')
    await alice.keyboard.press('Enter')
    await expect(alice.getByText('这是 Alice 的实时留言。')).toBeVisible()

    // ---- 判据：Bob 不 reload、不导航、不点击，也必须出现 ----
    await expect(bob.getByText('这是 Alice 的实时留言。')).toBeVisible({
      timeout: OBSERVE_TIMEOUT_MS,
    })
  })
})
