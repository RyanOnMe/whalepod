import { showAgentCreation } from './helpers.js'
/**
 * #312 指派 Agent 建任务的两支浏览器判据（Q5 新面）：信封顶层兄弟位的 `drive`
 * 在**真 Chrome + 真 Hub** 上真的走到 toast。
 *
 * 之前这条链只在 jsdom 里验，而 jsdom 的 fixture 是前端自己造的（drive 塞进 `data`）
 * ——真页面上那条 toast 从不出现（#312 实测 16s 无 toast）。本 spec 走真人路径钉两支：
 *
 * 1. **设备离线**（还没配对任何 Node 时指派 Agent）：任务仍创建成功（201 不吞），
 *    toast 如实说「自动执行未开始（DEVICE_OFFLINE）」并给恢复入口；Task Room 聚合里
 *    没有 Run（不谎报执行）——随后配对真 Node 准备环境，从**这个任务**手动发起，
 *    项目任务数不变（重试不重开任务）。
 * 2. **设备在线**：toast 说「Agent 已自动开始执行」，且 Task Room 聚合里真的出现 Run
 *    （只说不做与只做不说的两种漏法都被这条链卡住）。
 *
 * 账号开通/配对码走 HTTP 旁路（成员管理/设备配对 UI 的真人路径由 p1-141/p1-142 覆盖），
 * Node 生命周期经 e2e-serve 控制面（只做进程，不做产品动作）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertNotNativeSelect,
  env,
  fillAndEnter,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  sleep,
  startNode,
} from './helpers.js'

const ALICE_PASSWORD = 'correct horse battery staple'
// 唯一后缀：单 worker 内存态，避免与环境复用/漂移互踩（username 全局唯一是产品约束）。
const RUN_TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-${RUN_TAG}`
const AGENT_NAME = 'report-writer'

const shared: {
  context?: BrowserContext
  alice?: Page
  cookie?: string
  userId?: string
  projectId?: string
  offlineTaskId?: string
} = {}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  // 网址上下文是文件级生命周期：三个用例共享一次 Setup 与一个团队（单 Hub 只容一个团队）。
  shared.context = await browser.newContext()
})

test.afterAll(async () => {
  await shared.context?.close()
})

/** 一次性引导：团队 → 项目 → Plugin Pack 种子 → 真人 UI 建 Agent。 */
async function bootstrap(): Promise<void> {
  if (shared.projectId !== undefined) return
  const alice = await shared.context!.newPage()
  shared.alice = alice

  await alice.goto('/setup')
  await alice.fill('#setup-token', env().setupToken)
  await alice.fill('#team-name', `P1-312 驱动验收团队 ${RUN_TAG}`)
  await alice.fill('#setup-username', ALICE_NAME)
  await alice.fill('#setup-display-name', 'Alice')
  await fillAndEnter(alice, '#setup-password', ALICE_PASSWORD)
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

  await alice.getByRole('button', { name: '新建项目' }).click()
  await fillAndEnter(alice, '#project-name', 'P1-312 指派驱动项目')
  // #415：等项目真正落库并刷新到列表，再读 /projects；POST 在途时读到空数组会让 [0] 崩。
  await expect(alice.getByText('P1-312 指派驱动项目').first()).toBeVisible()

  shared.cookie = await sessionCookie(shared.context!)
  const me = await hubApi(shared.cookie, 'GET', '/auth/session')
  shared.userId = (me.data as { userId: string }).userId
  const projects = await hubApi(shared.cookie, 'GET', '/projects')
  shared.projectId = (projects.data as Array<{ id: string }>)[0]!.id

  await seedPluginPack(shared.userId)
  await createAgentViaUi(alice, AGENT_NAME)
}

async function createAgentViaUi(page: Page, name: string): Promise<void> {
  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await showAgentCreation(page)

  await page.fill('#agent-name', name)
  await page.fill('#agent-persona', '你是 E2E 验收代理。')
  await page.fill('#agent-provider', 'replay')
  await page.fill('#agent-model', 'replay-model')
  await page.fill('#agent-credential-slot', 'default')
  const packTrigger = page.locator('#agent-plugin-pack')
  await assertNotNativeSelect(packTrigger, page.locator('form'), '插件组合（Plugin Pack）')
  await selectFromMenu(packTrigger, 'e2e-pack')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  await expect(page.getByText(name).first()).toBeVisible()
}

/**
 * 真人路径：项目页开表单 → 填标题/描述 → **开启「创建后立即执行」** → 选 Agent → 提交。
 *
 * #344 起执行是显式开关（责任人只选真人）：默认关 = 只创建任务；开启后按钮变
 * 「创建并开始执行」，Agent 在单独的「执行 Agent」栏里选。这里同时钉住开关默认态与
 * 按钮换名——它们就是「创建」与「创建后执行」被拆开的可见证据。
 */
async function createAgentTaskViaUi(
  title: string,
  shots?: { dir: string; name: string },
): Promise<void> {
  const alice = shared.alice!
  await alice.goto('/')
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await alice.getByRole('button', { name: '创建任务' }).click()
  const form = alice.locator('form[aria-label="创建任务"]')
  await alice.locator('input[id^="task-title-"]').fill(title)
  await alice.locator('textarea[id^="task-desc-"]').fill('以标题与描述作为指令执行')
  const assignee = form.locator('button[id^="task-assignee-"]')
  await assertNotNativeSelect(assignee, form, '责任人')
  const toggle = form.getByRole('switch', { name: '创建后立即执行' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(form.getByRole('button', { name: '创建任务' })).toBeVisible()
  // 截图只给人复核版面（判定仍靠断言，不看截图判完成）：开关关/开两态各一张。
  if (shots !== undefined) {
    await mkdir(shots.dir, { recursive: true })
    await form.screenshot({ path: join(shots.dir, `${shots.name}-off.png`) })
  }
  // 命中区：点**可见文本**也要能开（整行是 label 包 Switch），且只翻一次——
  // jsdom 里那条只是近似，真浏览器转发行为在这里再钉一遍。
  await form.getByText('创建后立即执行', { exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await selectFromMenu(
    form.locator('button[id^="task-execution-agent-"]'),
    `${AGENT_NAME}（Agent）`,
  )
  if (shots !== undefined) {
    await form.screenshot({ path: join(shots.dir, `${shots.name}-on.png`) })
  }
  await form.getByRole('button', { name: '创建并开始执行' }).click()
}

async function projectTasks(): Promise<Array<{ id: string; title: string }>> {
  const res = await hubApi(shared.cookie!, 'GET', `/projects/${shared.projectId}/tasks`)
  return res.data as Array<{ id: string; title: string }>
}

/** Task Room 聚合里的 Run（判定事实，不驱动产品动作）。 */
async function taskRuns(taskId: string): Promise<Array<{ id: string; status: string }>> {
  const res = await hubApi(shared.cookie!, 'GET', `/tasks/${taskId}`)
  const room = res.data as { runs?: Array<{ id: string; status: string }> } | undefined
  return room?.runs ?? []
}

async function waitForTaskRuns(taskId: string, minCount: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const runs = await taskRuns(taskId)
    if (runs.length >= minCount) return runs
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 的 Run 数未达到 ${minCount}（当前 ${runs.length}）`)
    }
    await sleep(500)
  }
}

async function waitDeviceOnline(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await hubApi(shared.cookie!, 'GET', '/devices')
    const devices = res.data as Array<{ id: string; status: string }>
    const mine = devices.find((d) => d.status === 'online')
    if (mine !== undefined) return
    if (Date.now() > deadline) throw new Error(`设备未回在线（等待 ${timeoutMs}ms）`)
    await sleep(500)
  }
}

function taskIdFromUrl(page: Page): string {
  const matched = /\/tasks\/([0-9a-f-]{36})/.exec(page.url())
  if (matched === null) throw new Error(`URL 里没有任务 id：${page.url()}`)
  return matched[1]!
}

test('设备未配对：任务仍创建成功，toast 如实说自动执行未开始（DEVICE_OFFLINE）', async () => {
  test.setTimeout(240_000) // 承载一次性 Setup（团队/项目/Agent 冷启动）。
  await bootstrap()
  const alice = shared.alice!
  await createAgentTaskViaUi('离线分支：写发布说明', {
    dir: join(process.cwd(), 'artifacts', 'evidence', 'create-form-split'),
    name: 'create-task-form',
  })

  // #312 的核心判据：这条 toast 在真页面上必须出现（此前恒不出现）。
  const toast = alice.locator('.toast-item').first()
  await expect(toast).toContainText('自动执行未开始（DEVICE_OFFLINE）', { timeout: 15_000 })
  await expect(toast).toContainText('可在任务执行区手动发起')

  // 201 不吞：落到刚建的任务里，且项目里就这一个任务。
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 15_000 })
  shared.offlineTaskId = taskIdFromUrl(alice)
  const tasks = await projectTasks()
  expect(tasks.map((t) => t.id)).toEqual([shared.offlineTaskId])
  // 执行没发生也不谎报：这个任务没有 Run。
  expect(await taskRuns(shared.offlineTaskId)).toHaveLength(0)
})

test('失败后从原任务继续：配对真 Node 后在这个任务手动发起，不重开任务', async () => {
  test.setTimeout(300_000) // 承载真 Node 冷启动与设备上线。
  const alice = shared.alice!
  // 前一支用例留下的是**失败那一次创建的任务**（serial 模式按序流转；缺失即判据断了）。
  const offlineTaskId = shared.offlineTaskId
  if (offlineTaskId === undefined) throw new Error('前一支用例没有留下离线分支的任务 id')
  const codeRes = await hubApi(shared.cookie!, 'POST', '/devices/pairing-codes', {})
  expect(codeRes.status).toBe(201)
  const code = (codeRes.data as { code: string }).code
  await startNode({ pairingCode: code })
  await waitDeviceOnline()

  // 回到**原任务**（不是新建一个）：URL 里还是失败那一次创建的任务。
  await alice.goto(`/tasks/${offlineTaskId}`)
  const agentTrigger = alice.getByLabel('选择 Agent')
  await expect(agentTrigger).toBeVisible({ timeout: 30_000 })
  await assertNotNativeSelect(agentTrigger, alice.locator('.run-launcher'), '选择 Agent')
  await selectFromMenu(agentTrigger, AGENT_NAME)
  await selectFromMenu(alice.getByLabel('选择设备'), /e2e-node（在线）/)
  await selectFromMenu(alice.getByLabel('选择 Workspace'), 'e2e-ws')
  await alice.getByLabel('指令').fill('接着把发布说明写完')
  await alice.getByRole('button', { name: '开始执行' }).click()

  await expect(alice.locator('[data-testid="run-segment"]').first()).toBeVisible({
    timeout: 30_000,
  })
  expect((await waitForTaskRuns(offlineTaskId, 1)).length).toBeGreaterThan(0)
  // 恢复入口落在既有任务上：项目任务数仍是 1（没有悄悄重开一个）。
  expect(await projectTasks()).toHaveLength(1)
})

test('设备在线：toast 说已自动开始执行，且 Run 真的起来了', async () => {
  test.setTimeout(240_000)
  const alice = shared.alice!
  await createAgentTaskViaUi('在线分支：复核发布说明')

  await expect(alice.locator('.toast-item').first()).toContainText(
    '任务已创建，Agent 已自动开始执行',
    { timeout: 15_000 },
  )
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 15_000 })
  const taskId = taskIdFromUrl(alice)
  expect(taskId).not.toBe(shared.offlineTaskId)

  // 执行真的发生（不只是说了句话）：Task Room 聚合里能看到 Run，页面也画出行。
  expect((await waitForTaskRuns(taskId, 1)).length).toBeGreaterThan(0)
  await expect(alice.locator('[data-testid="run-segment"]').first()).toBeVisible({
    timeout: 30_000,
  })
  // 在线分支不改数目：两个任务（离线分支那个 + 这个）。
  expect(await projectTasks()).toHaveLength(2)
  // #352（设备视图随 pack 安装刷新）在这里判不了，两个理由都记着：E2E 的 e2e-pack 是
  // core-empty（scripts/e2e-serve.mts 的种子行注释：空 entries 与 digest 复算一致），
  // preflight 对 core-empty 直接放行、不落盘；而 E2E 的 node harness（scripts/e2e-node.mts）
  // 干脆没装 pluginPackPreflight——即使 pack 非空也不会落盘 ⟹ 设备 digests 恒为空。
  // 该判据在 Q2 的组合根用例（apps/node/tests/integration/cli-hello-refresh.integration.spec.ts，
  // 真 cli 子进程 + 真 preflight 本地命中 + 同一连接刷新 + Node 侧连接数恰为 1）。
})

/**
 * #348：创建被服务端拒绝（候选失效的**竞态残窗**）时，页面给的是中文引导 + 错误码，
 * 不是一句英文分类消息。做法与路径 5a 同式：拦截创建 POST 的**响应**换成 Hub 的真实拒绝体
 * （真实时序里名册重拉未完成时就是这条响应到达页面；e2e 里没法稳定复现那几毫秒）。
 */
test('创建被拒（候选失效）：页面主位是中文引导与错误码，英文分类消息降为排障细节', async () => {
  test.setTimeout(120_000)
  const alice = shared.alice!
  const before = (await projectTasks()).length
  // 只拦 POST（同路径还有 GET 列表；拦宽了会把列表也换掉，判据就说不清了）。
  let interceptedPosts = 0
  await alice.route('**/api/v1/projects/*/tasks', (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    interceptedPosts += 1
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'assignee is not an active team member',
          requestId: 'req-e2e-348',
        },
      }),
    })
  })
  try {
    await alice.goto('/')
    await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await alice.getByRole('button', { name: '创建任务' }).click()
    const form = alice.locator('form[aria-label="创建任务"]')
    await alice.locator('input[id^="task-title-"]').fill('拒绝分支：候选失效的引导')
    await form.getByRole('button', { name: '创建任务' }).click()

    const guidance = alice.getByTestId('error-guidance')
    await expect(guidance).toContainText('请重新选择责任人', { timeout: 15_000 })
    await expect(guidance).toContainText('不会自动换人')
    // 错误码可见；英文原文只出现在「细节（排障用）」这一行里。
    const diagnostics = alice.getByTestId('error-diagnostics')
    await expect(diagnostics).toContainText('VALIDATION_FAILED')
    await expect(diagnostics).toContainText('assignee is not an active team member')
    await expect(diagnostics).toContainText('req-e2e-348')
    // 判据量在**被测面**上：这次创建确实发出、且恰好一次（拦截计数）；项目任务数不变
    // 只作为旁证（POST 已被替换，Hub 没机会建任务——单纯数不变近似空真，评审 P2）。
    expect(interceptedPosts).toBe(1)
    expect(await projectTasks()).toHaveLength(before)
  } finally {
    await alice.unroute('**/api/v1/projects/*/tasks')
  }
})
