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
  releaseRuntime,
  activeRuntimes,
  restartHub,
  restartNode,
  dropNodeConnection,
  dropAckCount,
  pidAlive,
  assertSeqContiguous,
  collectEvidenceOnFailure,
  fillAndEnter,
  sleep,
  type RunFact,
} from './helpers.js'

const ALICE_PASSWORD = 'correct horse battery staple'
const BOB_PASSWORD = 'correct horse battery staple'

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
  await alice.fill('#team-name', '全链验收团队')
  await alice.fill('#setup-username', 'alice')
  await alice.fill('#setup-display-name', 'Alice')
  await fillAndEnter(alice, '#setup-password', ALICE_PASSWORD)
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

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
      username: 'bob',
      displayName: 'Bob',
      password: BOB_PASSWORD,
    }),
  })
  expect(accepted.status).toBe(201)
  shared.bobUserId = ((await accepted.json()) as { data: { userId: string } }).data.userId

  // Plugin Pack 行种子（harness.seed，P1-18 惯例）→ Agent 经真人 UI 创建。
  const pack = await seedPluginPack(shared.aliceUserId!)
  await createAgentViaUi(alice, 'builder', pack.pluginPackId)
  await createAgentViaUi(alice, 'reviewer', pack.pluginPackId)

  // Task：Alice 创建并指派 Bob；Bob 真实浏览器登录并接受。
  await alice.goto('/')
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await alice.getByRole('button', { name: '创建任务' }).click()
  await alice.locator('input[id^="task-title-"]').fill('产出并复核验收报告')
  await alice.fill('input[id^="task-assignee-"]', shared.bobUserId)
  await alice.press('input[id^="task-assignee-"]', 'Enter')
  await alice.waitForURL(/\/tasks\//)
  const taskId = new URL(alice.url()).pathname.split('/').pop()
  if (taskId === undefined || taskId === '') throw new Error('Task URL 无法解析')
  shared.taskId = taskId

  const bob = await shared.bobContext!.newPage()
  shared.bob = bob
  await bob.goto('/login')
  await bob.fill('#login-username', 'bob')
  await fillAndEnter(bob, '#login-password', BOB_PASSWORD)
  await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await bob.goto(`/tasks/${shared.taskId}`)
  await bob.getByRole('button', { name: '接受任务' }).click()
  await expect(bob.getByText('你已接受此任务。')).toBeVisible()
  shared.bobCookie = await sessionCookie(shared.bobContext!)
}

async function createAgentViaUi(page: Page, name: string, pluginPackId: string): Promise<void> {
  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Agent 管理' })).toBeVisible()
  await page.fill('#agent-name', name)
  await page.fill('#agent-persona', '你是 E2E 验收代理。')
  await page.fill('#agent-provider', 'replay')
  await page.fill('#agent-model', 'replay-model')
  await page.fill('#agent-credential-slot', 'default')
  await page.selectOption('#agent-plugin-pack', pluginPackId)
  await page.getByRole('button', { name: '创建 Agent' }).click()
  await expect(page.getByText(name).first()).toBeVisible()
}

async function pairNodeViaUiAndControl(): Promise<void> {
  if (shared.deviceId !== undefined) return
  // 配对码：Bob 会话 HTTP 旁路（设备配对 UI 属后续版本）。
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
  await expect(bob.getByLabel('选择 Agent')).toBeVisible({ timeout: 30_000 })
  await bob.getByLabel('选择 Agent').selectOption({ label: agentName })
  await bob.getByLabel('选择设备').selectOption({ index: 1 })
  await expect(bob.getByLabel('选择 Workspace').locator('option').nth(1)).toBeAttached({
    timeout: 30_000,
  })
  await bob.getByLabel('选择 Workspace').selectOption({ index: 1 })
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

/** 点选时间线中的 Run 行 → RunLivePanel（事件流走 realtime 键，真人路径）。 */
async function selectRun(page: Page, runId: string): Promise<void> {
  await page
    .locator('.run-item-button')
    .filter({ hasText: `Run ${runId.slice(0, 8)}` })
    .click()
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
    await expect(shared.bob!.getByTestId('approval-decided')).toContainText('已批准一次')

    // Runtime 继续 → 完成（DB 事实判定；UI 徽标经 reload 核验）。
    const done = await waitForRunStatus(runId, 'completed', 120_000)
    await shared.bob!.reload()
    await expect(shared.bob!.getByText('已完成').first()).toBeVisible({ timeout: 30_000 })
    expect(done.artifacts.length).toBe(1)
    shared.artifactId = done.artifacts[0]!.id
    await releaseRuntime(runId) // 终态已确认：回收 Runtime 进程（容量留给后续场景）。
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
    await releaseRuntime(runId)

    // 判定（Node 侧观测缝）：Reviewer 输入按清单受控消费，不继承 Builder Workspace。
    const manifest = await inputManifestForRun(runId)
    const builderArtifact = (await getRunFact(shared.builderRunId!)).artifacts[0]!
    expect(manifest.manifestText).toContain(builderArtifact.sha256)
    expect(manifest.manifestText).toContain('runtime-inputs')
    // 不继承 Builder Workspace：清单文本不得携带 node 工作区目录形态。
    expect(manifest.manifestText).not.toContain(join('state', 'workspace'))
  })

  test('G4-04 两浏览器 frame diff：Bob 见脱敏全文事件流，Alice 只见脱敏阶段', async () => {
    test.setTimeout(240_000)
    await setRuntimeFixture('basic')
    await shared.bob!.reload()
    const runId = await startRunViaUi('builder', 'hello replay')
    await waitForRunStatus(runId, 'completed', 120_000)

    // Bob（owner）：事件流含 owner 行（assistant.message 全文只在 owner 受众投影）。
    await selectRun(shared.bob!, runId)
    await expect(shared.bob!.getByTestId('run-live-events')).toContainText('Hello from replay.', {
      timeout: 30_000,
    })
    expect(await shared.bob!.locator('.run-event.audience-owner').count()).toBeGreaterThanOrEqual(5)

    // Alice（成员）：同一动作——服务端受众过滤后，owner 行零出现，只见缩水产品。
    await shared.alice!.reload()
    await selectRun(shared.alice!, runId)
    const aliceEvents = shared.alice!.getByTestId('run-live-events')
    await expect(aliceEvents).toBeVisible({ timeout: 30_000 })
    await expect(aliceEvents.locator('.run-event.audience-project').first()).toBeVisible()
    expect(await aliceEvents.locator('.run-event.audience-owner').count()).toBe(0)
    const aliceText = await aliceEvents.innerText()
    expect(aliceText).toContain('DSH 运行时就绪') // 缩水流确有内容（脱敏而非空缺）
    // 注：project 受众同样携带 run.phase 缩水行（03 §8：阶段对团队可见），
    // 差异点在 assistant.message / tool 预览 / approval 正文——上面按受众行核验。
    await releaseRuntime(runId)
    await setRuntimeFixture('approval')
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
    await releaseRuntime(runId)
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
        if (Date.now() > deadline) throw new Error(`未在 lease 窗口内标 lost（当前 ${f.run.status}）`)
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
    await releaseRuntime(runId) // Runtime 进程仍在等审批：显式回收（不重放工具）。
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
    const runId = await startRunViaUi('builder', 'R8：提交后崩溃')
    // 崩溃注入：run.start 已提交（POST 201 + outbox 行同事务）后立刻 SIGKILL。
    await restartHub({ signal: 'SIGKILL', stayDownMs: 2_000 })
    await sleep(1_500)

    // 判定：worker 重启后继续派发，Run 必然离开 queued 并走到可审批态。
    await waitForRunStatus(runId, 'waiting_approval', 120_000)
    const queued = await getRunFact(runId)
    expect(queued.run.status).not.toBe('queued')

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
    if (fact.approvals.length > 0) {
      const denied = await hubApi(shared.bobCookie!, 'POST', `/approvals/${fact.approvals[0]!.id}/decisions`, {
        decision: 'allowed_once',
      })
      expect(denied.status).toBe(409)
    }
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

    // UI 呈现：血缘提示「由 Run <前8位> 重跑」（reload 取新快照后再点选）。
    await shared.bob!.reload()
    await selectRun(shared.bob!, newRunId)
    await expect(
      shared.bob!.getByTestId('run-live-panel').getByTestId('run-lineage'),
    ).toContainText(`由 Run ${sourceRunId!.slice(0, 8)} 重跑`)
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
  await releaseRuntime(runId)
}
