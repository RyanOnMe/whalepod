/**
 * #345 创建到恢复的生产验收：五条路径一次走完（Q5，project `p1-345`）。
 *
 * 判的是**用户的五天真实走法**，不是函数：
 *   1. 只创建任务（分给真人）→ 待接受、零 Run、不弹执行 toast；
 *   2. 分给别人 → 对方接受后在**自己的**现场执行（Run owner/设备都归对方）；
 *   3. 自己明确开启「创建后立即执行」→ 自动起 Run，归自己、用自己现场；
 *   4. 创建成功但启动失败（设备离线）→ 进入**原任务**准备环境后继续，不重开任务；
 *   5. 连点 / 超时重试 / 成员状态变化 → 不重复创建、不静默改投。
 *
 * 环境是正式装配：真 Hub（生产入口）+ 真 Node + 真 Runtime（DSH replay，`basic` 夹具
 * 让 Run 干净跑完，不把审批挂在半空）。配对码与成员开通用 HTTP 旁路（配对 UI 的真人
 * 路径由 p1-142 覆盖）；Node 生命周期走 e2e-serve 控制面（只做进程，不做产品动作）。
 *
 * 事实落盘在 `artifacts/evidence/create-recovery/result.json`，由
 * `scripts/verify-create-recovery-evidence.mts` **独立重判**（缺证据/自相矛盾即 FAIL）——
 * 判定不看截图、不读日志尾巴。
 */
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertNotNativeSelect,
  env,
  fillAndEnter,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  setRuntimeFixture,
  sleep,
  startNode,
  stopNode,
  waitForRunStatus,
} from './helpers.js'

const PASSWORD = 'correct horse battery staple'
const RUN_TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-cr-${RUN_TAG}`
const BOB_NAME = `bob-cr-${RUN_TAG}`
const CAROL_NAME = `carol-cr-${RUN_TAG}`
const AGENT_NAME = 'report-writer'
const EVIDENCE_DIR = join(process.cwd(), 'artifacts', 'evidence', 'create-recovery')

interface TaskFact {
  id: string
  title: string
  assigneeUserId: string
  assigneeAgentId: string | null
  assignmentStatus: string
}

const shared: {
  aliceContext?: BrowserContext
  bobContext?: BrowserContext
  alice?: Page
  bob?: Page
  aliceCookie?: string
  bobCookie?: string
  aliceUserId?: string
  bobUserId?: string
  carolUserId?: string
  projectId?: string
  aliceDeviceId?: string
  bobDeviceId?: string
  taskIds: { createOnly?: string; failedDrive?: string; selfAgent?: string; retry?: string }
} = { taskIds: {} }

/**
 * 判定事实（写进证据包、由独立判定器重判）。只放**可复核的离散事实**，
 * 不放自由文本——判定器不猜意思。
 */
const facts = {
  component: 'web.create-recovery',
  source: 'production-http-ws-node-runtime',
  paths: {} as Record<string, Record<string, unknown>>,
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  await rm(join(EVIDENCE_DIR, 'result.json'), { force: true })
  shared.aliceContext = await browser.newContext()
  shared.bobContext = await browser.newContext()
})

test.afterAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await writeFile(
    join(EVIDENCE_DIR, 'result.json'),
    JSON.stringify({ verifiedAt: new Date().toISOString(), ...facts }, null, 2),
  )
  await shared.aliceContext?.close()
  await shared.bobContext?.close()
})

// ---------- 驱动与观测的小工具 ----------

async function bootstrap(): Promise<void> {
  if (shared.projectId !== undefined) return
  const alice = await shared.aliceContext!.newPage()
  shared.alice = alice
  await alice.goto('/setup')
  await alice.fill('#setup-token', env().setupToken)
  await alice.fill('#team-name', `P1-345 创建到恢复 ${RUN_TAG}`)
  await alice.fill('#setup-username', ALICE_NAME)
  await alice.fill('#setup-display-name', 'Alice')
  await fillAndEnter(alice, '#setup-password', PASSWORD)
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await alice.getByRole('button', { name: '新建项目' }).click()
  await fillAndEnter(alice, '#project-name', '创建到恢复项目')

  shared.aliceCookie = await sessionCookie(shared.aliceContext!)
  const me = await hubApi(shared.aliceCookie, 'GET', '/auth/session')
  shared.aliceUserId = (me.data as { userId: string }).userId
  const projects = await hubApi(shared.aliceCookie, 'GET', '/projects')
  shared.projectId = (projects.data as Array<{ id: string }>)[0]!.id

  // 两个成员都经 HTTP 开通（邀请 UI 的真人路径由 p1-141 覆盖）。
  shared.bobUserId = await invite(shared.aliceCookie, BOB_NAME, 'Bob')
  shared.carolUserId = await invite(shared.aliceCookie, CAROL_NAME, 'Carol')

  await seedPluginPack(shared.aliceUserId)
  await createAgentViaUi(alice, AGENT_NAME)
}

async function invite(cookie: string, username: string, displayName: string): Promise<string> {
  const invite = await hubApi(cookie, 'POST', '/invites', { role: 'member' })
  expect(invite.status).toBe(201)
  const token = (invite.data as { token: string }).token
  const accepted = await fetch(`${env().hubOrigin}/api/v1/invites/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env().webOrigin,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ token, username, displayName, password: PASSWORD }),
  })
  expect(accepted.status).toBe(201)
  return ((await accepted.json()) as { data: { userId: string } }).data.userId
}

async function createAgentViaUi(page: Page, name: string): Promise<void> {
  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
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

async function loginAsBob(): Promise<Page> {
  const bob = await shared.bobContext!.newPage()
  shared.bob = bob
  await bob.goto('/login')
  await bob.fill('#login-username', BOB_NAME)
  await fillAndEnter(bob, '#login-password', PASSWORD)
  await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  shared.bobCookie = await sessionCookie(shared.bobContext!)
  return bob
}

async function projectTasks(): Promise<TaskFact[]> {
  const res = await hubApi(shared.aliceCookie!, 'GET', `/projects/${shared.projectId}/tasks`)
  return res.data as TaskFact[]
}

async function runIdsOfTask(taskId: string): Promise<string[]> {
  const res = await hubApi(shared.aliceCookie!, 'GET', `/tasks/${taskId}`)
  const room = res.data as { runs?: Array<{ id: string }> } | undefined
  return (room?.runs ?? []).map((run) => run.id)
}

/** 等这个任务的第一个 Run 出现（四处调用点都从「零 Run」出发，判定事实，不驱动动作）。 */
async function waitForNewRun(taskId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ids = await runIdsOfTask(taskId)
    if (ids.length > 0) return ids[0]!
    if (Date.now() > deadline) throw new Error(`任务 ${taskId} 没等来 Run`)
    await sleep(500)
  }
}

/** Run 的 owner 与现场（`GET /runs/:id` 的 owner 视角字段）。 */
async function runOwnerAndTarget(
  cookie: string,
  runId: string,
): Promise<{ ownerUserId: string; deviceId: string; workspaceId: string }> {
  const res = await hubApi(cookie, 'GET', `/runs/${runId}`)
  return res.data as { ownerUserId: string; deviceId: string; workspaceId: string }
}

/** 该成员自己的工作目录（`GET /workspaces` 按 owner 收窄）。 */
async function workspaceIdsOf(cookie: string): Promise<string[]> {
  const res = await hubApi(cookie, 'GET', '/workspaces')
  return (res.data as Array<{ workspaceId: string }>).map((w) => w.workspaceId)
}

async function deviceIdsOf(cookie: string): Promise<string[]> {
  const res = await hubApi(cookie, 'GET', '/devices')
  return (res.data as Array<{ id: string }>).map((d) => d.id)
}

/**
 * 拦截本页发往创建任务端点的 POST：计数、取幂等键与请求体，并**让请求真的到 Hub**
 * （`route.fetch()`）后把响应交回页面，同时记下响应状态与响应体（drive 这类兄弟字段
 * 只有在响应里才看得到——判定用真实 wire 事实，不用测试自己写的字面量）。
 *
 * `dropFirst`：第一次请求**已经到 Hub 并落库**，但响应被换成 504（网关超时）——
 * 这才是「超时重试」的真实形态：客户端看到失败，服务端其实收到了。
 */
async function watchTaskPosts(
  page: Page,
  options: { dropFirst?: boolean } = {},
): Promise<{
  count: () => number
  keys: string[]
  bodies: unknown[]
  statuses: number[]
  responses: unknown[]
}> {
  const keys: string[] = []
  const bodies: unknown[] = []
  const statuses: number[] = []
  const responses: unknown[] = []
  let posts = 0
  await page.route('**/api/v1/projects/*/tasks', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posts += 1
    keys.push(route.request().headers()['idempotency-key'] ?? '')
    bodies.push(JSON.parse(route.request().postData() ?? '{}'))
    const response = await route.fetch()
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    statuses.push(response.status())
    responses.push(body)
    if (options.dropFirst === true && posts === 1) {
      // 请求已落库；只是这一次的响应没回到客户端（超时/断链）。
      return route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'gateway timeout', requestId: 'e2e-timeout' },
        }),
      })
    }
    return route.fulfill({ response })
  })
  return { count: () => posts, keys, bodies, statuses, responses }
}

/** 真人路径：开表单 → 填标题/描述。 */
async function openCreateForm(page: Page, title: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '创建任务' }).click()
  await page.locator('input[id^="task-title-"]').fill(title)
  await page.locator('textarea[id^="task-desc-"]').fill('以标题与描述作为指令执行')
}

/** 开启「创建后立即执行」并选 Agent（#344 的执行面）。 */
async function enableExecution(page: Page): Promise<void> {
  const form = page.locator('form[aria-label="创建任务"]')
  await form.getByRole('switch', { name: '创建后立即执行' }).click()
  await selectFromMenu(
    form.locator('button[id^="task-execution-agent-"]'),
    `${AGENT_NAME}（Agent）`,
  )
}

async function submitForm(page: Page, label: '创建任务' | '创建并开始执行'): Promise<void> {
  await page.locator('form[aria-label="创建任务"]').getByRole('button', { name: label }).click()
}

function taskIdFromUrl(page: Page): string {
  const matched = /\/tasks\/([0-9a-f-]{36})/.exec(page.url())
  if (matched === null) throw new Error(`URL 里没有任务 id：${page.url()}`)
  return matched[1]!
}

/** 给某个用户配一台自己的 Node（同一时刻环境里只有一台——控制面只带一个 node 子进程）。 */
async function pairNodeFor(cookie: string, stopExisting: boolean): Promise<string> {
  if (stopExisting) await stopNode('SIGKILL')
  const codeRes = await hubApi(cookie, 'POST', '/devices/pairing-codes', {})
  expect(codeRes.status).toBe(201)
  const code = (codeRes.data as { code: string }).code
  const node = await startNode({ pairingCode: code })
  // `basic` 夹具：Run 直接跑完（不挂审批），证据里留下干净的终态。夹具是 Node 侧给
  // Runtime 的会话文件，必须在 Node 活着时设置（每换一台 Node 都要重设）。
  await setRuntimeFixture('basic')
  const deadline = Date.now() + 120_000
  for (;;) {
    const ids = await deviceIdsOf(cookie)
    const res = await hubApi(cookie, 'GET', '/devices')
    const online = (res.data as Array<{ id: string; status: string }>).find(
      (d) => d.id === node.deviceId && d.status === 'online',
    )
    if (ids.includes(node.deviceId) && online !== undefined) return node.deviceId
    if (Date.now() > deadline) throw new Error('设备未回在线')
    await sleep(500)
  }
}

// ---------- 五条路径 ----------

test('路径 1：只创建任务不产生执行；连点不重复创建', async () => {
  test.setTimeout(240_000)
  await bootstrap()
  const alice = shared.alice!
  const watch = await watchTaskPosts(alice)

  await openCreateForm(alice, '路径一：只创建，不执行')
  await selectFromMenu(alice.locator('button[id^="task-assignee-"]'), /Bob/)
  await submitForm(alice, '创建任务')
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/)
  shared.taskIds.createOnly = taskIdFromUrl(alice)

  const tasks = await projectTasks()
  const created = tasks.find((t) => t.id === shared.taskIds.createOnly)!
  const runs = await runIdsOfTask(created.id)
  // 没有执行就不许有执行 toast（只有创建这件事发生过）——数是量的，不是写死的。
  const toastCountAfterCreate = await alice.locator('.toast-item').count()
  expect(toastCountAfterCreate).toBe(0)
  expect(runs).toHaveLength(0)
  expect(created.assignmentStatus).toBe('pending')
  expect(created.assigneeUserId).toBe(shared.bobUserId)
  expect(created.assigneeAgentId).toBeNull()

  // 连点：第一次点击后按钮已禁用，第二次点不出去——一个任务一个 POST。
  await openCreateForm(alice, '路径一·连点：不该建出第二个')
  const postsBefore = watch.count()
  await alice.locator('form[aria-label="创建任务"] button[type="submit"]').dblclick()
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await sleep(700)
  expect(watch.count() - postsBefore).toBe(1)
  const afterDoubleClick = await projectTasks()
  expect(afterDoubleClick.length).toBe(tasks.length + 1)

  facts.paths['createOnly'] = {
    taskId: created.id,
    assigneeUserId: created.assigneeUserId,
    assignmentStatus: created.assignmentStatus,
    runs: runs.length,
    executionToastCount: toastCountAfterCreate,
    doubleClickPosts: watch.count() - postsBefore,
    tasksAfterDoubleClick: afterDoubleClick.length,
  }
  await alice.unroute('**/api/v1/projects/*/tasks')
})

test('路径 5a：超时重试沿用同一把幂等键——不重复创建', async () => {
  test.setTimeout(180_000)
  const alice = shared.alice!
  await loginAsBob() // Bob 上台前先把账号登一遍，稍后直接用
  const watch = await watchTaskPosts(alice, { dropFirst: true })
  const before = (await projectTasks()).length

  await openCreateForm(alice, '路径五：超时重试一次')
  await submitForm(alice, '创建任务')
  // 第一次：请求到了 Hub（任务已落库），但响应是 504 → 失败如实上屏。
  await expect(alice.locator('.error-banner')).toBeVisible({ timeout: 20_000 })
  await submitForm(alice, '创建任务')
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 20_000 })
  shared.taskIds.retry = taskIdFromUrl(alice)

  const after = await projectTasks()
  const firstCreatedId = (watch.responses[0] as { data?: { id?: string } } | null)?.data?.id
  const secondCreatedId = (watch.responses[1] as { data?: { id?: string } } | null)?.data?.id
  expect(watch.count()).toBe(2)
  expect(watch.keys[0]).toBe(watch.keys[1])
  expect(watch.keys[0]).not.toBe('')
  // 关键牙齿：第二次是 Hub 对 `task.create:<key>` 的**回放**——同一个任务，不是新任务。
  expect(firstCreatedId).toBe(secondCreatedId)
  expect(firstCreatedId).toBe(shared.taskIds.retry)
  expect(after.length).toBe(before + 1)

  facts.paths['retryIdempotent'] = {
    attempts: watch.count(),
    sameKey: watch.keys[0] === watch.keys[1],
    firstAttemptReachedHub: watch.statuses[0] === 201,
    replayedSameTask: firstCreatedId === secondCreatedId,
    replayedTaskId: secondCreatedId ?? null,
    tasksCreated: after.length - before,
    taskId: shared.taskIds.retry,
  }
  await alice.unroute('**/api/v1/projects/*/tasks')
})

test('路径 5b：成员状态变化不静默改投——提交前显式阻塞，重选后才创建', async () => {
  test.setTimeout(180_000)
  const alice = shared.alice!
  const watch = await watchTaskPosts(alice)
  const before = (await projectTasks()).length

  await openCreateForm(alice, '路径五：责任人被停用')
  await selectFromMenu(alice.locator('button[id^="task-assignee-"]'), /Carol/)
  // 表单开着时把 Carol 停用（真实状态变化；不是测试塞的假条件）。
  const disabled = await hubApi(
    shared.aliceCookie!,
    'POST',
    `/team/members/${shared.carolUserId}/disable`,
    {},
  )
  expect(disabled.status).toBe(200)

  // 名册经 `member.changed` 重拉后：提交被显式阻塞并说明原因，一个请求都不发出去
  // ——既没有「带着不可用的责任人」出门，也没有悄悄换成别人。
  const hint = alice.getByTestId('selection-unavailable-hint')
  await expect(hint).toBeVisible({ timeout: 20_000 })
  await expect(hint).toContainText('请重新选择')
  // 「被阻塞」也是量出来的（提示可见 + 按钮禁用），不是产出侧写 true。
  const submitWhileStale = alice
    .locator('form[aria-label="创建任务"]')
    .getByRole('button', { name: '创建任务' })
  const blockedWhileStale = (await hint.isVisible()) && (await submitWhileStale.isDisabled())
  const postsWhileStale = watch.count()
  await alice
    .locator('form[aria-label="创建任务"]')
    .getByRole('button', { name: '创建任务' })
    .click({ force: true })
    .catch(() => undefined) // 按钮已禁用，点击不一定落地；判据是「没有请求」
  await sleep(500)
  // 失效期间的事实**在失效期间取**（独立判定器两次抓到同一类自报错误：
  // 读晚了就会被恢复后的请求盖掉）。
  const requestsWhileStale = watch.count() - postsWhileStale
  const tasksWhileStale = (await projectTasks()).length
  expect(requestsWhileStale).toBe(0)
  expect(tasksWhileStale).toBe(before)

  // 重选一个可用责任人 → 正常创建（恢复路径存在）。
  await selectFromMenu(alice.locator('button[id^="task-assignee-"]'), /Alice/)
  await expect(hint).toBeHidden()
  await submitForm(alice, '创建任务')
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 20_000 })
  const createdTaskId = taskIdFromUrl(alice)
  const after = await projectTasks()

  facts.paths['stateChangeNoReroute'] = {
    blockedWhileStale,
    requestsWhileStale,
    recoveredWithAssigneeUserId: after.find((t) => t.id === createdTaskId)!.assigneeUserId,
    recoveredAssigneeUserId: shared.aliceUserId,
    tasksCreatedWhileStale: tasksWhileStale - before,
  }
  await alice.unroute('**/api/v1/projects/*/tasks')
})

test('路径 4 前半：创建成功但启动失败（设备离线）——任务在、执行不在', async () => {
  test.setTimeout(180_000)
  const alice = shared.alice!
  const watch = await watchTaskPosts(alice)
  const before = (await projectTasks()).length
  await openCreateForm(alice, '路径四：起不来，去准备环境')
  await enableExecution(alice)
  await submitForm(alice, '创建并开始执行')
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/)
  shared.taskIds.failedDrive = taskIdFromUrl(alice)

  const toast = alice.locator('.toast-item').first()
  await expect(toast).toContainText('自动执行未开始（DEVICE_OFFLINE）', { timeout: 15_000 })
  await expect(toast).toContainText('可在任务执行区手动发起')
  const after = await projectTasks()
  const runs = await runIdsOfTask(shared.taskIds.failedDrive)
  // 错误码取自响应里的兄弟字段（真实 wire），不是测试自己写的字面量。
  const drive = (
    watch.responses.at(-1) as { drive?: { outcome?: string; error?: { code?: string } } } | null
  )?.drive

  facts.paths['failedThenRecover'] = {
    taskId: shared.taskIds.failedDrive,
    driveCode: drive?.error?.code ?? null,
    driveOutcome: drive?.outcome ?? null,
    runsAfterFailure: runs.length,
    tasksCreated: after.length - before,
    recoveredInSameTask: null,
    tasksAfterRecovery: null,
  }
  await alice.unroute('**/api/v1/projects/*/tasks')
})

test('路径 4 后半：进入原任务准备环境后继续——同一任务发起，不重开任务', async () => {
  test.setTimeout(300_000)
  const alice = shared.alice!
  shared.aliceDeviceId = await pairNodeFor(shared.aliceCookie!, false)
  const taskId = shared.taskIds.failedDrive!
  const before = (await projectTasks()).length

  await alice.goto(`/tasks/${taskId}`)
  const agentTrigger = alice.getByLabel('选择 Agent')
  await expect(agentTrigger).toBeVisible({ timeout: 30_000 })
  await selectFromMenu(agentTrigger, AGENT_NAME)
  await selectFromMenu(alice.getByLabel('选择设备'), /e2e-node（在线）/)
  await selectFromMenu(alice.getByLabel('选择 Workspace'), 'e2e-ws')
  await alice.getByLabel('指令').fill('环境准备好了，接着做')
  await alice.getByRole('button', { name: '开始执行' }).click()

  const runId = await waitForNewRun(taskId)
  const owner = await runOwnerAndTarget(shared.aliceCookie!, runId)
  const after = await projectTasks()
  // 让这一跑干净收尾（basic 夹具：无工具、无需审批），后面换设备时不留半空 Run。
  await waitForRunStatus(runId, 'completed')

  expect(owner.ownerUserId).toBe(shared.aliceUserId)
  expect(owner.deviceId).toBe(shared.aliceDeviceId)
  expect(after.length).toBe(before) // 关键：恢复落在原任务上，没有新任务
  expect(after.some((t) => t.id === taskId)).toBe(true)

  const path = facts.paths['failedThenRecover']!
  // 推导，不是断言过就等于真：任务数没变，且原任务还在列表里。
  path['recoveredInSameTask'] = after.length === before && after.some((t) => t.id === taskId)
  path['recoveredRunId'] = runId
  path['recoveredRunOwnerUserId'] = owner.ownerUserId
  path['recoveredRunDeviceId'] = owner.deviceId
  path['expectedRunOwnerUserId'] = shared.aliceUserId
  path['expectedRunDeviceId'] = shared.aliceDeviceId
  path['tasksAfterRecovery'] = after.length
})

test('路径 3：自己明确选择 Agent → 创建并执行（归自己、用自己现场）', async () => {
  test.setTimeout(240_000)
  const alice = shared.alice!
  const watch = await watchTaskPosts(alice)
  const before = (await projectTasks()).length
  await openCreateForm(alice, '路径三：创建并开始执行')
  await enableExecution(alice)
  await submitForm(alice, '创建并开始执行')
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/)
  shared.taskIds.selfAgent = taskIdFromUrl(alice)

  await expect(alice.locator('.toast-item').first()).toContainText(
    '任务已创建，Agent 已自动开始执行',
    { timeout: 15_000 },
  )
  const runId = await waitForNewRun(shared.taskIds.selfAgent)
  const owner = await runOwnerAndTarget(shared.aliceCookie!, runId)
  await waitForRunStatus(runId, 'completed')
  const after = await projectTasks()
  const created = after.find((t) => t.id === shared.taskIds.selfAgent)!

  expect(owner.ownerUserId).toBe(shared.aliceUserId)
  expect(created.assigneeAgentId).not.toBeNull()
  expect(created.assignmentStatus).toBe('accepted')

  const wireDrive = (watch.responses.at(-1) as { drive?: { outcome?: string } } | null)?.drive
  facts.paths['selfAgentExecute'] = {
    taskId: shared.taskIds.selfAgent,
    driveOutcome: wireDrive?.outcome ?? null,
    runId,
    runOwnerUserId: owner.ownerUserId,
    expectedRunOwnerUserId: shared.aliceUserId,
    runDeviceId: owner.deviceId,
    expectedRunDeviceId: shared.aliceDeviceId,
    taskAssignmentStatus: created.assignmentStatus,
    tasksCreated: after.length - before,
  }
  await alice.unroute('**/api/v1/projects/*/tasks')
})

test('路径 2：分给别人，对方接受后再执行——用对方的现场', async () => {
  test.setTimeout(300_000)
  const alice = shared.alice!
  const taskId = shared.taskIds.createOnly!
  const before = (await projectTasks()).length

  // 环境里只有一台 Node（控制面只带一个 node 子进程）：换成 Bob 的设备。
  shared.bobDeviceId = await pairNodeFor(shared.bobCookie!, true)
  const bob = shared.bob!
  await bob.reload()
  await bob.goto(`/tasks/${taskId}`)
  await bob.getByRole('button', { name: '接受任务' }).click()
  await expect(bob.getByText('你已接受此任务。')).toBeVisible()

  const agentTrigger = bob.getByLabel('选择 Agent')
  await expect(agentTrigger).toBeVisible({ timeout: 30_000 })
  await selectFromMenu(agentTrigger, AGENT_NAME)
  await selectFromMenu(bob.getByLabel('选择设备'), /e2e-node（在线）/)
  await selectFromMenu(bob.getByLabel('选择 Workspace'), 'e2e-ws')
  await bob.getByLabel('指令').fill('我来接着做这一段')
  await bob.getByRole('button', { name: '开始执行' }).click()

  const runId = await waitForNewRun(taskId)
  const owner = await runOwnerAndTarget(shared.bobCookie!, runId)
  const bobDevices = await deviceIdsOf(shared.bobCookie!)
  const aliceDevices = await deviceIdsOf(shared.aliceCookie!)
  const bobWorkspaces = await workspaceIdsOf(shared.bobCookie!)
  const aliceWorkspaces = await workspaceIdsOf(shared.aliceCookie!)
  const after = await projectTasks()
  const accepted = after.find((t) => t.id === taskId)!

  expect(owner.ownerUserId).toBe(shared.bobUserId)
  expect(bobDevices).toContain(owner.deviceId)
  expect(aliceDevices).not.toContain(owner.deviceId)
  // 工作目录也归对方（设备与工作目录是两件事，别只验一个）。
  expect(bobWorkspaces).toContain(owner.workspaceId)
  expect(aliceWorkspaces).not.toContain(owner.workspaceId)
  expect(accepted.assignmentStatus).toBe('accepted')
  expect(after.length).toBe(before)

  facts.paths['assignToOther'] = {
    taskId,
    acceptedByUserId: accepted.assigneeUserId,
    expectedAssigneeUserId: shared.bobUserId,
    assignmentStatus: accepted.assignmentStatus,
    runId,
    runOwnerUserId: owner.ownerUserId,
    expectedRunOwnerUserId: shared.bobUserId,
    runDeviceId: owner.deviceId,
    deviceBelongsToOwner: bobDevices.includes(owner.deviceId),
    otherUserHasDevice: aliceDevices.includes(owner.deviceId),
    workspaceBelongsToOwner: bobWorkspaces.includes(owner.workspaceId),
    otherUserHasWorkspace: aliceWorkspaces.includes(owner.workspaceId),
    tasksCreated: after.length - before,
  }
})
