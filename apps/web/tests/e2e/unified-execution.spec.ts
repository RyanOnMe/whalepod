import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  env,
  fillAndEnter,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  startNode,
  waitForRunStatus,
  waitForRuntimeReleased,
} from './helpers.js'

const preparationEvidence = join(process.cwd(), 'artifacts', 'evidence', 'preparation-return')
// Before browser fixtures and any driver step: a failed attempt must have no previous success.
test.beforeAll(async () => {
  await rm(join(preparationEvidence, 'result.json'), { force: true })
})

test('唯一执行入口：首次启动 → 结束保留追问草稿 → 显式续跑来源会话', async ({ browser }) => {
  test.setTimeout(180_000)
  const tag = randomUUID().slice(0, 8)
  const password = 'correct horse battery staple'
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const memberContext = await browser.newContext()
  try {
    const owner = await ownerContext.newPage()
    const member = await memberContext.newPage()
    await owner.goto('/setup')
    await owner.fill('#setup-token', env().setupToken)
    await owner.fill('#team-name', `执行验收 ${tag}`)
    await owner.fill('#setup-username', `owner-${tag}`)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', password)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    const cookie = await sessionCookie(ownerContext)
    const alice = (await hubApi(cookie, 'GET', '/auth/session')).data as { userId: string }
    const invite = await hubApi(cookie, 'POST', '/invites', { role: 'member' })
    expect(
      (
        await fetch(`${env().hubOrigin}/api/v1/invites/accept`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: env().webOrigin,
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            token: (invite.data as { token: string }).token,
            username: `member-${tag}`,
            displayName: 'Bob',
            password,
          }),
        })
      ).status,
    ).toBe(201)
    await member.goto('/login')
    await member.fill('#login-username', `member-${tag}`)
    await fillAndEnter(member, '#login-password', password)
    await expect(member.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await seedPluginPack(alice.userId)
    await owner.goto('/agents')
    await owner.fill('#agent-name', 'Builder')
    await owner.fill('#agent-persona', '你是执行验收代理。')
    await owner.fill('#agent-provider', 'replay')
    await owner.fill('#agent-model', 'replay-model')
    await selectFromMenu(owner.locator('#agent-plugin-pack'), 'e2e-pack')
    await owner.getByRole('button', { name: '创建 Agent' }).click()
    await expect(owner.getByText('Builder').first()).toBeVisible()
    const pairing = await hubApi(cookie, 'POST', '/devices/pairing-codes', {})
    await startNode({ pairingCode: (pairing.data as { code: string }).code })
    await owner.goto('/')
    await owner.getByRole('button', { name: '新建项目' }).click()
    await fillAndEnter(owner, '#project-name', '统一执行验收')
    await owner.getByRole('button', { name: '创建任务' }).click()
    await owner.locator('input[id^="task-title-"]').fill('开始并继续同一会话')
    await owner.getByRole('button', { name: '创建任务', exact: true }).click()
    await owner.waitForURL(/\/tasks\//)
    const taskId = new URL(owner.url()).pathname.split('/').pop()!
    await owner.getByRole('button', { name: '接受任务' }).click()
    await expect(owner.getByText('你已接受此任务。')).toBeVisible()
    await member.goto(`/tasks/${taskId}`)
    await expect(member.getByTestId('execution-responsibility')).toContainText('Alice')
    await member.getByRole('link', { name: '前往讨论' }).click()
    await expect(member.locator('#comments-heading')).toBeFocused()
    await expect(member.getByTestId('execution-blocker')).toContainText('只有责任人和已授权成员')
    await expect(member.getByLabel('指令', { exact: true })).toHaveCount(0)
    const execute = owner.locator('[aria-labelledby="instructions-heading"]')
    await expect(execute.locator('textarea')).toHaveCount(1)
    await selectFromMenu(owner.getByLabel('选择 Agent'), 'Builder')
    let instructionPosts = 0
    let preparationPosts = 0
    owner.on('request', (request) => {
      if (request.method() !== 'POST') return
      if (request.url().endsWith(`/tasks/${taskId}/instructions`)) instructionPosts++
      if (request.url().endsWith(`/tasks/${taskId}/preparation-check`)) preparationPosts++
    })
    await owner.getByRole('button', { name: '检查本次准备条件' }).click()
    await expect(owner.getByTestId('preparation-status')).toContainText(
      '本机已配置；未验证模型调用',
    )
    await expect(owner.getByTestId('preparation-status')).toContainText('已确认可用')
    await expect(owner.getByTestId('preparation-status')).toContainText('已过期', {
      timeout: 35_000,
    })
    const secondCheck = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/preparation-check`) &&
        response.request().method() === 'POST',
    )
    await owner.getByRole('button', { name: '检查本次准备条件' }).click()
    await expect(owner.getByTestId('preparation-status')).toContainText(
      '本机已配置；未验证模型调用',
    )
    expect(
      ((await hubApi(cookie, 'GET', `/tasks/${taskId}`)).data as { runs: unknown[] }).runs,
    ).toHaveLength(0)
    await owner.getByRole('button', { name: '填入试运行指令' }).click()
    await expect(owner.getByLabel('指令', { exact: true })).toHaveValue(
      '请用一句话确认你已收到这条试运行指令，不需要调用工具或修改文件。',
    )

    // The production check fixed the concrete target; navigation must retain those identities.
    const selectionBefore = (await secondCheck).request().postDataJSON() as {
      agentId: string
      profileRevisionId: string
      deviceId: string
      workspaceId: string
    }
    for (const value of Object.values(selectionBefore)) expect(value).toMatch(/^[0-9a-f-]{36}$/i)
    const labelsBefore = await owner
      .locator(
        '#run-agent-value, #run-revision-value, #target-device-value, #target-workspace-value',
      )
      .allTextContents()
    const returnDraft = '生成候选报告'
    await owner.getByLabel('指令', { exact: true }).fill(returnDraft)
    await expect(owner.getByLabel('执行方式')).toContainText('开始新执行')
    const instructionPostsBeforeNavigation = instructionPosts
    const preparationPostsBeforeNavigation = preparationPosts
    await owner.getByRole('link', { name: '安装并配对执行服务' }).click()
    await expect(owner.getByRole('link', { name: '返回任务继续准备' })).toHaveAttribute(
      'href',
      `/tasks/${taskId}#task-execution`,
    )
    await owner.getByRole('link', { name: '返回任务继续准备' }).click()
    await expect(owner.locator('#task-execution')).toBeFocused()
    await expect(owner.getByLabel('指令', { exact: true })).toHaveValue(returnDraft)
    await expect(owner.getByLabel('执行方式')).toContainText('开始新执行')
    await expect(owner.getByTestId('preparation-status')).toContainText('本次准备条件尚未确认')
    await expect(owner.getByRole('button', { name: '开始执行' })).toBeEnabled()
    expect(
      await owner
        .locator(
          '#run-agent-value, #run-revision-value, #target-device-value, #target-workspace-value',
        )
        .allTextContents(),
    ).toEqual(labelsBefore)
    const instructionPostsAfterNavigation = instructionPosts
    const preparationPostsAfterNavigation = preparationPosts
    expect(instructionPostsAfterNavigation).toBe(0)
    expect(instructionPostsAfterNavigation).toBe(instructionPostsBeforeNavigation)
    expect(preparationPostsAfterNavigation).toBe(preparationPostsBeforeNavigation)
    const returnCheck = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/preparation-check`) &&
        response.request().method() === 'POST',
    )
    await owner.getByRole('button', { name: '检查本次准备条件' }).click()
    const selectionAfter = (await returnCheck).request().postDataJSON() as typeof selectionBefore
    expect(selectionAfter).toEqual(selectionBefore)
    await expect(owner.getByTestId('preparation-status')).toContainText('已确认可用')
    await expect(owner.getByRole('button', { name: '开始执行' })).toBeEnabled()
    const startResponse = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/instructions`) &&
        response.request().method() === 'POST',
    )
    await owner.getByRole('button', { name: '开始执行' }).click()
    const firstReply = await startResponse
    expect(firstReply.status()).toBe(201)
    const submitted = firstReply.request().postDataJSON() as typeof selectionBefore & {
      text: string
    }
    const submittedSelection = Object.fromEntries(
      Object.keys(selectionBefore).map((key) => [key, submitted[key as keyof typeof submitted]]),
    )
    expect(submittedSelection).toEqual(selectionBefore)
    expect(submitted.text).toBe(returnDraft)
    const explicitInstructionPosts = instructionPosts - instructionPostsAfterNavigation
    expect(explicitInstructionPosts).toBe(1)
    const firstRunId = (await firstReply.json()).data.runId as string
    await waitForRunStatus(firstRunId, 'waiting_approval')
    await expect(owner.getByRole('button', { name: '提交验收', exact: true })).toBeDisabled()
    await expect(owner.getByTestId('review-condition')).toContainText('执行仍在进行')

    // 真实权限页授予，再在审批窗口排队；撤销后不让该句进入Node。
    await owner.goto(`/tasks/${taskId}/permissions`)
    await selectFromMenu(owner.getByLabel('授权给'), /Bob/)
    await owner.getByRole('button', { name: '授权', exact: true }).click()
    await expect(owner.getByTestId('driver-revoke')).toBeVisible()
    await member.getByRole('button', { name: 'Agent 执行', exact: true }).click()
    await selectFromMenu(member.getByLabel('执行方式'), /发送追问/)
    const memberDraft = member.getByLabel('指令', { exact: true })
    await memberDraft.fill('撤销前排队的协作者追问')
    const queuedResponse = member.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/instructions`) &&
        response.request().method() === 'POST',
    )
    await member.getByRole('button', { name: '发送追问', exact: true }).click()
    expect((await (await queuedResponse).json()).data.outcome).toBe('queued')
    await memberDraft.fill('保留撤销时正在编辑的草稿')
    await owner.getByTestId('driver-revoke').click()
    await expect(memberDraft).toBeDisabled()
    await expect(memberDraft).toHaveValue('保留撤销时正在编辑的草稿')
    await expect(member.getByTestId('instruction-error')).toContainText('发送者已失去指令权限')
    await owner.goto(`/tasks/${taskId}`)

    const draft = '请保留上文继续检查'
    const box = owner.getByLabel('指令', { exact: true })
    await expect(owner.getByRole('button', { name: '发送追问' })).toBeEnabled()
    await box.fill(draft)
    await owner.getByTestId('approve-button').click()
    const completedFirst = await waitForRunStatus(firstRunId, 'completed')
    await waitForRuntimeReleased(firstRunId)
    await expect(owner.getByTestId('execution-blocker')).toContainText('草稿仍保留')
    await expect(box).toHaveValue(draft)
    await expect(owner.getByRole('button', { name: '发送追问' })).toBeDisabled()
    const before = (await hubApi(cookie, 'GET', `/runs/${firstRunId}`)).data as {
      agentId: string
      dshSessionId: string
      profileRevisionId: string
      deviceId: string
      workspaceId: string
    }
    const actualSelection = {
      agentId: before.agentId,
      profileRevisionId: before.profileRevisionId,
      deviceId: before.deviceId,
      workspaceId: before.workspaceId,
    }
    expect(actualSelection).toEqual(selectionBefore)
    await selectFromMenu(owner.getByLabel('执行方式'), /继续会话/)
    await expect(owner.getByLabel('指令', { exact: true })).toHaveValue(draft)
    await expect(owner.getByRole('button', { name: '继续会话', exact: true })).toBeEnabled()
    const resumeResponse = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/instructions`) &&
        response.request().method() === 'POST',
    )
    await owner.getByRole('button', { name: '继续会话', exact: true }).click()
    const continuedReply = await resumeResponse
    expect(continuedReply.status()).toBe(201)
    const resumedRunId = (await continuedReply.json()).data.runId as string
    expect(resumedRunId).not.toBe(firstRunId)
    await waitForRunStatus(resumedRunId, 'waiting_approval')
    await owner.getByTestId('approve-button').click()
    await waitForRunStatus(resumedRunId, 'completed')
    const after = (await hubApi(cookie, 'GET', `/runs/${resumedRunId}`)).data as {
      resumeFromRunId: string
      dshSessionId: string
      profileRevisionId: string
      deviceId: string
      workspaceId: string
    }
    expect(before.dshSessionId).toEqual(expect.any(String))
    expect(before.dshSessionId.length).toBeGreaterThan(0)
    expect(after.resumeFromRunId).toBe(firstRunId)
    expect(after.dshSessionId).toBe(before.dshSessionId)
    expect(after.profileRevisionId).toBe(before.profileRevisionId)
    expect(after.deviceId).toBe(before.deviceId)
    expect(after.workspaceId).toBe(before.workspaceId)
    await expect(owner.getByRole('button', { name: '提交验收', exact: true })).toBeDisabled()
    await expect(owner.getByTestId('review-condition')).toContainText('发布至少一个交付物')
    await mkdir(preparationEvidence, { recursive: true })
    await writeFile(
      join(preparationEvidence, 'result.json'),
      JSON.stringify(
        {
          component: 'web.preparation.return',
          source: 'production-http-ws-node-runtime',
          verifiedAt: new Date().toISOString(),
          taskId,
          acceptedRunId: firstRunId,
          selectionBefore,
          selectionAfter,
          submittedSelection,
          actualSelection,
          targetId: 'task-execution',
          focusedTargetId: 'task-execution',
          draftPreserved: true,
          modeBefore: 'new',
          modeAfter: 'new',
          submittedDraftMatches: submitted.text === returnDraft,
          preparationBefore: 'confirmed',
          preparationAfter: 'unconfirmed',
          instructionPostsBeforeNavigation,
          instructionPostsAfterNavigation,
          preparationPostsBeforeNavigation,
          preparationPostsAfterNavigation,
          explicitInstructionPosts,
          runtimeRunStatus: completedFirst.run.status,
          humanUsability: 'not_measured',
          provider: 'replay',
        },
        null,
        2,
      ),
    )
    const evidence = join(process.cwd(), 'artifacts', 'evidence', 'unified-execution')
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          component: 'web.execution',
          verifiedAt: new Date().toISOString(),
          attemptId: tag,
          taskId,
          firstRunId,
          resumedRunId,
          resumeFromRunId: after.resumeFromRunId,
          uniqueInput: 1,
          preparationCheckedByProductionNode: true,
          preparationCreatesNoRun: true,
          trialOnlyPrefillsDraft: true,
          preparationExpiresAndRechecks: true,

          queuedMemberRejectedBeforeApproval: true,
          revokedMemberDraftPreserved: true,
          staleDraftPreserved: true,
          memberHasNoInstructionInput: true,
          reviewBlockedUntilPublished: true,
          activeRunBlocksReview: true,
          namedResponsibleAndDiscussionFocus: true,
          sourceRevisionKept: after.profileRevisionId === before.profileRevisionId,
          sourceDeviceKept: after.deviceId === before.deviceId,
          sourceWorkspaceKept: after.workspaceId === before.workspaceId,
          sessionIdentityKept: after.dshSessionId === before.dshSessionId,
        },
        null,
        2,
      ),
    )
  } finally {
    await ownerContext.close()
    await memberContext.close()
  }
})
