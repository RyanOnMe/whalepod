import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
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
    await expect(member.getByTestId('execution-blocker')).toContainText('只有责任人和已授权成员')
    await expect(member.getByLabel('指令', { exact: true })).toHaveCount(0)
    const execute = owner.locator('[aria-labelledby="instructions-heading"]')
    await expect(execute.locator('textarea')).toHaveCount(1)
    await selectFromMenu(owner.getByLabel('选择 Agent'), 'Builder')
    await owner.getByRole('button', { name: '检查本次准备条件' }).click()
    await expect(owner.getByTestId('preparation-status')).toContainText(
      '本机已配置；未验证模型调用',
    )
    await expect(owner.getByTestId('preparation-status')).toContainText('已确认可用')
    await expect(owner.getByTestId('preparation-status')).toContainText('已过期', {
      timeout: 35_000,
    })
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

    // 已就绪时沿用明确标注的自动环境，不要求首次再填另一张表单。
    await owner.getByLabel('指令', { exact: true }).fill('生成候选报告')
    await expect(owner.getByRole('button', { name: '开始执行' })).toBeEnabled()
    const startResponse = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${taskId}/instructions`) &&
        response.request().method() === 'POST',
    )
    await owner.getByRole('button', { name: '开始执行' }).click()
    const firstReply = await startResponse
    expect(firstReply.status()).toBe(201)
    const firstRunId = (await firstReply.json()).data.runId as string
    await waitForRunStatus(firstRunId, 'waiting_approval')
    const draft = '请保留上文继续检查'
    const box = owner.getByLabel('指令', { exact: true })
    await expect(owner.getByRole('button', { name: '发送追问' })).toBeEnabled()
    await box.fill(draft)
    await owner.getByTestId('approve-button').click()
    await waitForRunStatus(firstRunId, 'completed')
    await waitForRuntimeReleased(firstRunId)
    await expect(owner.getByTestId('execution-blocker')).toContainText('草稿仍保留')
    await expect(box).toHaveValue(draft)
    await expect(owner.getByRole('button', { name: '发送追问' })).toBeDisabled()
    const before = (await hubApi(cookie, 'GET', `/runs/${firstRunId}`)).data as {
      dshSessionId: string
      profileRevisionId: string
      deviceId: string
      workspaceId: string
    }
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
          staleDraftPreserved: true,
          memberHasNoInstructionInput: true,
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
