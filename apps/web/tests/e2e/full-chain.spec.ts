/**
 * P1-19 全链 E2E（Issue #23）：两浏览器 × 真 Hub × 真 Node × 真 Runtime（DSH replay）。
 *
 * 与 P1-07 种子同一环境（playwright webServer → scripts/e2e-serve.mts），本文件
 * 补上 Runtime 真跑的产品闭环：
 *   Bob 启动 Builder Run → Runtime 子进程起 → DSH 工具 ask → Bob 见完整审批卡、
 *   Alice 只见等待态（G5-01 两端 diff 走 UI）→ Bob 批准（G5-03）→ Runtime 继续
 *   → Artifact candidate 上屏 → Bob 发布 → Alice 下载且与 digest 一致（G6-04）
 *   → Bob 启动 Reviewer Run → Node 侧按输入清单受控消费（G6-07）。
 *
 * 视角纪律（04 矩阵为准，纠 Brief 口误）：审批由 **Run owner（Bob，责任人）**
 * 裁决；Alice 是成员视角——G5-02 明文规定她批准 Bob 的审批必须 403，UI 呈现
 * 「等待责任人批准」。Alice 侧另验 HTTP 越权 403。
 *
 * 可见性驱动方式与 P1-07 同一诚实路径：Task Room 聚合查询（['task-room', id]）
 * 不在 realtime 失效映射内（产品行为，非本 Issue 范围），状态跃迁后的 UI 呈现
 * 经显式 reload 驱动；RunLivePanel 的事件流键（['run', id]）走真实 realtime。
 *
 * 账号开通/配对码走 HTTP 旁路（成员管理/设备配对 UI 属后续版本——P1-07 既有
 * 登记惯例）；Node 生命周期经 e2e-serve 控制面（只做进程与故障，不做产品动作）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  env,
  hubApi,
  sessionCookie,
  startNode,
  seedPluginPack,
  setRuntimeFixture,
  getRunFact,
  waitForRunStatus,
  inputManifestForRun,
  workspaceCanonicalPath,
  waitForRuntimeReleased,
  activeRuntimes,
  restartHub,
  restartNode,
  dropNodeConnection,
  dropAckCount,
  pidAlive,
  assertSeqContiguous,
  collectEvidenceOnFailure,
  fillAndEnter,
  assertNotNativeSelect,
  selectFromMenu,
  sleep,
  type RunFact,
} from './helpers.js'
import { expectNoContrastOffenders } from './contrast-sweep.js'

const ALICE_PASSWORD = 'correct horse battery staple'
const BOB_PASSWORD = 'correct horse battery staple'
// 账号/团队带唯一后缀：模块态只在单 worker 内存活，任何环境复用/漂移场景下
// 都不与既有团队互踩（全局 username 唯一是产品约束）。
const RUN_TAG = randomUUID().slice(0, 8)
const ALICE_NAME = `alice-${RUN_TAG}`
const BOB_NAME = `bob-${RUN_TAG}`

/** 本文件的模块级共享态：serial 模式按序流转（一次 Setup 一个团队，诚实共享）。 */
const shared: {
  aliceContext?: BrowserContext
  bobContext?: BrowserContext
  alice?: Page
  bob?: Page
  taskId?: string
  aliceCookie?: string
  bobCookie?: string
  aliceUserId?: string
  bobUserId?: string
  deviceId?: string
  builderRunId?: string
  artifactId?: string
  lostRunId?: string
  cancelledRunId?: string
  runIds: string[]
} = { runIds: [] }

async function setupTeamAndTask(): Promise<void> {
  // 只跑一次（首个测试触发）；后续测试共享同一团队/任务上下文。
  if (shared.taskId !== undefined) return
  const alice = await shared.aliceContext!.newPage()
  shared.alice = alice

  await alice.goto('/setup')
  await alice.fill('#setup-token', env().setupToken)
  await alice.fill('#team-name', `全链验收团队 ${RUN_TAG}`)
  await alice.fill('#setup-username', ALICE_NAME)
  await alice.fill('#setup-display-name', 'Alice')
  await fillAndEnter(alice, '#setup-password', ALICE_PASSWORD)
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

  // #152：「创建项目」表单默认收起（与「创建任务」同款折叠入口），先点开再填。
  await alice.getByRole('button', { name: '新建项目' }).click()
  await fillAndEnter(alice, '#project-name', 'P1-19 全链项目')
  shared.aliceCookie = await sessionCookie(shared.aliceContext!)
  const me = await hubApi(shared.aliceCookie, 'GET', '/auth/session')
  shared.aliceUserId = (me.data as { userId: string }).userId

  // Bob 账号：HTTP 旁路（邀请开通 UI 不在范围）。
  const invite = await hubApi(shared.aliceCookie, 'POST', '/invites', { role: 'member' })
  expect(invite.status).toBe(201)
  const inviteToken = (invite.data as { token: string }).token
  const accepted = await fetch(`${env().hubOrigin}/api/v1/invites/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env().webOrigin,
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
  shared.bobUserId = ((await accepted.json()) as { data: { userId: string } }).data.userId

  // Plugin Pack 行种子（harness.seed，P1-18 惯例）→ Agent 经真人 UI 创建。
  const pack = await seedPluginPack(shared.aliceUserId!)
  // `pack.pluginPackId` 只用来断言种子成功；选 Pack 走名字（见 createAgentViaUi 的注释）
  expect(pack.pluginPackId).not.toBe('')
  await createAgentViaUi(alice, 'builder')
  await createAgentViaUi(alice, 'reviewer')

  // Task：Alice 创建并指派 Bob（#136 责任人下拉选择器）；Bob 真实浏览器登录并接受。
  await alice.goto('/')
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await alice.getByRole('button', { name: '创建任务' }).click()
  const createTaskForm = alice.locator('form[aria-label="创建任务"]')
  await alice.locator('input[id^="task-title-"]').fill('产出并复核验收报告')
  // #158：责任人下拉是 vendored Menu（不再是原生 <select>）——反面钉 + 真人路径。
  const assignee = createTaskForm.locator('button[id^="task-assignee-"]')
  await assertNotNativeSelect(assignee, createTaskForm, '责任人')
  await selectFromMenu(assignee, /Bob/)
  await expect(assignee).toContainText('Bob')
  await createTaskForm.getByRole('button', { name: /创建任务/ }).click()
  await alice.waitForURL(/\/tasks\//)
  const taskId = new URL(alice.url()).pathname.split('/').pop()
  if (taskId === undefined || taskId === '') throw new Error('Task URL 无法解析')
  shared.taskId = taskId

  const bob = await shared.bobContext!.newPage()
  shared.bob = bob
  await bob.goto('/login')
  await bob.fill('#login-username', BOB_NAME)
  await fillAndEnter(bob, '#login-password', BOB_PASSWORD)
  await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await bob.goto(`/tasks/${shared.taskId}`)
  await bob.getByRole('button', { name: '接受任务' }).click()
  await expect(bob.getByText('你已接受此任务。')).toBeVisible()
  shared.bobCookie = await sessionCookie(shared.bobContext!)
}

async function createAgentViaUi(page: Page, name: string): Promise<void> {
  await page.goto('/agents')
  // #167：页面标题只说一次（原来 h1「Agent 管理」+ 紧接着的 h2「Agents」是同义重复），
  // 文案取主导航同一套的领域词。
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await page.fill('#agent-name', name)
  await page.fill('#agent-persona', '你是 E2E 验收代理。')
  await page.fill('#agent-provider', 'replay')
  await page.fill('#agent-model', 'replay-model')
  await page.fill('#agent-credential-slot', 'default')
  // #158：Plugin Pack 下拉是 vendored Menu——反面钉（不再是原生 select）+ 真人路径
  // （点开 → 点选项）。原来这里用 selectOption，只对原生 <select> 成立。
  const packTrigger = page.locator('#agent-plugin-pack')
  // #167：PackSelect 的可见标签/可访问名已中文化（#158 之后它是唯一来源）。
  await assertNotNativeSelect(packTrigger, page.locator('form'), '插件组合（Plugin Pack）')
  // 按**名字**点，不按 UUID：菜单项文案是 `pack.name`，而 control 面的种子包叫
  // `e2e-pack`（scripts/e2e-serve.mts 的 /control/plugin-pack/seed）。
  // #158 首轮 Q5 实测踩到：拿 `pluginPackId.slice(0, 8)` 去匹配永远是"找不到"。
  await selectFromMenu(packTrigger, 'e2e-pack')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  await expect(page.getByText(name).first()).toBeVisible()
  // #167：字段标签中文优先——`Credential Slot` 是内部概念，除标签外必须带一句
  // 「填什么」的解释；这里从真人路径核验它真的渲染出来了（单测另有一条）。
  await expect(page.getByText('凭据槽（Credential Slot）')).toBeVisible()
  await expect(page.getByText(/设备所有者在本机给 API 密钥起的名字/)).toBeVisible()
}

async function pairNodeViaUiAndControl(): Promise<void> {
  if (shared.deviceId !== undefined) return
  // 配对码：Bob 会话 HTTP 旁路——**有意的分工**：本 spec 判的是整条 Run 链，
  // 设备配对的真人路径（页面签发码 → 真 node CLI 消费 → 设备自动上屏）由
  // `pairing-ui.spec.ts`（project p1-142）覆盖；此前那句「设备配对 UI 属后续版本」
  // 已由 #142 兑现。
  const codeRes = await hubApi(shared.bobCookie!, 'POST', '/devices/pairing-codes', {})
  expect(codeRes.status).toBe(201)
  const code = (codeRes.data as { code: string }).code
  const node = await startNode({ pairingCode: code })
  shared.deviceId = node.deviceId
  // 设备/Workspace 经 inventory 投影到 Hub 后，RunLauncher 才选得到（真人可见性）。
  await shared.bob!.reload()
}

async function startRunViaUi(agentName: string, promptText: string): Promise<string> {
  const bob = shared.bob!
  // 真人节奏：断链场景里 Node 以产品退避自动重连（封顶 30s 一档），页面快照可能
  // 截在「离线」瞬间——先经 HTTP 观察设备回到在线，再刷新取新快照（两步都是
  // 真实用户动作；不加速重连本身）。
  await waitDeviceOnline()
  await bob.reload()
  const agentTrigger = bob.getByLabel('选择 Agent')
  await expect(agentTrigger).toBeVisible({ timeout: 30_000 })
  // #159：**就在这一刻扫对比度**——启动面板已渲染、Run prompt 还是空的（显示 placeholder）。
  // 一审抓到过本门的三种假绿（前景 alpha、控件文字/placeholder 从不被扫、底色无法判定），
  // 而全仓只有两处 placeholder（RunLauncher 与 RunActions），只有在"面板可见且未输入"
  // 的瞬间才能扫到它。变异验证：把 input/textarea::placeholder 改成 #e6e6e6 → 这里变红。
  // #158 合并时保留此调用点（评审明确要求不要删）；它扫的是**已迁移后的**控件——
  // 下拉触发器不再是原生 select，但仍是可见控件，扫描面反而更大。
  await expectNoContrastOffenders(bob)
  // #158：RunLauncher 四处下拉都是 vendored Menu——反面钉 + 真人路径（点开 → 点选项）。
  await assertNotNativeSelect(agentTrigger, bob.locator('.run-launcher'), '选择 Agent')
  await selectFromMenu(agentTrigger, agentName)
  // 设备项文案 = 「<设备名>（在线/离线）」，设备名取自 scripts/e2e-node.mts 的 'e2e-node'；
  // 离线设备仍在列表里但不可选——这里按「在线」文案点，正好也钉住禁用项没被误点。
  await selectFromMenu(bob.getByLabel('选择设备'), /e2e-node（在线）/)
  await selectFromMenu(bob.getByLabel('选择 Workspace'), 'e2e-ws')
  await bob.getByLabel('Run prompt').fill(promptText)
  await bob.getByRole('button', { name: '启动 Run' }).click()
  // Run 行进时间线（责任人真人路径）。
  await expect(bob.locator('.run-item').first()).toBeVisible()
  const runId = await waitForFreshRunId()
  shared.runIds.push(runId)
  return runId
}

async function waitDeviceOnline(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await hubApi(shared.bobCookie!, 'GET', '/devices')
    const devices = res.data as Array<{ id: string; status: string }>
    const mine = devices.find((d) => d.id === shared.deviceId)
    if (mine?.status === 'online') return
    if (Date.now() > deadline) {
      throw new Error(`设备未回在线（${mine?.status ?? 'missing'}，等待 ${timeoutMs}ms）`)
    }
    await sleep(500)
  }
}

/** 时间线只呈现 UI；runId 经 Task Room 聚合 HTTP 对照取回（判定用，不驱动产品动作）。 */
async function waitForFreshRunId(): Promise<string> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await hubApi(shared.bobCookie!, 'GET', `/tasks/${shared.taskId}`)
    const room = res.data as { runs?: Array<{ id: string; createdAt: string }> } | undefined
    const runs = room?.runs ?? []
    const known = new Set(shared.runIds)
    const fresh = runs.filter((r) => !known.has(r.id))
    if (fresh.length > 0) {
      return fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!.id
    }
    await sleep(250)
  }
  throw new Error('UI 启动的 Run 未出现在 Task Room 聚合中')
}

/**
 * 点选时间线中的 Run 行 → RunLivePanel（事件流走 realtime 键，真人路径）。
 *
 * #162 起行标签是「第 N 次运行」（短 id 不再冒充标签），所以定位改用行上的
 * `data-run-id`——它是**定位**用锚点，可见文本仍是人话；判「行标签是人话」这件事
 * 由下面的血缘用例断言。
 */
async function selectRun(page: Page, runId: string): Promise<void> {
  await page.locator(`.run-item-button[data-run-id="${runId}"]`).click()
  await expect(page.getByTestId('run-live-events')).toBeVisible({ timeout: 30_000 })
}

test.describe.configure({ mode: 'serial' })

// 浏览器上下文是文件级生命周期（三个 describe 共享一次 Setup/Node 链）。
test.beforeAll(async ({ browser }) => {
  shared.aliceContext = await browser.newContext()
  shared.bobContext = await browser.newContext()
})

test.afterAll(async () => {
  await shared.aliceContext?.close()
  await shared.bobContext?.close()
})

test.describe('P1-19 全链：Builder Run → 审批 → Artifact → Reviewer（双浏览器）', () => {
  test.afterEach(async ({}, testInfo) => {
    await collectEvidenceOnFailure(testInfo, {
      traceId: `p1-19-main-${testInfo.testId}`,
      runIds: shared.runIds.slice(-4),
    })
  })

  test('G5：Bob 启动 Builder Run 走到审批卡（两端 diff）并批准至完成', async () => {
    test.setTimeout(300_000) // 承载一次性 Setup（团队/Agent/Task/配对/Node 冷启动）。
    await setupTeamAndTask()
    await pairNodeViaUiAndControl()

    await shared.bob!.goto(`/tasks/${shared.taskId}`)
    const runId = await startRunViaUi('builder', '起草验收报告初稿')
    shared.builderRunId = runId

    // Runtime 真跑到 waiting_approval（DB 事实先行判定），再经 reload 驱动 UI 呈现。
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    await shared.bob!.reload()

    // 审批卡：Bob（owner）见完整卡；工具名与 preview 来自 replay 工具链。
    const card = shared.bob!.getByTestId('approval-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByTestId('approval-tool')).toHaveText('publish_artifact')
    // preview 是审批载荷摘要（03 §8：owner 才见 preview；本快照工具为 artifact 类）。
    await expect(card.getByTestId('approval-preview')).toContainText('category')

    // G5-01 两端 diff（走 UI）：Alice 只见等待态，不见 owner 卡正文。
    await shared.alice!.goto(`/tasks/${shared.taskId}`)
    await expect(shared.alice!.getByTestId('approval-waiting')).toBeVisible({ timeout: 30_000 })
    await expect(shared.alice!.getByTestId('approval-card')).toHaveCount(0)

    // G5-02 越权面（HTTP 旁路核验 UI 判断）：Alice 决定 Bob 的审批必须 403。
    const fact = await getRunFact(runId)
    const approvalId = fact.approvals[0]!.id
    const aliceCookie = await sessionCookie(shared.aliceContext!)
    shared.aliceCookie = aliceCookie
    const denied = await hubApi(aliceCookie, 'POST', `/approvals/${approvalId}/decisions`, {
      decision: 'allowed_once',
    })
    expect(denied.status).toBe(403)

    // 键盘可达：焦点到批准按钮 Enter 激活（批准一次）。
    await shared.bob!.getByTestId('approve-button').focus()
    await shared.bob!.keyboard.press('Enter')
    // #140 后判据改挂**持久**证据：审批卡「决定即收卡」（见 G5-04 头注释的既有设计），
    // 决定一落地、Run 恢复运行，插槽就不再渲染该卡。此前这里断言 approval-decided
    // 之所以稳定通过，靠的正是任务房间不刷新（#140 的脏数据 bug）把卡片留在页面上——
    // 拿 bug 当判据。改为核验 Run 事件行里的审批决定（owner 受众投影，03 §8）：
    // reload + 选中该 Run（与 G5-04 同法），这是「决定真的落到事件流」的持久证据。
    await shared.bob!.reload()
    await selectRun(shared.bob!, runId)
    await expect(shared.bob!.getByTestId('run-live-events')).toContainText('审批决定：已批准一次')

    // Runtime 继续 → 完成（DB 事实判定；UI 徽标经 reload 核验）。
    const done = await waitForRunStatus(runId, 'completed', 120_000)
    await shared.bob!.reload()
    await expect(shared.bob!.getByText('已完成').first()).toBeVisible({ timeout: 30_000 })
    expect(done.artifacts.length).toBe(1)
    shared.artifactId = done.artifacts[0]!.id
    await waitForRuntimeReleased(runId) // #88：终态须由产品路径自动回收（runtime.shutdown），容量释放给后续场景。
  })

  test('G5-04：Bob 拒绝审批——工具失败结果回 Runtime、零发布副作用、终态两端可见', async () => {
    test.setTimeout(300_000)
    // 单测友好：setup/pair 幂等守卫使本测试可被 --grep 独立拉起。
    await setupTeamAndTask()
    await pairNodeViaUiAndControl()
    // 拒绝分支快照：工具调用与 approval 相同，收尾文本即被拒解释——replay 是
    // 定序回放不随决定分支，快照文本本身必须是被拒叙事（假话消灭在事实源，
    // 两端与 completed 摘要通路同文）。
    await setRuntimeFixture('rejection')
    try {
      await shared.bob!.reload()
      const runId = await startRunViaUi('builder', 'G5-04：拒绝这次发布')
      await waitForRunStatus(runId, 'waiting_approval', 120_000)
      await shared.bob!.reload()

      // 键盘可达：焦点到「拒绝」按钮 Enter 激活（G5-04 驱动走 UI）。
      const card = shared.bob!.getByTestId('approval-card')
      await expect(card).toBeVisible({ timeout: 30_000 })
      await shared.bob!.getByTestId('reject-button').focus()
      await shared.bob!.keyboard.press('Enter')

      // 判定（HTTP 旁路取事实）：Run 继续收尾到 completed；审批终态 rejected、
      // 决定人 = Bob（Run owner）。
      const fact = await waitForRunStatus(runId, 'completed', 120_000)
      expect(fact.approvals[0]?.status).toBe('rejected')
      expect(fact.approvals[0]?.decidedBy).toBe(shared.bobUserId)
      // 红线：拒绝 = 零副作用——本 Run 没有任何 artifact 行。
      expect(fact.artifacts.length).toBe(0)
      // 决定事件进 Run 时间线（owner 受众）。
      expect(
        fact.runEvents.some((e) => e.type === 'approval.decided' && e.audience === 'owner'),
      ).toBe(true)

      // 两端可见（走 UI）：审批卡插槽只随 waiting Run 存在而渲染（决定即收卡），
      // 终态经 RunLivePanel 事件行核验——projector 对 approval.decided 走
      // owner/project 双受众同形投影（03 §8），Bob/Alice 各自 reload+点选后
      // 都应看到「审批决定：已拒绝」。
      await shared.bob!.reload()
      await selectRun(shared.bob!, runId)
      await expect(shared.bob!.getByTestId('run-live-events')).toContainText('审批决定：已拒绝')
      await shared.alice!.reload()
      await selectRun(shared.alice!, runId)
      await expect(shared.alice!.getByTestId('run-live-events')).toContainText('审批决定：已拒绝')

      // 语义诚实（二评残留修复）：两端事件区含被拒解释文本（owner 原文行 +
      // project completed 摘要直通），且两端任何一行都不得再说 “Artifact
      // published.”——被拒 Run 说假话正是独立快照要消灭的东西。
      const REJECT_EXPLANATION = 'Report skipped: publication was rejected by the approver.'
      for (const page of [shared.bob!, shared.alice!]) {
        const events = page.getByTestId('run-live-events')
        await expect(events).toContainText(REJECT_EXPLANATION)
        await expect(events).not.toContainText('Artifact published.')
      }

      await waitForRuntimeReleased(runId)
    } finally {
      await setRuntimeFixture('approval')
    }
  })

  test('G6-04 Artifact：Bob 发布 candidate；Alice 下载且与 digest 一致', async () => {
    test.setTimeout(180_000)
    await shared.bob!.reload()
    const publish = shared.bob!.getByTestId('artifact-publish-button')
    await expect(publish).toBeVisible({ timeout: 30_000 })
    await expect(shared.bob!.locator('.artifact-item').first()).toContainText('仅你可见，待发布')
    await publish.click()

    // Alice（另一浏览器上下文）立即能下载（UI 下载 + HTTP 双核验）。
    await shared.alice!.reload()
    await expect(shared.alice!.getByText('Report').first()).toBeVisible({ timeout: 30_000 })
    // #162：交付物的「来源运行」是人话句柄（第 N 次运行，可与时间线行对照），
    // 完整 runId 只在 title 上——这一格以前直接印 `shortId(artifact.runId)`。
    const sourceValue = shared
      .alice!.locator('.artifact-item')
      .first()
      .locator(`dd[title="${shared.builderRunId}"]`)
    await expect(sourceValue).toHaveText(/^第 \d+ 次运行$/)
    const artifactRow = (await getRunFact(shared.builderRunId!)).artifacts.find(
      (a) => a.id === shared.artifactId,
    )
    expect(artifactRow).toBeDefined()
    const aliceCookie = await sessionCookie(shared.aliceContext!)
    const content = Buffer.from(
      await (
        await fetch(`${env().hubOrigin}/api/v1/artifacts/${shared.artifactId}/content`, {
          headers: { cookie: aliceCookie },
        })
      ).arrayBuffer(),
    )
    expect(createHash('sha256').update(content).digest('hex')).toBe(artifactRow!.sha256)
    // 浏览器下载路径（真人动作）：点「下载」触发下载事件，字节内容与 digest 一致。
    const [download] = await Promise.all([
      shared.alice!.waitForEvent('download', { timeout: 20_000 }),
      shared.alice!.getByTestId('artifact-download-button').click(),
    ])
    const stream = await download.createReadStream()
    const parts: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream!.on('data', (chunk: Buffer) => parts.push(chunk))
      stream!.on('end', () => resolve())
      stream!.on('error', reject)
    })
    expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(
      artifactRow!.sha256,
    )
  })

  test('G6-07 Reviewer Run 经输入清单受控消费 Artifact', async () => {
    test.setTimeout(240_000)
    await shared.bob!.reload()
    const runId = await startRunViaUi('reviewer', '复核已发布报告')

    // Reviewer 同样触发 ask（replay 快照）→ 再走一次真人批准。
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    await shared.bob!.reload()
    await expect(shared.bob!.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 })
    await shared.bob!.getByTestId('approve-button').click()
    await waitForRunStatus(runId, 'completed', 120_000)
    await waitForRuntimeReleased(runId)

    // 判定（Node 侧观测缝）：Reviewer 输入按清单受控消费，不继承 Builder Workspace。
    const manifest = await inputManifestForRun(runId)
    const builderArtifact = (await getRunFact(shared.builderRunId!)).artifacts[0]!
    expect(manifest.manifestText).toContain(builderArtifact.sha256)
    expect(manifest.manifestText).toContain('runtime-inputs')
    // 不继承 Builder Workspace（评审 N3）：① canonical 真实目录不得出现在输入
    // 清单（dir 是 runtime-inputs/<runId> 消费位——合法绝对路径，与来源
    // workspace 判然有别）；② 两端 RunLivePanel 真实 UI 文本面不得携带该路径
    // （03 §2.4 红线：canonicalPath 永不出 Node 投影面。二评修复：原「全
    // runEvents 正文」循环因 RunFact 列白名单只有 seq/type/audience 而恒真，
    // 撤换为 UI innerText 断言）。
    const builderWsPath = await workspaceCanonicalPath()
    expect(builderWsPath.length).toBeGreaterThan(0)
    expect(manifest.manifestText).not.toContain(builderWsPath)
    await shared.bob!.reload()
    await selectRun(shared.bob!, runId)
    await expect(shared.bob!.getByTestId('run-live-events')).not.toContainText(builderWsPath)
    await shared.alice!.reload()
    await selectRun(shared.alice!, runId)
    await expect(shared.alice!.getByTestId('run-live-events')).not.toContainText(builderWsPath)
    // Reviewer 消费位真实存在（受控输入不是一句空话）。
    expect(manifest.manifestText).toContain(join('runtime-inputs', runId))
  })

  test('G4-04 两浏览器 frame diff：Bob 见脱敏全文事件流，Alice 只见脱敏阶段', async () => {
    test.setTimeout(240_000)
    await setRuntimeFixture('basic')
    try {
      await shared.bob!.reload()
      const runId = await startRunViaUi('builder', 'hello replay')
      await waitForRunStatus(runId, 'completed', 120_000)

      // Bob（owner）：事件流含 owner 行（assistant.message 全文只在 owner 受众投影）。
      await selectRun(shared.bob!, runId)
      await expect(shared.bob!.getByTestId('run-live-events')).toContainText('Hello from replay.', {
        timeout: 30_000,
      })
      // #159：Run 实况面板的正文是等宽字体，属"底色由 token 决定、文字色靠继承"这一类
      // （同类还有 `.card`/`.field input`/`.inline-form` 等，不是唯一一处——一审纠正过这个
      // 量词）。它真出过事：`.run-live-text` 曾经只设深色底、没设文字色，于是继承了深色
      // 正文（深底深字，几乎不可读），而 token 层的配对检查看不到这一对。
      // 注：#159 一审指出该条现在时描述已不成立——`--color-surface-sunken` 在 #152 里
      // 补了定义（= bg-module-platform，浅灰），所以当前呈现是**浅底深字**；深色 fallback
      // `#14161c` 成了死代码。历史是真的，现状不同，故改写如实。
      await expectNoContrastOffenders(shared.bob!)
      expect(await shared.bob!.locator('.run-event.audience-owner').count()).toBeGreaterThanOrEqual(
        5,
      )
      // 原文正对照（评审 N3）：owner 受众行里确有该原文（Alice 侧的负断言因此
      // 不是空真——同一原文在 project 侧只允许以 run.completed 摘要形态出现）。
      expect(
        await shared
          .bob!.getByTestId('run-live-events')
          .locator('.run-event.audience-owner', { hasText: 'Hello from replay.' })
          .count(),
      ).toBeGreaterThanOrEqual(1)

      // Alice（成员）：同一动作——服务端受众过滤后，owner 行零出现，只见缩水产品。
      await shared.alice!.reload()
      await selectRun(shared.alice!, runId)
      const aliceEvents = shared.alice!.getByTestId('run-live-events')
      await expect(aliceEvents).toBeVisible({ timeout: 30_000 })
      await expect(aliceEvents.locator('.run-event.audience-project').first()).toBeVisible()
      expect(await aliceEvents.locator('.run-event.audience-owner').count()).toBe(0)
      const aliceText = await aliceEvents.innerText()
      expect(aliceText).toContain('DSH 运行时就绪') // 缩水流确有内容（脱敏而非空缺）
      // 评审 N3 原文负断言（行级、防摘要设计误伤）：该原文在 Alice 侧不得以
      // owner 受众行出现；project 受众行中也不允许有 assistant.message 原文行
      // （run.completed 摘要行是设计通路，另行核验其截断语义归 P1-16 用例）。
      expect(
        await aliceEvents
          .locator('.run-event.audience-owner', { hasText: 'Hello from replay.' })
          .count(),
      ).toBe(0)
      expect(
        await aliceEvents
          .locator('.run-event.audience-project', { hasText: 'Hello from replay.' })
          .count(),
      ).toBeLessThanOrEqual(1) // 只可能来自 completed 摘要；无原文流行泄漏通道
      // 注：project 受众同样携带 run.phase 缩水行（03 §8：阶段对团队可见），
      // 差异点在 assistant.message / tool 预览 / approval 正文——上面按受众行核验。
      await waitForRuntimeReleased(runId)
    } finally {
      // 二评顺手项：无论成败都恢复默认 approval 快照（失败不再污染后续场景）。
      await setRuntimeFixture('approval')
    }
  })
})

test.describe('P1-19 恢复场景（R1/R4/R5/R7/R8/R9）', () => {
  test.afterEach(async ({}, testInfo) => {
    await collectEvidenceOnFailure(testInfo, {
      traceId: `p1-19-recovery-${testInfo.testId}`,
      runIds: shared.runIds.slice(-3),
    })
  })

  async function startTrackedRun(promptText: string): Promise<string> {
    await shared.bob!.reload()
    const runId = await startRunViaUi('builder', promptText)
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    return runId
  }

  async function approveAndComplete(runId: string): Promise<void> {
    await shared.bob!.reload()
    await expect(shared.bob!.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 })
    await shared.bob!.getByTestId('approve-button').click()
    await waitForRunStatus(runId, 'completed', 120_000)
    await waitForRuntimeReleased(runId)
  }

  test('R1：Hub 重启后 Node 重连、事件补发且 Run 不误终态', async () => {
    test.setTimeout(300_000)
    await setupTeamAndTask() // 全文件被单独运行时也能自建前置（幂等）
    await pairNodeViaUiAndControl()
    if (shared.runIds.length === 0) await shared.bob!.goto(`/tasks/${shared.taskId}`)
    const runId = await startTrackedRun('R1：Hub 重启继续')

    const restart = await restartHub({ signal: 'SIGTERM', stayDownMs: 2_500 })
    expect(restart.downMs).toBeGreaterThanOrEqual(2_000)

    // Hub 重启不抹掉事实源（DB）：Run 仍停在 waiting_approval，不丢不复活。
    await sleep(3_000) // 给 Node/Browser WS 退避重连留真人节奏
    const mid = await getRunFact(runId)
    expect(mid.run.status).toBe('waiting_approval')
    expect(mid.run.failureCode).toBeNull()

    // 重启后审批通道（Browser→Hub→Outbox→Node→Runtime）全链仍可用。
    await approveAndComplete(runId)
    const done = await getRunFact(runId)
    assertSeqContiguous(done)
  })

  test('R4：Node 断开 10 秒——Run 保持原状态，重连后继续', async () => {
    test.setTimeout(300_000)
    const runId = await startTrackedRun('R4：短暂断链')

    await dropNodeConnection(10_000)
    await sleep(5_000) // 断开窗口中段（lease 30s 之内）
    const during = await getRunFact(runId)
    expect(during.run.status).toBe('waiting_approval') // 不得被误标 lost

    // 重连由 Node 退避自动完成；批准后事件从 spool 续发。
    await approveAndComplete(runId)
    const done = await getRunFact(runId)
    assertSeqContiguous(done)
    expect(done.run.failureCode).toBeNull()
  })

  test('R5：Node 断开超 30 秒——Run lost(RUNTIME_LOST)，重连不复活', async () => {
    test.setTimeout(360_000)
    const runId = await startTrackedRun('R5：长断链')

    await dropNodeConnection(45_000)
    // 判定：lease(30s) + reconcile(10s tick) 之后必成 lost；红线 = 终态禁改写。
    const lost = await (async (): Promise<RunFact> => {
      const deadline = Date.now() + 90_000
      for (;;) {
        const f = await getRunFact(runId)
        if (f.run.status === 'lost') return f
        if (Date.now() > deadline)
          throw new Error(`未在 lease 窗口内标 lost（当前 ${f.run.status}）`)
        await sleep(500)
      }
    })()
    expect(lost.run.failureCode).toBe('RUNTIME_LOST')

    // 断链窗口继续走完（Node 自动重连），lost 不得被改回 running。
    await sleep(20_000)
    const after = await getRunFact(runId)
    expect(after.run.status).toBe('lost')

    // UI 呈现（责任人 reload 后见「丢失」徽标 + 未知副作用警示）。
    await shared.bob!.reload()
    await expect(shared.bob!.getByText('丢失').first()).toBeVisible({ timeout: 30_000 })
    await waitForRuntimeReleased(runId) // #88：Hub 判 lost 后心跳仍报 active → admin run.cancel 收敛，进程由产品路径回收。
  })

  test('R7：Outbox 重发按 commandId 幂等——只启动一个 Runtime', async () => {
    test.setTimeout(300_000)
    await dropAckCount(1) // 丢掉 run.start 的 command.ack → Hub 必重发
    await shared.bob!.reload()
    const runId = await startRunViaUi('builder', 'R7：ack 丢失重发')
    await waitForRunStatus(runId, 'waiting_approval', 120_000)

    const fact = await getRunFact(runId)
    const startRows = fact.outbox.filter((r) => r.type === 'run.start')
    expect(startRows.length).toBe(1)
    expect(startRows[0]!.attempts).toBeGreaterThanOrEqual(2) // 观测：确实重发过
    expect(startRows[0]!.acked).toBe(true)
    const { spawnCounts } = await activeRuntimes()
    expect(spawnCounts[runId]).toBe(1) // 判定：零第二 Runtime

    await approveAndComplete(runId)
    assertSeqContiguous(await getRunFact(runId))
  })

  test('R8：提交后 Hub 崩溃——Outbox worker 重启续派发，无永久 queued', async () => {
    test.setTimeout(300_000)
    await shared.bob!.reload()
    // 崩溃注入取「提交后、未达 Node」这一确定性形态：先拔 Node 网线（产品语义
    // 断链，outbox 行已提交但首次派发必然失败），再 SIGKILL Hub。曾实测直接
    // SIGKILL 会砸进「首次派发 ack 在途」的毫秒窗（Node 收到但未回执、重发撞上
    // 处理中状态），那是另一条已登记的产品竞态（立账 #90 观察项），不是 R8 的
    // 验收点。
    await dropNodeConnection(4_000)
    const runId = await startRunViaUi('builder', 'R8：提交后崩溃')
    await sleep(800) // 让首个派发 attempt 撞墙（unacked 留底）

    // 硬闸（防静默退化为 R1 变体）：崩溃前 Run 必须仍停在派发前/中——
    // queued/dispatching 且 run.start 未 ack。若此刻已 acked/已 waiting_approval，
    // 说明根本没测到「崩溃在提交与派发之间」这一 R8 本体窗，直接红。
    const pre = await getRunFact(runId)
    expect(['queued', 'dispatching']).toContain(pre.run.status)
    const preStart = pre.outbox.filter((r) => r.type === 'run.start')
    expect(preStart.length).toBe(1)
    expect(preStart[0]!.acked).toBe(false)

    await restartHub({ signal: 'SIGKILL', stayDownMs: 2_000 })
    await sleep(1_500)

    // 判定：worker 重启后继续派发，Run 必然离开 queued 并走到可审批态。
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    const queued = await getRunFact(runId)
    expect(queued.run.status).not.toBe('queued')
    // 硬闸（观测）：崩溃前已至少一次失败 attempt + 重启后续派发再 attempt ≥2，
    // 最终 acked——「Outbox 重启续派发」的完整证据链。
    const postStart = queued.outbox.find((r) => r.type === 'run.start')!
    expect(postStart.attempts).toBeGreaterThanOrEqual(2)
    expect(postStart.acked).toBe(true)

    await approveAndComplete(runId)
    assertSeqContiguous(await getRunFact(runId))
  })

  test('R9：Node 崩溃重启——孤儿 Runtime 被终止，Run lost 且不自动复活', async () => {
    test.setTimeout(360_000)
    const runId = await startTrackedRun('R9：Node 崩溃孤儿')
    const { runtimes } = await activeRuntimes()
    const pid = runtimes.find((r) => r.runId === runId)?.pid
    expect(pid).toBeGreaterThan(0)
    expect(pidAlive(pid!)).toBe(true)

    await restartNode() // SIGKILL Node（崩溃语义），同状态重启 → recoverOrphans

    // 取证：孤儿必须死（红线：不残留子进程）。
    const deadline = Date.now() + 20_000
    while (pidAlive(pid!) && Date.now() < deadline) await sleep(300)
    expect(pidAlive(pid!)).toBe(false)

    // 判定：Node 上报孤儿终态 → Hub lost(RUNTIME_LOST)；重连后禁改写。
    const lost = await (async (): Promise<RunFact> => {
      const dl = Date.now() + 90_000
      for (;;) {
        const f = await getRunFact(runId)
        if (f.run.status === 'lost') return f
        if (Date.now() > dl) throw new Error(`Node 重启后 Run 未标 lost（当前 ${f.run.status}）`)
        await sleep(500)
      }
    })()
    expect(lost.run.failureCode).toBe('RUNTIME_LOST')
    await sleep(5_000)
    expect((await getRunFact(runId)).run.status).toBe('lost') // 不复活

    await shared.bob!.reload()
    await expect(shared.bob!.getByText('丢失').first()).toBeVisible({ timeout: 30_000 })
    shared.lostRunId = runId
  })
})

test.describe('P1-19 Run 行动（G7-01 取消 / G7-04 重跑血缘）', () => {
  test.afterEach(async ({}, testInfo) => {
    await collectEvidenceOnFailure(testInfo, {
      traceId: `p1-19-ops-${testInfo.testId}`,
      runIds: shared.runIds.slice(-3),
    })
  })

  test('G7-01：等待审批的 Run 经 UI 取消——终态 cancelled 且 Runtime 进程收尾', async () => {
    test.setTimeout(300_000)
    await shared.bob!.reload()
    const runId = await startRunViaUi('builder', 'G7-01：取消我')
    await waitForRunStatus(runId, 'waiting_approval', 120_000)

    await shared.bob!.reload()
    await selectRun(shared.bob!, runId)
    const cancel = shared.bob!.getByRole('button', { name: '取消 Run' })
    await expect(cancel).toBeVisible()
    await cancel.focus()
    await shared.bob!.keyboard.press('Enter') // 键盘可达（Q5 验收口径）

    const fact = await waitForRunStatus(runId, 'cancelled', 120_000)
    expect(fact.run.finishedAt).not.toBeNull()
    assertSeqContiguous(fact)
    // 取证：Runtime 进程不残留（确认或升级击杀都归零）。
    const deadline = Date.now() + 25_000
    let lingering = true
    while (lingering && Date.now() < deadline) {
      const { runtimes } = await activeRuntimes()
      lingering = runtimes.some((r) => r.runId === runId)
      if (lingering) await sleep(500)
    }
    expect(lingering).toBe(false)

    // 终态禁改写：取消后审批不得再被决定（HTTP 旁路核验产品判断）。
    // 无条件断言（评审 N2）：G7-01 取消的正是 waiting_approval Run——审批行必存在。
    expect(fact.approvals.length).toBeGreaterThan(0)
    const denied = await hubApi(
      shared.bobCookie!,
      'POST',
      `/approvals/${fact.approvals[0]!.id}/decisions`,
      {
        decision: 'allowed_once',
      },
    )
    expect(denied.status).toBe(409)
    await shared.bob!.reload()
    await expect(shared.bob!.getByText('已取消').first()).toBeVisible({ timeout: 30_000 })
    shared.cancelledRunId = runId
  })

  test('G7-04：终态 Run 显式重跑——新 Run 带血缘且不继承旧副作用', async () => {
    test.setTimeout(300_000)
    const sourceRunId = shared.cancelledRunId ?? shared.lostRunId
    expect(sourceRunId).toBeDefined()

    await shared.bob!.reload()
    await selectRun(shared.bob!, sourceRunId!)
    await shared.bob!.getByRole('button', { name: '重跑此 Run' }).click()
    await shared.bob!.locator('#run-rerun-prompt').fill('重跑：全新指令（不复用旧 prompt）')
    await shared.bob!.getByRole('button', { name: '确认重跑' }).click()

    // 判定：新 Run 存在、rerunOfRunId 指向来源（HTTP 旁路核验产品事实）。
    const deadline = Date.now() + 20_000
    let newRunId = ''
    while (Date.now() < deadline) {
      const res = await hubApi(shared.bobCookie!, 'GET', `/tasks/${shared.taskId}`)
      const runs = (res.data as { runs?: Array<{ id: string }> }).runs ?? []
      const fresh = runs.find((r) => !shared.runIds.includes(r.id) && r.id !== sourceRunId)
      if (fresh !== undefined) {
        newRunId = fresh.id
        break
      }
      await sleep(250)
    }
    expect(newRunId).not.toBe('')
    shared.runIds.push(newRunId)
    const newFact = await waitForRunStatus(newRunId, 'waiting_approval', 120_000)
    expect(newFact.run.rerunOfRunId).toBe(sourceRunId!)

    // UI 呈现（#162）：血缘句说「重跑自第 N 次运行」，来源 id 只在 title 上悬停可见
    // ——不再有「由 Run <前8位> 重跑」这种拿短 id 当标签的写法。reload 取新快照后再点选。
    await shared.bob!.reload()
    await selectRun(shared.bob!, newRunId)
    const panel = shared.bob!.getByTestId('run-live-panel')
    const lineage = panel.getByTestId('run-lineage')
    // 整句匹配（而不是「全文不含短 id」）：这句话就是判据要的样子，短 id 自然无处容身；
    // 对面板全文做一刀切否定会因事件文本里出现别处的哈希而假红。来源的序号 N 取决于
    // 本 Task 到此刻已有几次运行，所以用正则锚形态、不写死 N。
    await expect(lineage).toHaveText(/^重跑自第 \d+ 次运行$/)
    await expect(lineage).toHaveAttribute('title', sourceRunId!)
    // 行标签是人话句柄「第 N 次运行」（完整 id 在 title 上），面板标题说「本次运行」。
    const rowLabel = shared.bob!.locator(`.run-item-button[data-run-id="${newRunId}"] .run-label`)
    await expect(rowLabel).toHaveText(/^第 \d+ 次运行$/)
    await expect(rowLabel).toHaveAttribute('title', newRunId)
    const panelHeading = panel.getByRole('heading', { name: '本次运行' })
    await expect(panelHeading).toHaveAttribute('title', newRunId)
    await approveAndCompleteLoose(newRunId)
    assertSeqContiguous(await getRunFact(newRunId))
    // 红线：来源 Run 终态不因重跑被改写。
    expect((await getRunFact(sourceRunId!)).run.status).not.toBe('running')
  })
})

async function approveAndCompleteLoose(runId: string): Promise<void> {
  await shared.bob!.reload()
  await expect(shared.bob!.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 })
  await shared.bob!.getByTestId('approve-button').click()
  await waitForRunStatus(runId, 'completed', 120_000)
  await waitForRuntimeReleased(runId)
}
