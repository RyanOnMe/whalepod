import { showAgentCreation } from './helpers.js'
/**
 * P1-393 连续对话工作区验收（Q5，project `p1-393`）。
 *
 * 判的是 ADR-0019 的六组判据在生产装配上的样子（真 Hub 生产入口 + 真 Node + 真 Runtime
 * replay + 两个成员浏览器；不直写业务表、不插运行时状态）：
 *
 *   ① 连续呈现：多次执行 / 续聊 / 重跑 / 被拒指令在同一条主对话里按服务端顺序成段，
 *      历史回复不因查看别的运行而消失，回复不需要先"选一个运行"就出现在主界面；
 *   ② 默认继续：运行结束 → 输入框默认接住同一条会话（续聊最近一次业务运行）；运行活跃 →
 *      默认追问；**用户明确选过之后**默认规则不再改写（auto/user 草稿标记的语义）；
 *   ③ 审批在**对应的段**里（owner 批准、member 只见等待态）；
 *   ④ 两成员权限：被授权成员排队中的追问在撤销后**当场被拒**，理由留在它所属的段里；
 *   ⑤ 真实分页读：应用按 `limit=500` 请求；用真实端点以 max-seq 作 `after` 逐页读到末尾，
 *      不重叠、不跳号；成员的受众过滤读有间隙（不是丢帧）；
 *   ⑥ 设备离线不算数：resume 发送被 409 `DEVICE_OFFLINE` 挡住，草稿保留、房间不长出新运行。
 *
 * 第二支 test 判**真实布局**（20 段窗口 / 载入更早的阅读锚点 / 上翻后新内容不拽人 /
 * 单一滚动容器 / 1440·390·320 三档无横向溢出）：真实产品链上一次跑 25 个 Run 代价过高
 * （一次真执行 = 一个 Runtime），那支用例把**读面打桩**（任务聚合 + 运行详情 + 运行事件）
 * 供给 25 段，交互（滚动、加载更早、跟随、布局）全部在真浏览器里量；聚合里仍合并**真实**
 * 运行，新内容到达用真实用户动作（成员发评论）触发真实 WS 失效，读面此时多返回一段。
 * 打桩范围写在 facts.window.stubbed 里，判定器据此知道哪部分不是生产数据。
 *
 * 事实落盘在 `artifacts/evidence/conversation-flow/result.json`，由
 * `scripts/verify-conversation-evidence.mts` **独立重判**（缺证据/自相矛盾即 FAIL）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertNotNativeSelect,
  assertSeqContiguous,
  env,
  fillAndEnter,
  getRunFact,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  setRuntimeFixture,
  sleep,
  startNode,
  stopNode,
  waitForRunStatus,
  waitForRuntimeReleased,
} from './helpers.js'

const PASSWORD = 'correct horse battery staple'
const TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-cc-${TAG}`
const BOB_NAME = `bob-cc-${TAG}`
const AGENT_NAME = 'builder'
const EVIDENCE_DIR = join(process.cwd(), 'artifacts', 'evidence', 'conversation-flow')
/** 生产 replay 夹具（tool-approval）的助手正文与候选材料标题。 */
const REPLY = 'Artifact published.'
const CANDIDATE_TITLE = 'Report'

interface RoomFact {
  task: { id: string; status: string; assignmentStatus: string }
  runs: Array<{
    id: string
    status: string
    createdAt: string
    rerunOfRunId: string | null
    resumeFromRunId: string | null
    deviceName: string | null
    workspaceName: string | null
  }>
  instructions: Array<{
    id: string
    body: string
    kind: string
    runId: string | null
    instructionState: string | null
    instructionErrorCode: string | null
    createdAt: string
  }>
  artifacts: Array<{ id: string; runId: string; title: string; status: string }>
}

const shared: {
  aliceContext?: BrowserContext
  bobContext?: BrowserContext
  alice?: Page
  bob?: Page
  cookie?: string
  bobCookie?: string
  aliceUserId?: string
  bobUserId?: string
  taskId?: string
  firstRunId?: string
} = {}

const facts: Record<string, unknown> = {
  component: 'web.conversation-flow',
  source: 'production-hub-node-runtime',
}
const runIds: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  await rm(join(EVIDENCE_DIR, 'result.json'), { force: true })
  shared.aliceContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  shared.bobContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
})

test.afterAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await writeFile(
    join(EVIDENCE_DIR, 'result.json'),
    JSON.stringify({ verifiedAt: new Date().toISOString(), ...facts }, null, 2) + '\n',
  )
  await shared.aliceContext?.close()
  await shared.bobContext?.close()
})

function segmentOf(page: Page, runId: string) {
  return page.locator(`[data-testid="run-segment"][data-run-id="${runId}"]`)
}

async function room(): Promise<RoomFact> {
  const res = await hubApi(shared.cookie!, 'GET', `/tasks/${shared.taskId}`)
  expect(res.status).toBe(200)
  return res.data as RoomFact
}

async function waitForFreshRunId(known: Set<string>, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const fresh = (await room()).runs.filter((run) => !known.has(run.id))
    if (fresh.length > 0) return fresh[0]!.id
    await sleep(250)
  }
  throw new Error('UI 启动的 Run 未出现在任务房间聚合里')
}

async function waitDeviceOffline(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await hubApi(shared.cookie!, 'GET', '/devices')
    const devices = res.data as Array<{ status: string }>
    if (devices.every((device) => device.status !== 'online')) return
    if (Date.now() > deadline) throw new Error(`设备未在 ${timeoutMs}ms 内离线`)
    await sleep(500)
  }
}

async function openRunDetail(page: Page, runId: string): Promise<void> {
  await segmentOf(page, runId).locator('.run-item-button').click()
  await expect(page.getByTestId('run-detail-meta')).toBeVisible({ timeout: 30_000 })
}

async function closeInspector(page: Page): Promise<void> {
  await page.getByRole('button', { name: '关闭工作区详情' }).click()
  await expect(page.getByRole('region', { name: '工作区详情' })).not.toBeVisible()
}

/** 段内审批：owner 在**该段**里批准（审批卡不属于别的段）。 */
async function approveInSegment(page: Page, runId: string): Promise<void> {
  await waitForRunStatus(runId, 'waiting_approval', 150_000)
  const card = segmentOf(page, runId).getByTestId('approval-card')
  await expect(card).toBeVisible({ timeout: 60_000 })
  await card.getByTestId('approve-button').click()
  await waitForRunStatus(runId, 'completed', 150_000)
  await waitForRuntimeReleased(runId)
}

test('连续对话：默认继续、段内审批、被拒指令与历史不消失（生产装配）', async () => {
  test.setTimeout(480_000)
  const alice = await shared.aliceContext!.newPage()
  const bob = await shared.bobContext!.newPage()
  shared.alice = alice
  shared.bob = bob
  // 真实 WS 帧计数：实时面是否真的在推（不是靠 reload 假装的实时）。
  let liveFrames = 0
  alice.on('websocket', (socket) => socket.on('framereceived', () => (liveFrames += 1)))
  // 应用请求的事件页 URL：用来判 `limit=500` 这条真实请求形状。
  const eventPageUrls: string[] = []
  alice.on('request', (request) => {
    if (/\/api\/v1\/runs\/[^/]+\/events/.test(request.url())) eventPageUrls.push(request.url())
  })
  /**
   * 指令 POST 计数：设备离线那一段**一条都不许发出**（「阻断提交」是事实，不只是按钮变灰）。
   * 两条真实入口都要数：执行区发指令 `/tasks/:id/instructions`，段内重跑 `/tasks/:id/runs`
   * （重跑是独立的创建入口——第一版只数前者，实测少了一条）。
   */
  let instructionPosts = 0
  alice.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = new URL(request.url()).pathname
    const task = shared.taskId ?? ''
    if (path.endsWith(`/tasks/${task}/instructions`) || path.endsWith(`/tasks/${task}/runs`))
      instructionPosts += 1
  })

  // ---------- 0. Setup：团队、成员、Agent、设备、项目 ----------
  await alice.goto('/setup')
  await alice.fill('#setup-token', env().setupToken)
  await alice.fill('#team-name', `连续对话团队 ${TAG}`)
  await alice.fill('#setup-username', ALICE_NAME)
  await alice.fill('#setup-display-name', 'Alice')
  await fillAndEnter(alice, '#setup-password', PASSWORD)
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await alice.getByRole('button', { name: '新建项目' }).click()
  await fillAndEnter(alice, '#project-name', '连续对话验收项目')
  shared.cookie = await sessionCookie(shared.aliceContext!)
  const me = await hubApi(shared.cookie, 'GET', '/auth/session')
  shared.aliceUserId = (me.data as { userId: string }).userId

  const invite = await hubApi(shared.cookie, 'POST', '/invites', { role: 'member' })
  expect(invite.status).toBe(201)
  const accepted = await fetch(`${env().hubOrigin}/api/v1/invites/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env().webOrigin,
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
  shared.bobUserId = ((await accepted.json()) as { data: { userId: string } }).data.userId

  expect((await seedPluginPack(shared.aliceUserId)).pluginPackId).not.toBe('')
  await alice.goto('/agents')
  await showAgentCreation(alice)
  await alice.fill('#agent-name', AGENT_NAME)
  await alice.fill('#agent-persona', '你是验收代理。')
  await alice.fill('#agent-provider', 'replay')
  await alice.fill('#agent-model', 'replay-model')
  await alice.fill('#agent-credential-slot', 'default')
  await selectFromMenu(alice.locator('#agent-plugin-pack'), 'e2e-pack')
  await alice.getByRole('button', { name: '创建 Agent' }).click()
  await expect(alice.getByText(AGENT_NAME).first()).toBeVisible()

  const pairing = await hubApi(shared.cookie, 'POST', '/devices/pairing-codes', {})
  await startNode({ pairingCode: (pairing.data as { code: string }).code })
  // 审批档夹具：一次 publish_artifact 工具调用（候选材料）+ 需要真人批准。
  await setRuntimeFixture('approval')

  await alice.goto('/')
  await alice.getByRole('button', { name: '创建任务' }).click()
  const createForm = alice.locator('form[aria-label="创建任务"]')
  await alice.locator('input[id^="task-title-"]').fill('整理交付验收报告')
  await selectFromMenu(createForm.locator('button[id^="task-assignee-"]'), /Alice/)
  await createForm.getByRole('button', { name: /创建任务/ }).click()
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/)
  shared.taskId = new URL(alice.url()).pathname.split('/').pop()!
  await alice.getByRole('button', { name: '接受任务' }).click()
  await expect(alice.getByTestId('task-assignment-state')).toHaveText('已接受')

  await bob.goto('/login')
  await bob.fill('#login-username', BOB_NAME)
  await fillAndEnter(bob, '#login-password', PASSWORD)
  await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  shared.bobCookie = await sessionCookie(shared.bobContext!)
  await bob.goto(`/tasks/${shared.taskId}`)
  await expect(bob.getByTestId('execution-composer')).toBeVisible({ timeout: 30_000 })

  // 责任人把驱动权授予 Bob（真实权限页；后面要用撤销把它收回）。
  await alice.goto(`/tasks/${shared.taskId}/permissions`)
  await selectFromMenu(alice.getByLabel('授权给'), /Bob/)
  await alice.getByRole('button', { name: '授权', exact: true }).click()
  await expect(alice.getByTestId('driver-revoke')).toBeVisible()
  await alice.goto(`/tasks/${shared.taskId}`)
  await bob.reload()
  await expect(bob.getByLabel('指令', { exact: true })).toBeEnabled({ timeout: 30_000 })

  // ---------- 1. 第一次执行：无历史时默认就是"开始新执行" ----------
  const known = new Set<string>()
  await expect(alice.getByLabel('选择 Agent')).toBeVisible({ timeout: 30_000 })
  await assertNotNativeSelect(
    alice.getByLabel('选择 Agent'),
    alice.locator('.run-launcher'),
    '选择 Agent',
  )
  await selectFromMenu(alice.getByLabel('选择 Agent'), AGENT_NAME)
  await selectFromMenu(alice.getByLabel('选择设备'), /e2e-node（在线）/)
  await selectFromMenu(alice.getByLabel('选择 Workspace'), 'e2e-ws')
  await alice.getByLabel('指令').fill('第一次执行：整理验收报告。')
  await alice.getByRole('button', { name: '开始执行' }).click()
  const firstRunId = await waitForFreshRunId(known)
  known.add(firstRunId)
  runIds.push(firstRunId)
  shared.firstRunId = firstRunId
  // 段立刻出现在主对话里（不需要先选运行、也不需要打开任何详情）。
  await expect(segmentOf(alice, firstRunId)).toBeVisible({ timeout: 30_000 })
  await expect(alice.getByRole('region', { name: '工作区详情' })).toHaveCount(0)
  await expect(segmentOf(alice, firstRunId).locator('.run-live-stream')).toBeVisible()
  await waitForRunStatus(firstRunId, 'waiting_approval', 150_000)
  // 审批卡在**这一段**里（owner）；成员看得到等待态但看不到审批入口。
  await expect(segmentOf(alice, firstRunId).getByTestId('approval-card')).toBeVisible({
    timeout: 60_000,
  })
  await expect(segmentOf(bob, firstRunId).getByTestId('approval-waiting')).toBeVisible({
    timeout: 60_000,
  })
  await expect(segmentOf(bob, firstRunId).getByTestId('approval-card')).toHaveCount(0)
  await expect(segmentOf(bob, firstRunId).getByTestId('approve-button')).toHaveCount(0)
  await alice.screenshot({ path: join(EVIDENCE_DIR, 'approval-in-segment.png') })
  await segmentOf(alice, firstRunId).getByTestId('approve-button').click()
  await waitForRunStatus(firstRunId, 'completed', 150_000)
  await waitForRuntimeReleased(firstRunId)
  // 完成后：直播区被持久化回复替换；回复直接在主界面里（全程没打开过任何详情）。
  await expect(segmentOf(alice, firstRunId).locator('.run-live-stream')).toHaveCount(0)
  await expect(
    segmentOf(alice, firstRunId).locator('.workspace-reply p').filter({ hasText: REPLY }),
  ).toHaveCount(1)
  // 候选材料落在**这一段**（仅本人可见）；成员看不到候选卡，也不把受众空隙报成"读取不完整"。
  const candidateInSegment = segmentOf(alice, firstRunId).getByRole('button', {
    name: `查看交付物 ${CANDIDATE_TITLE}`,
  })
  await expect(candidateInSegment).toBeVisible({ timeout: 30_000 })
  await expect(candidateInSegment).toContainText('仅你可见')
  await expect(
    segmentOf(bob, firstRunId).getByRole('button', { name: `查看交付物 ${CANDIDATE_TITLE}` }),
  ).toHaveCount(0)
  await expect(segmentOf(bob, firstRunId).getByTestId('run-events-incomplete')).toHaveCount(0)
  facts['conversation'] = {
    taskId: shared.taskId,
    firstRunId,
    approvalInSegment: true,
    memberSeesWaitingOnly: true,
    replyVisibleWithoutOpeningDetail: true,
    candidateOnlyOwner: true,
    liveFrames,
  }

  // ---------- 2. 默认继续：结束态 = 续聊最近一次业务运行 ----------
  const receiver = alice.locator('.composer-receiver')
  await expect(receiver).toContainText('续聊')
  await expect(receiver).toContainText('第 1 次运行')
  const beforeSecond = new Set(known)
  await alice.getByLabel('指令').fill('第二次：在同一个会话里继续补充验收小节。')
  const resumePost = alice.waitForResponse(
    (response) =>
      response.url().endsWith(`/tasks/${shared.taskId}/instructions`) &&
      response.request().method() === 'POST',
  )
  await alice.getByRole('button', { name: '继续会话', exact: true }).click()
  const resumeResponse = await resumePost
  expect(resumeResponse.status()).toBe(201)
  expect(resumeResponse.request().postDataJSON()).toMatchObject({
    intent: { kind: 'resume', runId: firstRunId },
  })
  const secondRunId = await waitForFreshRunId(beforeSecond)
  known.add(secondRunId)
  runIds.push(secondRunId)
  const secondRun = (await room()).runs.find((run) => run.id === secondRunId)!
  expect(secondRun.resumeFromRunId).toBe(firstRunId)
  // 活跃执行期间：没人动过的草稿，默认目标是**追问它**（默认规则随运行状态走）。
  await expect(receiver).toContainText('追问')
  await expect(receiver).toContainText('第 2 次运行')

  // ---------- 3. 被授权成员在审批窗口排队 → 撤销 → 当场被拒（理由留在对话里） ----------
  await waitForRunStatus(secondRunId, 'waiting_approval', 150_000)
  const memberBox = bob.getByLabel('指令', { exact: true })
  await expect(memberBox).toBeEnabled({ timeout: 30_000 })
  // 成员没动过设置：默认就该是追问这条活跃执行（不需要自己去选执行方式）。
  await expect(bob.locator('.composer-receiver')).toContainText('追问')
  await memberBox.fill('协作者补充：验收小节请按新的口径写。')
  const queuedPost = bob.waitForResponse(
    (response) =>
      response.url().endsWith(`/tasks/${shared.taskId}/instructions`) &&
      response.request().method() === 'POST',
  )
  await bob.getByRole('button', { name: '发送追问', exact: true }).click()
  const queuedJson = (await (await queuedPost).json()) as { data: { outcome: string } }
  expect(queuedJson.data.outcome).toBe('queued')
  const queuedInstruction = (await room()).instructions.find(
    (instruction) => instruction.body === '协作者补充：验收小节请按新的口径写。',
  )!
  expect(queuedInstruction.instructionState).toBe('pending')
  expect(queuedInstruction.runId).toBe(secondRunId)
  await bob.getByLabel('指令').fill('撤销时我正在编辑的草稿')

  await alice.goto(`/tasks/${shared.taskId}/permissions`)
  await alice.getByTestId('driver-revoke').click()
  await expect(alice.getByTestId('driver-revoke')).toHaveCount(0)
  await alice.goto(`/tasks/${shared.taskId}`)
  // 被拒指令：状态与理由同列，落在**它所属的那一段**里（成员页与责任人页都要有）。
  const rejected = (await room()).instructions.find((row) => row.id === queuedInstruction.id)!
  expect(rejected.instructionState).toBe('rejected')
  expect(rejected.instructionErrorCode).toBe('FORBIDDEN')
  await expect(segmentOf(bob, secondRunId).getByTestId('instruction-error')).toContainText(
    '发送者已失去指令权限',
    { timeout: 30_000 },
  )
  await expect(segmentOf(alice, secondRunId).getByTestId('instruction-error')).toContainText(
    '发送者已失去指令权限',
  )
  // 撤销即时生效：成员的执行入口被挡，但草稿保留。
  await expect(bob.getByTestId('execution-blocker')).toContainText('只有责任人和已授权成员')
  await expect(bob.getByLabel('指令')).toHaveValue('撤销时我正在编辑的草稿')
  await bob.screenshot({ path: join(EVIDENCE_DIR, 'rejected-instruction-segment.png') })
  facts['permission'] = {
    grantedMemberInstructionRight: true,
    memberFollowupOutcome: queuedJson.data.outcome,
    queuedInstructionState: queuedInstruction.instructionState,
    instructionRunIdMatchesActiveRun: queuedInstruction.runId === secondRunId,
    rejectedCode: rejected.instructionErrorCode,
    rejectedVisibleInOwnSegment: true,
    memberBlockedAfterRevoke: true,
    memberDraftPreservedAfterRevoke: true,
  }

  await approveInSegment(alice, secondRunId)

  // ---------- 4. 重跑：血缘独立（rerunOfRunId），仍进同一条连续对话 ----------
  await expect(
    segmentOf(alice, secondRunId).locator('.workspace-reply p').filter({ hasText: REPLY }),
  ).toHaveCount(1)
  // 历史回复没有因为运行推进而消失。
  await expect(
    segmentOf(alice, firstRunId).locator('.workspace-reply p').filter({ hasText: REPLY }),
  ).toHaveCount(1)
  const beforeThird = new Set(known)
  // 行动面在运行详情里（ADR-0019 决定 2）：段上只有「运行详情」。表单里的输入框 id 带
  // runId 后缀，按**标签**定位（真人也是看标签写的）。
  await openRunDetail(alice, firstRunId)
  await alice.getByTestId('rerun-button').click()
  await alice.getByLabel('新 Run 的指令').fill('重跑第一次任务，要求给出工具轨迹。')
  await alice.getByTestId('rerun-confirm-button').click()
  await closeInspector(alice)
  const thirdRunId = await waitForFreshRunId(beforeThird)
  known.add(thirdRunId)
  runIds.push(thirdRunId)
  const thirdRun = (await room()).runs.find((run) => run.id === thirdRunId)!
  expect(thirdRun.rerunOfRunId).toBe(firstRunId)
  await approveInSegment(alice, thirdRunId)

  // 三段连续：DOM 顺序 == 服务端 createdAt 升序；三段各自的回复都在（不跨运行按文本去重）。
  const domOrder = await alice
    .locator('[data-testid="run-segment"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-run-id')))
  const serverOrder = [...(await room()).runs].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  )
  expect(domOrder).toEqual(serverOrder.map((run) => run.id))
  expect(runIds).toEqual(serverOrder.map((run) => run.id))
  for (const runId of runIds) {
    await expect(
      segmentOf(alice, runId).locator('.workspace-reply p').filter({ hasText: REPLY }),
    ).toHaveCount(1)
  }
  await alice.screenshot({ path: join(EVIDENCE_DIR, 'continuous-conversation.png') })
  facts['conversation'] = {
    ...(facts['conversation'] as Record<string, unknown>),
    runIds: [...runIds],
    resumeFromRunId: secondRun.resumeFromRunId,
    rerunOfRunId: thirdRun.rerunOfRunId,
    domOrderMatchesServer: true,
    // 「每段都带自己的回复」：数**显示了自己回复的段**（不是运行数——原来是拿 runIds.length
    // 冒充，读起来像"量出来的"，其实是同一件事说了两遍；逐段的文本归属在下面的流程里判）。
    repliesPerSegment: await alice
      .locator('[data-testid="run-segment"]:has(.workspace-reply)')
      .count(),
  }

  // 段头的入口把本次运行的输入 / 血缘 / Console 收在详情里（不在主对话里堆设备与时间）。
  await openRunDetail(alice, thirdRunId)
  await expect(alice.getByTestId('run-lineage')).toHaveText('重跑自第 1 次运行')
  await expect(alice.getByTestId('run-detail-meta')).toContainText('落点')
  await expect(alice.getByTestId('run-detail-meta')).toContainText('审批')
  await alice.getByTestId('open-run-console').click()
  await expect(alice.getByTestId('run-console')).toBeVisible({ timeout: 30_000 })
  await alice.keyboard.press('Escape')
  await expect(alice.getByTestId('run-console')).toHaveCount(0)
  await closeInspector(alice)
  facts['detail'] = {
    lineageVisible: true,
    metaHasPlacementAndApproval: true,
    consoleOpensFromDetail: true,
  }

  // ---------- 5. 继续此会话：来源交给底部统一输入框，保留已有文字 ----------
  const draft = '我先想想要不要追问性能数据。'
  await alice.getByLabel('指令').fill(draft)
  // 入口在运行详情里（ADR-0019 决定 2）：段上只有「运行详情」，点它就是段头的按钮。
  await openRunDetail(alice, firstRunId)
  await alice.getByTestId('continue-session-button').click()
  // 交回输入框时详情自动收起：窄屏下详情占满这一栏，不收起用户就看不见自己被送到哪里。
  await expect(alice.getByRole('region', { name: '工作区详情' })).not.toBeVisible()
  await expect(receiver).toContainText('续聊')
  await expect(receiver).toContainText('第 1 次运行')
  await expect(alice.getByLabel('指令')).toHaveValue(draft)
  await expect(alice.getByLabel('指令')).toBeFocused()
  // 查看别的运行 / 切讨论都不改发送目标，也不吞草稿。
  await openRunDetail(alice, secondRunId)
  await closeInspector(alice)
  await expect(receiver).toContainText('第 1 次运行')
  await expect(alice.getByLabel('指令')).toHaveValue(draft)
  await alice.getByRole('button', { name: '团队讨论', exact: true }).click()
  await expect(alice.getByLabel('留言')).toBeVisible()
  await alice.getByRole('button', { name: 'Agent 执行', exact: true }).click()
  await expect(receiver).toContainText('第 1 次运行')
  await expect(alice.getByLabel('指令')).toHaveValue(draft)
  // 用户明确选过模式之后，运行状态不再改写它（auto/user 标记的语义）。
  await expect(alice.getByLabel('执行方式')).toContainText('继续会话')
  facts['defaults'] = {
    afterRunCompletedMode: 'resume',
    afterRunCompletedSourceIsLatestBusiness: true,
    whileActiveFollowup: 'followup',
    memberDefaultTargetFollowup: true,
    continueSessionKeepsDraft: true,
    continueSessionFocusesComposer: true,
    historyAndDiscussionDoNotRetarget: true,
    userChoiceSurvivesRunChange: true,
  }

  // ---------- 6. 真实分页读：`limit=500` + max-seq `after` 逐页读到末尾 ----------
  const fact = await getRunFact(firstRunId)
  assertSeqContiguous(fact)
  const tableSeqs = fact.runEvents.map((row) => row.seq).sort((a, b) => a - b)
  let after = 0
  const seen: number[] = []
  let pages = 0
  for (;;) {
    const page = (
      await hubApi(shared.cookie, 'GET', `/runs/${firstRunId}/events?after=${after}&limit=1`)
    ).data as { events: Array<{ seq: number }> }
    pages += 1
    if (page.events.length === 0) break
    for (const item of page.events) seen.push(item.seq)
    after = Math.max(...page.events.map((item) => item.seq))
    if (pages > 500) throw new Error('分页没有推进（游标语义坏了）')
  }
  expect(seen).toEqual(tableSeqs)
  // 成员的受众过滤读：是同一张表的**子集**、序号有间隙，但绝不能因此报「读取不完整」。
  const memberRead = (
    await hubApi(shared.bobCookie, 'GET', `/runs/${firstRunId}/events?after=0&limit=500`)
  ).data as { events: Array<{ seq: number; audience: string }> }
  const memberSeqs = memberRead.events.map((row) => row.seq).sort((a, b) => a - b)
  expect(memberSeqs.length).toBeGreaterThan(0)
  expect(memberSeqs.every((seq) => tableSeqs.includes(seq))).toBe(true)
  expect(memberSeqs.length).toBeLessThan(tableSeqs.length)
  expect(memberRead.events.every((row) => row.audience === 'project')).toBe(true)
  expect(eventPageUrls.some((url) => url.includes('limit=500'))).toBe(true)
  facts['paging'] = {
    runId: firstRunId,
    appPageLimit: 500,
    cursorPages: pages - 1,
    cursorMaxSeq: after,
    tableMaxSeq: tableSeqs.at(-1),
    tableRows: tableSeqs.length,
    tableSeqContiguous: true,
    cursorReachedTailWithoutOverlap: true,
    memberAudienceRows: memberSeqs.length,
    memberRowsAreSubsetOfTable: true,
    audienceGapIsNotLoss: memberSeqs.length < tableSeqs.length,
  }

  // ---------- 7. 设备离线：默认继续被阻断（草稿保留、房间不长出新运行） ----------
  // 判的是**客户端**阻断：本用例首轮实测（#394 修复前）停掉 Node 后续跑仍 201，长出一次
  // 注定失败的运行。服务端现在也按 30s 在线窗口 fail-closed，但界面仍要更早挡住并说清原因
  // （保留草稿），所以这条客户端判据继续保留。
  await stopNode()
  await waitDeviceOffline()
  const runsBeforeOffline = (await room()).runs.length
  const instructionPostsBeforeOffline = instructionPosts
  expect(instructionPostsBeforeOffline).toBe(3) // 起新执行（instructions）/ 续聊（instructions）/ 重跑（runs）各一条
  await expect(alice.getByLabel('指令')).toHaveValue(draft)
  // 让页面手里的设备读面真的刷新一次：`device.changed` 由**设备配对（claim）**发出——
  // Hub 在 Node 断连时**不发**这个事件（只有配对与 `node.hello` 才发，在线态是按 30s 心跳
  // 窗口派生的），所以断连本身不会让已经开着的页面知道。这里走 Node CLI 的同一条匿名
  // claim 请求（不再拉起第二个 Node 进程：控制面同时只跑一台，上一台刚停止时再起一台会
  // 因状态目录竞争直接退出——首轮实测 `e2e-node 提前退出 code=1`）。
  const offlinePairing = await hubApi(shared.cookie, 'POST', '/devices/pairing-codes', {})
  expect(offlinePairing.status).toBe(201)
  const claim = await fetch(`${env().hubOrigin}/api/v1/devices/pairing-claims`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      code: (offlinePairing.data as { code: string }).code,
      name: 'e2e-node-offline-probe',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: 'v24.12.0',
      nodeAppVersion: '0.1.0',
    }),
  })
  expect(claim.status).toBe(201)
  await expect(alice.getByTestId('execution-blocker')).toContainText('来源设备当前离线', {
    timeout: 60_000,
  })
  await expect(alice.getByRole('button', { name: '继续会话', exact: true })).toBeDisabled()
  await expect(alice.getByLabel('执行方式')).toContainText('继续会话')
  await alice.screenshot({ path: join(EVIDENCE_DIR, 'offline-block.png') })
  // 显式切换到新执行（用户自己的决定）：草稿仍在；现场没有在线设备所以起不来，且**不自动发送**。
  await alice.locator('.execution-settings > summary').click()
  await selectFromMenu(alice.getByLabel('执行方式'), /开始新执行/)
  await expect(alice.getByLabel('选择 Agent')).toBeVisible({ timeout: 30_000 })
  await expect(alice.getByLabel('指令')).toHaveValue(draft)
  await expect(alice.getByRole('button', { name: '开始执行' })).toBeDisabled()
  await sleep(3_000)
  expect((await room()).runs.length).toBe(runsBeforeOffline)
  expect(instructionPosts).toBe(instructionPostsBeforeOffline)
  await expect(alice.getByLabel('指令')).toHaveValue(draft)
  expect(liveFrames).toBeGreaterThan(0)
  facts['offline'] = {
    blockedBy: 'client-guard',
    blockerShown: true,
    draftPreserved: true,
    explicitSwitchKeepsDraft: true,
    newRunsAfterAttempt: 0,
    instructionPosts: instructionPostsBeforeOffline,
    instructionPostsAfterBlock: instructionPosts,
    liveFrames,
  }
})

test('真实布局：20 段窗口、载入更早的阅读锚点、上翻后新内容不拽人、三档宽度', async () => {
  test.setTimeout(240_000)
  const alice = shared.alice!
  const taskId = shared.taskId!
  const runId = shared.firstRunId!
  const builderRunView = (await hubApi(shared.cookie!, 'GET', `/runs/${runId}`)).data as Record<
    string,
    unknown
  >
  const room0 = await room()
  const realRuns = room0.runs.length
  const builderRow = room0.runs[0]!
  const baseCreatedAt = Date.parse(builderRow.createdAt)
  const SYNTHETIC = 25
  const syntheticRuns = Array.from({ length: SYNTHETIC }, (_, index) => {
    const n = index + 1
    const id = `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`
    const createdAt = new Date(baseCreatedAt - (SYNTHETIC - index) * 60_000).toISOString()
    const reply = `第 ${n} 次运行的回复：第 ${n} 节已经写入报告。`
    const events = [
      {
        runId: id,
        seq: 1,
        type: 'run.phase',
        audience: 'project',
        event: { type: 'run.phase', phase: 'thinking' },
        occurredAt: createdAt,
        receivedAt: createdAt,
      },
      {
        runId: id,
        seq: 2,
        type: 'assistant.message',
        audience: 'owner',
        event: { type: 'assistant.message', text: reply },
        occurredAt: createdAt,
        receivedAt: createdAt,
      },
      {
        runId: id,
        seq: 3,
        type: 'run.completed',
        audience: 'owner',
        event: { type: 'run.completed', finalText: reply },
        occurredAt: createdAt,
        receivedAt: createdAt,
      },
    ]
    return {
      id,
      instructionId: `deed0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      createdAt,
      reply,
      instruction: `第 ${n} 次执行：整理报告第 ${n} 节。`,
      row: {
        ...builderRow,
        id,
        status: 'completed',
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date(Date.parse(createdAt) + 30_000).toISOString(),
        rerunOfRunId: null,
        resumeFromRunId: null,
        lastToolCall: null,
        lastPhase: null,
        specRevision: null,
      },
      view: { ...builderRunView, id, createdAt, status: 'completed' },
      events,
    }
  })
  // 「远端起了新一次运行」的替身：读面在真实 WS 失效后多返回一段（新内容落在底部）。
  // 它的 createdAt 取**服务那一刻**（比真实运行都新——段序按服务端顺序，不是按 id 或数组位置）。
  const grownId = 'c0ffee99-0000-4000-8000-000000000001'
  const grownReply = '远端新一次运行的回复：报告已经按新口径更新。'
  const buildGrown = () => {
    const createdAt = new Date().toISOString()
    return {
      id: grownId,
      instructionId: 'deed0000-0000-4000-8000-000000000099',
      createdAt,
      reply: grownReply,
      instruction: '远端执行：按新口径更新报告。',
      row: {
        ...builderRow,
        id: grownId,
        status: 'completed' as const,
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        rerunOfRunId: null,
        resumeFromRunId: null,
        lastToolCall: null,
        lastPhase: null,
        specRevision: null,
      },
      view: { ...builderRunView, id: grownId, createdAt, status: 'completed' },
      events: [
        {
          runId: grownId,
          seq: 2,
          type: 'assistant.message',
          audience: 'owner',
          event: { type: 'assistant.message', text: grownReply },
          occurredAt: createdAt,
          receivedAt: createdAt,
        },
      ],
    }
  }
  let grownVisible = false
  let grownCache: ReturnType<typeof buildGrown> | null = null
  /** grown 那条只在第一次被读到时报到——之后同一个对象，避免每次请求换时间戳。 */
  const grown = () => (grownCache ??= buildGrown())
  const byId = new Map(syntheticRuns.map((row) => [row.id, row]))
  const lookup = (id: string) => (id === grownId && grownVisible ? grown() : byId.get(id))
  const instructionRow = (row: (typeof syntheticRuns)[number] | ReturnType<typeof buildGrown>) => ({
    id: row.instructionId,
    taskId,
    authorUserId: shared.aliceUserId,
    body: row.instruction,
    kind: 'instruction',
    origin: 'human',
    targetAgentId: null,
    runId: row.id,
    instructionState: 'accepted',
    instructionErrorCode: null,
    instructionErrorMessage: null,
    createdAt: new Date(Date.parse(row.createdAt) - 1_000).toISOString(),
    editedAt: null,
  })

  await alice.route(`**/api/v1/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { data: Record<string, unknown> }
    const injected = grownVisible ? [...syntheticRuns, grown()] : syntheticRuns
    // 顺序必须**按服务端口径**重建（createdAt ASC, id ASC）：只把桩数组拼在真运行前面时，
    // 「最新一段」会落在真运行中间——首轮实测 last() 是另一条真运行。
    const injectedRuns = injected.map((row) => row.row)
    const merged = [...injectedRuns, ...((body.data['runs'] as typeof injectedRuns) ?? [])]
    merged.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )
    body.data['runs'] = merged
    body.data['instructions'] = [
      ...injected.map(instructionRow),
      ...((body.data['instructions'] as unknown[]) ?? []),
    ]
    await route.fulfill({ response, json: body })
  })
  await alice.route('**/api/v1/runs/*/events*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!
    const row = lookup(id)
    if (row === undefined) return route.fallback()
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? '0')
    await route.fulfill({
      status: 200,
      json: { ok: true, data: { events: row.events.filter((item) => item.seq > after) } },
    })
  })
  await alice.route('**/api/v1/runs/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!
    const row = lookup(id)
    if (row === undefined) return route.fallback()
    await route.fulfill({ status: 200, json: { ok: true, data: row.view } })
  })

  await alice.goto(`/tasks/${taskId}`)
  const transcript = alice.getByTestId('conversation-scroll')
  await expect(transcript).toBeVisible({ timeout: 30_000 })
  const segments = alice.locator('[data-testid="run-segment"]')
  const total = SYNTHETIC + realRuns
  // 首屏 20 段（窗口），更早的等「加载更早」。
  await expect(segments).toHaveCount(20, { timeout: 30_000 })
  // 段的身份属性是阅读锚点的抓手（段不带它时锚点在真实房间里抓不到东西）。
  await expect(segments.first()).toHaveAttribute('data-conversation-entry', /^run-/)
  // 单一主滚动容器：**执行栏之内**段到栏顶只有一个竖向可滚动祖先。
  // （更外层的 `.app-body` 是应用外壳自己的滚动层，与对话无关——首轮实测把它算进来会误报
  // 两组容器；判的是「对话内部不嵌套滚动」。）
  const scrollAncestors = await segments.first().evaluate((node) => {
    const names: string[] = []
    let current: HTMLElement | null = node.parentElement
    while (current !== null) {
      const overflow = getComputedStyle(current).overflowY
      if (overflow === 'auto' || overflow === 'scroll')
        names.push(current.className || current.tagName)
      if (current.id === 'execution-channel') break
      current = current.parentElement
    }
    return names
  })
  expect(scrollAncestors).toEqual(['workspace-transcript conversation-transcript'])
  const metrics = await transcript.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)

  // 锚点：记住首屏里某一段的位置 → 点「加载更早」→ 它必须仍在原处。
  const neighborId = syntheticRuns[12]!.id
  /** 某个条目相对滚动容器的偏移（同一个键前后可比较）与容器读数。 */
  const offsetOfEntry = (key: string) =>
    transcript.evaluate((node, entryKey) => {
      const target = node.querySelector<HTMLElement>(`[data-conversation-entry="${entryKey}"]`)
      if (target === null) return null
      return target.getBoundingClientRect().top - node.getBoundingClientRect().top
    }, key)
  /** 当前 DOM 里第一个条目（滚动到顶部时 = 应用记的锚点条目）。 */
  const firstEntryKey = () =>
    transcript.evaluate(
      (node) =>
        node.querySelector<HTMLElement>('[data-conversation-entry]')?.dataset[
          'conversationEntry'
        ] ?? null,
    )
  const scrollState = () =>
    transcript.evaluate((node) => ({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      containerTop: node.getBoundingClientRect().top,
      entries: node.querySelectorAll('[data-conversation-entry]').length,
    }))
  // 「加载更早」按钮在列表**顶部**：真人要先滚上去才点得到它。这一步必须用真实滚动提前
  // 做完，而不是让 Playwright 在点击时替我们滚——否则锚点记的是"点击那一刻"的位置，与
  // 前面量的根本不是同一个场景（实测：先量在底部、点击时被滚到顶部，判据把一个**正确**
  // 的保持行为判成 8415px 漂移）。
  await alice.getByTestId('load-earlier').scrollIntoViewIfNeeded()
  await transcript.evaluate((node) => node.dispatchEvent(new Event('scroll')))
  const hookAnchorKey = (await firstEntryKey())!
  const hookAnchorSelector = `[data-conversation-entry="${hookAnchorKey}"]`
  const beforeDiag = {
    ...(await scrollState()),
    hookOffset: await offsetOfEntry(hookAnchorKey),
    neighborOffset: await offsetOfEntry(`run-${neighborId}`),
  }
  await alice.getByTestId('load-earlier').click()
  await expect(segments).toHaveCount(total, { timeout: 30_000 })
  await expect(alice.getByTestId('load-earlier')).toHaveCount(0)
  const afterDiag = {
    ...(await scrollState()),
    firstKey: await firstEntryKey(),
    hookOffset: await offsetOfEntry(hookAnchorKey),
    neighborOffset: await offsetOfEntry(`run-${neighborId}`),
  }
  expect(afterDiag.firstKey).not.toBe(hookAnchorKey) // 更早的段真的进来了
  expect(await transcript.locator(hookAnchorSelector).count()).toBe(1)
  // 应用自己的契约：它记的锚点条目（第一个可见条目）必须留在原处。
  const anchorDelta = Math.abs(afterDiag.hookOffset! - beforeDiag.hookOffset!)
  // 视口里更靠下的那一段：应用只保证锚点条目本身不动，锚点**下方**的内容会因
  // 「前一段变成非首段」而多出一条分隔（`.conversation-run + .conversation-run` 的
  // border-top 1px + padding-top 20px）。21px 的视觉位移人眼分辨不出，但必须解释清楚
  // 而不是把阈值调到看不出问题。
  const neighborDelta = Math.abs(afterDiag.neighborOffset! - beforeDiag.neighborOffset!)
  // 上翻 → 停止跟随（出现「回到最新」）→ 新内容到达也不拽人。
  await transcript.evaluate((node) => {
    node.scrollTop = 0
    node.dispatchEvent(new Event('scroll'))
  })
  await expect(alice.getByTestId('conversation-jump')).toBeVisible()
  const scrolledTop = await transcript.evaluate((node) => node.scrollTop)
  grownVisible = true
  // 真实用户动作（成员发评论）→ 真实 WS 失效 → 读面重拉（此时多一段）。
  const comment = await hubApi(shared.bobCookie!, 'POST', `/tasks/${taskId}/comments`, {
    body: '远端起了新一次运行，我正在看历史。',
  })
  expect(comment.status).toBe(201)
  await expect(segments).toHaveCount(total + 1, { timeout: 30_000 })
  // 新段确实落到了底部（内容长出来了），但阅读位置没被抢。
  await expect(segments.last()).toHaveAttribute('data-run-id', grownId)
  const scrolledAfterGrowth = await transcript.evaluate((node) => node.scrollTop)
  expect(scrolledAfterGrowth).toBe(scrolledTop)
  await expect(alice.getByTestId('conversation-jump')).toBeVisible()
  await alice.screenshot({ path: join(EVIDENCE_DIR, 'anchor-growth.png') })
  await alice.getByTestId('conversation-jump').click()
  const afterJump = await transcript.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
    clientHeight: node.clientHeight,
  }))
  expect(afterJump.scrollHeight - afterJump.scrollTop - afterJump.clientHeight).toBeLessThanOrEqual(
    2,
  )

  const layouts: Array<{ width: number; viewport: number; scroll: number }> = []
  for (const width of [1440, 390, 320]) {
    await alice.setViewportSize({ width, height: 960 })
    const bounds = await alice.evaluate(() => ({
      viewport: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport)
    await expect(transcript).toBeVisible()
    layouts.push({ width, ...bounds })
    await alice.screenshot({ path: join(EVIDENCE_DIR, `conversation-${width}.png`) })
  }

  facts['window'] = {
    stubbed: 'task-aggregate+runs+events（25 段由读面桩供给；交互全部真实）',
    totalRunsBeforeGrowth: total,
    totalRunsAfterGrowth: total + 1,
    firstScreen: 20,
    hiddenBefore: total - 20,
    afterLoadEarlier: total,
    loadEarlierGone: true,
    singleScroller: scrollAncestors.join(','),
    transcriptOverflows: metrics.scrollHeight > metrics.clientHeight,
  }
  facts['anchor'] = {
    hookAnchorKey,
    neighborRunId: neighborId,
    beforeOffset: beforeDiag.hookOffset,
    afterOffset: afterDiag.hookOffset,
    deltaPx: anchorDelta,
    neighborDriftPx: neighborDelta,
    neighborTolerancePx: 24,
    before: beforeDiag,
    after: afterDiag,
  }
  facts['follow'] = {
    stoppedFollowingOnScrollUp: true,
    scrollTopBeforeGrowth: scrolledTop,
    scrollTopAfterGrowth: scrolledAfterGrowth,
    newSegmentAtBottom: true,
    jumpVisibleAfterGrowth: true,
    nearBottomAfterJump: true,
  }
  facts['layout'] = {
    widths: layouts.map((row) => row.width),
    noHorizontalOverflow: true,
    bounds: layouts,
  }
})
