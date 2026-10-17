/**
 * #381 两成员交接闭环的生产验收（Q5，project `p1-381`）。
 *
 * 判的是整条产品闭环，一次走完：
 *   1. 后端成员（Alice）启用任务约定并确认 v1——执行前的共同依据；
 *   2. 业务 Run 正常完成 → **收尾自动整理**交接草稿（真实 replay 夹具脚本化那次
 *      模型调用）→ 责任人核对后发布为不可变 v1；
 *   3. deliver：选成员（Bob）、建同项目下游任务 → pending receipt；
 *   4. 前端成员（Bob）看到固定版本交接包 → 填「本次准备做什么」确认 → 上游讨论区
 *      留下差异（可选，本用例走纯确认路径）；确认不自动接受任务、不启动 Run；
 *   5. Bob 接受任务、配对自己的设备，执行区默认勾选「附带上游交接材料」→ 下游 Run
 *      以**固定交接输入**执行：材料按快照摘要下载（Node 副本文摘要 == 上游发布摘要）；
 *   6. 负向面：私有草稿对他人 404；重复确认不重复创建、不覆盖首次理解；上游发 v2
 *      **不改**任何历史 Run 的输入。
 *
 * 环境是正式装配：真 Hub（生产入口）+ 真 Node + 真 Runtime（DSH replay）。收尾整理
 * 的模型调用由 `scripts/fixtures/handoff-loop/` 的录制+旁车脚本化（与契约探针同一
 * 录制协议）。环境同时只支持一台 Node，故先跑 Alice 的后端 Run，再 SIGKILL 换 Bob 的
 * 设备（与 p1-345 同一限制、同一处理）。
 *
 * 事实落盘在 `artifacts/evidence/handoff-loop/result.json`，由
 * `scripts/verify-handoff-loop-evidence.mts` **独立重判**（缺证据/自相矛盾即 FAIL）——
 * 判定不看截图、不读日志尾巴。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertNotNativeSelect,
  env,
  fillAndEnter,
  hubApi,
  nodeControl,
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
const ALICE_NAME = `alice-hl-${RUN_TAG}`
const BOB_NAME = `bob-hl-${RUN_TAG}`
const AGENT_NAME = 'builder'
const EVIDENCE_DIR = join(process.cwd(), 'artifacts', 'evidence', 'handoff-loop')

interface RoomFact {
  task: { id: string; assignmentStatus: string; status: string }
  runs: Array<{ id: string; status: string }>
  artifacts: Array<{ id: string; status: string; sha256: string }>
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
  upstreamTaskId?: string
  upstreamRunId?: string
} = {}

const facts = {
  component: 'web.handoff-loop',
  source: 'production-hub-node-runtime',
  agreement: { enabled: false, confirmedRevisionNumber: 0 },
  backend: {} as Record<string, unknown>,
  privacy: {} as Record<string, unknown>,
  delivery: {} as Record<string, unknown>,
  confirm: {} as Record<string, unknown>,
  downstream: {} as Record<string, unknown>,
  updateIsolation: {} as Record<string, unknown>,
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

async function roomOf(cookie: string, taskId: string): Promise<RoomFact> {
  const res = await hubApi(cookie, 'GET', `/tasks/${taskId}`)
  expect(res.status).toBe(200)
  return res.data as RoomFact
}

async function waitDeviceOnline(
  cookie: string,
  deviceId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await hubApi(cookie, 'GET', '/devices')
    const devices = res.data as Array<{ id: string; status: string }>
    if (devices.find((d) => d.id === deviceId)?.status === 'online') return
    if (Date.now() > deadline) throw new Error(`设备未回在线（等待 ${timeoutMs}ms）`)
    await sleep(500)
  }
}

async function waitForFreshRunId(
  cookie: string,
  taskId: string,
  known: Set<string>,
): Promise<string> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const room = await roomOf(cookie, taskId)
    const fresh = room.runs.filter((r) => !known.has(r.id))
    if (fresh.length > 0) return fresh[0]!.id
    await sleep(250)
  }
  throw new Error('UI 启动的 Run 未出现在 Task Room 聚合中')
}

async function pairNodeFor(cookie: string): Promise<string> {
  const codeRes = await hubApi(cookie, 'POST', '/devices/pairing-codes', {})
  expect(codeRes.status).toBe(201)
  const node = await startNode({ pairingCode: (codeRes.data as { code: string }).code })
  await waitDeviceOnline(cookie, node.deviceId)
  return node.deviceId
}

async function startRunViaUi(
  page: Page,
  cookie: string,
  taskId: string,
  promptText: string,
): Promise<string> {
  await page.reload()
  const agentTrigger = page.getByLabel('选择 Agent')
  await expect(agentTrigger).toBeVisible({ timeout: 30_000 })
  await assertNotNativeSelect(agentTrigger, page.locator('.run-launcher'), '选择 Agent')
  // 基线集合必须在**点击之前**取——Run 起得快，点击后取会把新 Run 也算进「已知」
  //（首轮实测踩到：运行已 Completed，判据还在等一个「新的」）。
  const known = new Set((await roomOf(cookie, taskId)).runs.map((r) => r.id))
  await selectFromMenu(agentTrigger, AGENT_NAME)
  await selectFromMenu(page.getByLabel('选择设备'), /e2e-node（在线）/)
  await selectFromMenu(page.getByLabel('选择 Workspace'), 'e2e-ws')
  await page.getByLabel('指令').fill(promptText)
  await page.getByRole('button', { name: '开始执行' }).click()
  // 完全权限是显式放权：发送前有一次确认（真人路径）；普通档位下没有这一步。
  const confirmDialog = page.getByRole('dialog')
  if (await confirmDialog.isVisible().catch(() => false)) {
    await confirmDialog.getByRole('button', { name: /确认以完全权限启动/ }).click()
  }
  await expect(page.locator('.run-item').first()).toBeVisible()
  return waitForFreshRunId(cookie, taskId, known)
}

test('后端交付 → 前端接收 → 固定输入执行 → 真人验收（含负向面）', async () => {
  test.setTimeout(420_000)
  const alice = await shared.aliceContext!.newPage()
  const bob = await shared.bobContext!.newPage()
  shared.alice = alice
  shared.bob = bob

  // ---------- 0. Setup：团队 + 成员 + Agent + 项目 ----------
  await alice.goto('/setup')
  await alice.fill('#setup-token', env().setupToken)
  await alice.fill('#team-name', `交接闭环团队 ${RUN_TAG}`)
  await alice.fill('#setup-username', ALICE_NAME)
  await alice.fill('#setup-display-name', 'Alice')
  await fillAndEnter(alice, '#setup-password', PASSWORD)
  await expect(alice.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  await alice.getByRole('button', { name: '新建项目' }).click()
  await fillAndEnter(alice, '#project-name', '跨成员交接项目')
  shared.aliceCookie = await sessionCookie(shared.aliceContext!)
  const me = await hubApi(shared.aliceCookie, 'GET', '/auth/session')
  shared.aliceUserId = (me.data as { userId: string }).userId

  const invite = await hubApi(shared.aliceCookie, 'POST', '/invites', { role: 'member' })
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

  const pack = await seedPluginPack(shared.aliceUserId)
  expect(pack.pluginPackId).not.toBe('')

  // Agent 经真人 UI 创建（provider=replay 是 e2e 的模型缝）。
  await alice.goto('/agents')
  await expect(alice.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await alice.fill('#agent-name', AGENT_NAME)
  await alice.fill('#agent-persona', '你是验收代理。')
  await alice.fill('#agent-provider', 'replay')
  await alice.fill('#agent-model', 'replay-model')
  await alice.fill('#agent-credential-slot', 'default')
  await selectFromMenu(alice.locator('#agent-plugin-pack'), 'e2e-pack')
  // 完全权限（工具调用直接放行）：本用例判的是交接闭环，审批语义由 p1-19 / p1-345 覆盖；
  // 夹具主回合含一次 publish_artifact 工具调用（产出候选材料）。
  await selectFromMenu(alice.getByLabel('选择审批档位'), /完全权限/)
  await alice.getByRole('button', { name: '创建 Agent' }).click()
  await expect(alice.getByText(AGENT_NAME).first()).toBeVisible()

  // ---------- 1. 上游任务（Alice 自己负责的后端任务）----------
  await alice.goto('/')
  await alice.getByRole('button', { name: '创建任务' }).click()
  const createForm = alice.locator('form[aria-label="创建任务"]')
  await alice.locator('input[id^="task-title-"]').fill('实现登录接口')
  await selectFromMenu(createForm.locator('button[id^="task-assignee-"]'), /Alice/)
  await createForm.getByRole('button', { name: /创建任务/ }).click()
  await alice.waitForURL(/\/tasks\/[0-9a-f-]{36}/)
  shared.upstreamTaskId = new URL(alice.url()).pathname.split('/').pop()!
  await alice.getByRole('button', { name: '接受任务' }).click()
  await expect(alice.getByText('你已接受此任务。')).toBeVisible()

  // ---------- 2. 启用约定 + 起草并确认 v1 ----------
  await alice.getByRole('button', { name: '启用约定流程' }).click()
  await alice.getByRole('button', { name: '起草任务约定' }).click()
  const editor = alice.getByTestId('agreement-editor')
  await editor.getByLabel('任务约定：目标').fill('交付登录接口与用例')
  await editor.getByLabel('任务约定：验收条件').fill('单元测试通过')
  await editor.getByRole('button', { name: '保存为新草稿' }).click()
  await alice.getByRole('button', { name: /确认这一版/ }).click()
  await expect(alice.getByTestId('agreement-current')).toContainText('v1')
  facts.agreement = { enabled: true, confirmedRevisionNumber: 1 }

  // ---------- 3. 后端 Run：配 Node（handoff 夹具）→ 完成 → 收尾自动出草稿 ----------
  const aliceDeviceId = await pairNodeFor(shared.aliceCookie)
  await setRuntimeFixture('handoff')
  shared.upstreamRunId = await startRunViaUi(
    alice,
    shared.aliceCookie,
    shared.upstreamTaskId,
    '请实现登录接口与单元测试。',
  )
  await waitForRunStatus(shared.upstreamRunId, 'completed')

  // 材料发布（交接包的系统块只收已发布材料）。
  await alice.reload()
  await alice.locator(`.run-item-button[data-run-id="${shared.upstreamRunId}"]`).click()
  await expect(alice.getByTestId('artifact-publish-button')).toBeVisible({ timeout: 30_000 })
  await alice.getByTestId('artifact-publish-button').click()
  await alice.getByRole('button', { name: '确认发布给团队' }).click()
  const upstreamRoom = await roomOf(shared.aliceCookie, shared.upstreamTaskId)
  const publishedArtifact = upstreamRoom.artifacts.find((a) => a.status === 'published')
  expect(publishedArtifact).toBeDefined()

  // 收尾草稿：面板出现可编辑草稿（自动生成、单次调用），核对后发布 v1。
  const draftPanel = alice.getByTestId('handoff-draft')
  await expect(draftPanel).toBeVisible({ timeout: 30_000 })
  await expect(draftPanel.getByTestId('handoff-editor')).toBeVisible()
  await expect(draftPanel.getByText('仅你可见')).toBeVisible()
  await draftPanel.getByRole('button', { name: '发布交接包' }).click()
  await expect(draftPanel.getByTestId('handoff-draft-published')).toBeVisible({ timeout: 30_000 })
  const revisions = await hubApi(
    shared.aliceCookie,
    'GET',
    `/tasks/${shared.upstreamTaskId}/handoff-revisions`,
  )
  const revisionV1 = (revisions.data as Array<{ id: string; revisionNumber: number }>).find(
    (r) => r.revisionNumber === 1,
  )
  expect(revisionV1).toBeDefined()
  // 判定输入从**读面**取，不用字面量（评审 B10）：Run 状态取房间聚合的同一行，
  // 草稿来源/状态取 GET /runs/:id/handoff-draft（发布后是 published 审计行）。
  const backendRunStatus = upstreamRoom.runs.find((r) => r.id === shared.upstreamRunId)?.status
  expect(backendRunStatus).toBe('completed')
  const draftRead = await hubApi(
    shared.aliceCookie,
    'GET',
    `/runs/${shared.upstreamRunId}/handoff-draft`,
  )
  expect(draftRead.status).toBe(200)
  const draftFact = draftRead.data as { origin: string; status: string }
  facts.backend = {
    taskId: shared.upstreamTaskId,
    runId: shared.upstreamRunId,
    runStatus: backendRunStatus,
    draftOrigin: draftFact.origin,
    draftStatus: draftFact.status,
    publishedRevisionNumber: 1,
    artifactId: publishedArtifact!.id,
    artifactSha256: publishedArtifact!.sha256,
    artifactPublished: true,
  }

  // ---------- 4. 负向：私有草稿对他人 404（存在性都不泄露）----------
  // 先让 Bob 登录（后面的接收/执行都在同一个会话上下文里），再做对照读取——
  // 404 必须是「已登录成员但非 owner」的结果，不是「没登录」的幌子。
  await bob.goto('/login')
  await bob.fill('#login-username', BOB_NAME)
  await fillAndEnter(bob, '#login-password', PASSWORD)
  await expect(bob.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
  shared.bobCookie = await sessionCookie(shared.bobContext!)
  const ownerRead = await hubApi(
    shared.aliceCookie,
    'GET',
    `/runs/${shared.upstreamRunId}/handoff-draft`,
  )
  const memberRead = await hubApi(
    shared.bobCookie,
    'GET',
    `/runs/${shared.upstreamRunId}/handoff-draft`,
  )
  facts.privacy = { ownerReadStatus: ownerRead.status, otherMemberReadStatus: memberRead.status }
  expect(ownerRead.status).toBe(200)
  expect(memberRead.status).toBe(404)

  // ---------- 5. 交付给 Bob（建下游任务）----------
  await alice.reload()
  const deliveryPanel = alice.getByTestId('handoff-delivery-panel')
  await expect(deliveryPanel).toBeVisible({ timeout: 30_000 })
  await selectFromMenu(deliveryPanel.getByLabel('交接版本'), /v1/)
  await selectFromMenu(deliveryPanel.getByLabel('交付给'), /Bob/)
  await deliveryPanel.getByLabel('新任务标题').fill('前端接入登录页')
  await deliveryPanel.getByRole('button', { name: '交付给该成员' }).click()
  await expect(alice.getByTestId('handoff-delivery-list')).toContainText('前端接入登录页')
  await expect(alice.getByTestId('handoff-delivery-list')).toContainText('待确认')
  const deliveries = await hubApi(
    shared.aliceCookie,
    'GET',
    `/tasks/${shared.upstreamTaskId}/handoff-deliveries`,
  )
  const receipt = (
    deliveries.data as Array<{
      id: string
      downstreamTaskId: string
      receiverUserId: string
      status: string
      revisionNumber: number
    }>
  )[0]!
  expect(receipt.revisionNumber).toBe(1)
  facts.delivery = {
    receiptId: receipt.id,
    downstreamTaskId: receipt.downstreamTaskId,
    receiverUserId: receipt.receiverUserId,
    statusAfterDeliver: receipt.status,
    deliveriesRows: (deliveries.data as unknown[]).length,
  }

  // ---------- 6. Bob 确认接收（不自动接受任务/不启动 Run）+ 重复确认幂等 ----------
  await bob.goto(`/tasks/${receipt.downstreamTaskId}`)
  const receiptPanel = bob.getByTestId('handoff-receipt-panel')
  await expect(receiptPanel).toBeVisible({ timeout: 30_000 })
  await expect(receiptPanel).toContainText('待确认版本 v1')
  await receiptPanel.getByLabel('确认接收：本次准备做什么').fill('先接登录页，复用会话中间件。')
  await receiptPanel.getByRole('button', { name: '确认接收（不动任务状态）' }).click()
  await expect(bob.getByTestId('handoff-receipt-active')).toBeVisible({ timeout: 30_000 })
  const roomAfterConfirm = await roomOf(shared.bobCookie, receipt.downstreamTaskId)
  expect(roomAfterConfirm.task.assignmentStatus).toBe('pending')
  expect(roomAfterConfirm.runs).toHaveLength(0)
  // 重复确认（新幂等键）：不重复创建、不覆盖首次理解。
  const repeatConfirm = await hubApi(
    shared.bobCookie,
    'POST',
    `/handoff-receipts/${receipt.id}/confirm`,
    { understanding: '改口：先做订单详情' },
  )
  expect(repeatConfirm.status).toBe(200)
  const deliveriesAfterRepeat = await hubApi(
    shared.aliceCookie,
    'GET',
    `/tasks/${shared.upstreamTaskId}/handoff-deliveries`,
  )
  const rowsAfterRepeat = deliveriesAfterRepeat.data as Array<{
    understanding: string | null
  }>
  facts.confirm = {
    statusAfterConfirm: 'confirmed',
    understandingFirst: '先接登录页，复用会话中间件。',
    assignmentStatusAfterConfirm: roomAfterConfirm.task.assignmentStatus,
    runsAfterConfirm: roomAfterConfirm.runs.length,
    repeatConfirmStatus: repeatConfirm.status,
    rowsAfterRepeatConfirm: rowsAfterRepeat.length,
    understandingAfterRepeatConfirm: rowsAfterRepeat[0]?.understanding ?? null,
  }

  // ---------- 7. Bob 接受任务、换配对自己的设备、默认勾选交接材料后执行 ----------
  await bob.reload()
  await bob.getByRole('button', { name: '接受任务' }).click()
  await expect(bob.getByText('你已接受此任务。')).toBeVisible()
  await stopNode('SIGKILL')
  const bobDeviceId = await pairNodeFor(shared.bobCookie)
  expect(bobDeviceId).toBeTruthy()
  await setRuntimeFixture('basic')
  await bob.reload()
  const attach = bob.getByTestId('handoff-attach')
  await expect(attach).toBeVisible({ timeout: 30_000 })
  await expect(bob.getByLabel('附带上游交接材料')).toBeChecked()
  const downstreamRunId = await startRunViaUi(
    bob,
    shared.bobCookie,
    receipt.downstreamTaskId,
    '请按上游交接包接入登录页。',
  )
  await waitForRunStatus(downstreamRunId, 'completed')

  // ---------- 8. 固定交接输入：Hub 快照 == 上游发布；Node 副本实字节 == 快照摘要 ----------
  const handoffInputRes = await hubApi(
    shared.bobCookie,
    'GET',
    `/runs/${downstreamRunId}/handoff-input`,
  )
  expect(handoffInputRes.status).toBe(200)
  const handoffInput = handoffInputRes.data as {
    upstreamTaskId: string
    revisionNumber: number
    revisionId: string
    artifacts: Array<{ artifactId: string; sha256: string }>
  }
  const nodeInputs = await nodeControl<{
    copied: Array<{ artifactId: string; sha256: string; fileSha256: string | null }>
  }>('/input-manifest', { runId: downstreamRunId })
  const copiedForArtifact = nodeInputs.copied.find((c) => c.artifactId === publishedArtifact!.id)
  expect(copiedForArtifact).toBeDefined()
  facts.downstream = {
    runId: downstreamRunId,
    checkboxDefaultChecked: true,
    handoffInput: {
      upstreamTaskId: handoffInput.upstreamTaskId,
      revisionNumber: handoffInput.revisionNumber,
      artifactId: handoffInput.artifacts[0]?.artifactId,
      sha256: handoffInput.artifacts[0]?.sha256,
    },
    nodeCopy: {
      artifactId: copiedForArtifact!.artifactId,
      sha256: copiedForArtifact!.sha256,
      fileSha256: copiedForArtifact!.fileSha256,
    },
  }

  // ---------- 9. 负向：上游发 v2 不改历史 Run 输入 ----------
  const manual = await hubApi(
    shared.aliceCookie,
    'POST',
    `/runs/${shared.upstreamRunId}/handoff-draft`,
    {},
  )
  expect(manual.status).toBe(201)
  const draftView = manual.data as {
    draftVersion: number
    content: { narrative: Record<string, unknown> } | null
  }
  const patched = await hubApi(
    shared.aliceCookie,
    'PATCH',
    `/runs/${shared.upstreamRunId}/handoff-draft`,
    {
      expectedDraftVersion: draftView.draftVersion,
      narrative: {
        ...(draftView.content?.narrative ?? {}),
        unfinished: [{ text: '字段命名待对齐', verified: false, refs: [] }],
      },
    },
  )
  expect(patched.status).toBe(200)
  const publishedV2 = await hubApi(
    shared.aliceCookie,
    'POST',
    `/runs/${shared.upstreamRunId}/handoff-draft/publish`,
    {},
  )
  expect(publishedV2.status).toBe(201)
  const latestNumber = (publishedV2.data as { revisionNumber: number }).revisionNumber ?? 0
  expect(latestNumber).toBe(2)
  const afterV2 = await hubApi(shared.bobCookie, 'GET', `/runs/${downstreamRunId}/handoff-input`)
  const afterV2Input = afterV2.data as { revisionId: string; revisionNumber: number }
  const receiptsAfterV2 = await hubApi(
    shared.bobCookie,
    'GET',
    `/tasks/${receipt.downstreamTaskId}/handoff-receipts`,
  )
  facts.updateIsolation = {
    runId: downstreamRunId,
    latestRevisionNumber: latestNumber,
    receiptsRowsAfterV2: (receiptsAfterV2.data as unknown[]).length,
    runInputRevisionNumberAfterV2: afterV2Input.revisionNumber,
    runInputRevisionIdBeforeV2: handoffInput.revisionId,
    runInputRevisionIdAfterV2: afterV2Input.revisionId,
  }
  // 下游看到「有新版本」的判据（latest > 活跃 receipt 的版本）在列表里如实上报。
  const latestReported = (
    receiptsAfterV2.data as Array<{ latestRevisionNumber: number; revisionNumber: number }>
  )[0]!
  expect(latestReported.latestRevisionNumber).toBe(2)
  expect(latestReported.revisionNumber).toBe(1)
})
