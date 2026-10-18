import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  env,
  fillAndEnter,
  getRunFact,
  hubApi,
  seedPluginPack,
  selectFromMenu,
  sessionCookie,
  startNode,
  waitForRunStatus,
} from './helpers.js'

test('拒绝 → 网页重新指派 → 新责任人接受 → 在自己的环境执行', async ({ browser }) => {
  test.setTimeout(180_000)
  const tag = randomUUID().slice(0, 8)
  const password = 'correct horse battery staple'
  const ownerContext = await browser.newContext()
  const memberContext = await browser.newContext()
  try {
    const owner = await ownerContext.newPage()
    const member = await memberContext.newPage()
    await owner.goto('/setup')
    await owner.fill('#setup-token', env().setupToken)
    await owner.fill('#team-name', `改派验收 ${tag}`)
    await owner.fill('#setup-username', `alice-${tag}`)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', password)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    const cookie = await sessionCookie(ownerContext)
    const alice = (await hubApi(cookie, 'GET', '/auth/session')).data as { userId: string }
    const invite = await hubApi(cookie, 'POST', '/invites', { role: 'member' })
    const joined = await fetch(`${env().hubOrigin}/api/v1/invites/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env().webOrigin,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        token: (invite.data as { token: string }).token,
        username: `bob-${tag}`,
        displayName: 'Bob',
        password,
      }),
    })
    expect(joined.status).toBe(201)
    await member.goto('/login')
    await member.fill('#login-username', `bob-${tag}`)
    await fillAndEnter(member, '#login-password', password)
    await expect(member.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await owner.getByRole('button', { name: '新建项目' }).click()
    await fillAndEnter(owner, '#project-name', '改派项目')
    await owner.getByRole('button', { name: '创建任务' }).click()
    await owner.locator('input[id^="task-title-"]').fill('重新接手并执行')
    await selectFromMenu(owner.locator('button[id^="task-assignee-"]'), /Bob/)
    await owner.getByRole('button', { name: '创建任务', exact: true }).click()
    await owner.waitForURL(/\/tasks\//)
    const taskId = new URL(owner.url()).pathname.split('/').pop()!
    await member.goto(`/tasks/${taskId}`)
    await member.getByRole('button', { name: '拒绝任务' }).click()
    await expect(member.getByText(/此任务已被拒绝/)).toBeVisible()
    await expect(member.getByRole('button', { name: '重新指派', exact: true })).toHaveCount(0)
    const denied = await hubApi(
      await sessionCookie(memberContext),
      'POST',
      `/tasks/${taskId}/reassign`,
      { assigneeUserId: alice.userId },
    )
    expect(denied.status).toBe(403)
    await expect(owner.getByRole('button', { name: '重新指派', exact: true })).toBeVisible()
    await owner.getByRole('button', { name: '重新指派', exact: true }).click()
    await selectFromMenu(owner.getByLabel('新责任人'), /Alice/)
    await owner.getByRole('button', { name: '确认重新指派' }).click()
    await expect(owner.getByRole('button', { name: '接受任务' })).toBeVisible()
    const pending = (await hubApi(cookie, 'GET', `/tasks/${taskId}`)).data as {
      task: { assignmentStatus: string; assigneeUserId: string }
    }
    expect(pending.task.assignmentStatus).toBe('pending')
    expect(pending.task.assigneeUserId).toBe(alice.userId)
    await owner.getByRole('button', { name: '接受任务' }).click()
    await expect(owner.getByTestId('task-assignment-state')).toHaveText('已接受')

    // 接手后的执行走新责任人自己的 Node，不借用旧成员现场。
    await seedPluginPack(alice.userId)
    await owner.goto('/agents')
    await owner.fill('#agent-name', 'Builder')
    await owner.fill('#agent-persona', '你是验收代理。')
    await owner.fill('#agent-provider', 'replay')
    await owner.fill('#agent-model', 'replay-model')
    await selectFromMenu(owner.locator('#agent-plugin-pack'), 'e2e-pack')
    await owner.getByRole('button', { name: '创建 Agent' }).click()
    await expect(owner.getByText('Builder').first()).toBeVisible()
    const pairing = await hubApi(cookie, 'POST', '/devices/pairing-codes', {})
    const node = await startNode({ pairingCode: (pairing.data as { code: string }).code })
    await owner.goto(`/tasks/${taskId}`)
    await selectFromMenu(owner.getByLabel('选择 Agent'), 'Builder')
    await selectFromMenu(owner.getByLabel('选择设备'), /e2e-node（在线）/)
    await selectFromMenu(owner.getByLabel('选择 Workspace'), 'e2e-ws')
    await owner.getByLabel('指令', { exact: true }).fill('接手后生成交付物')
    await owner.getByRole('button', { name: '开始执行' }).click()
    const row = owner.locator('button[data-run-id]').first()
    await expect(row).toBeVisible()
    const runId = (await row.getAttribute('data-run-id'))!
    await waitForRunStatus(runId, 'waiting_approval')
    await owner.getByTestId('approve-button').click()
    await waitForRunStatus(runId, 'completed')
    const fact = await getRunFact(runId)
    expect(fact.run.ownerUserId).toBe(alice.userId)
    const placement = (await hubApi(cookie, 'GET', `/runs/${runId}`)).data as { deviceId: string }
    expect(placement.deviceId).toBe(node.deviceId)
    const evidence = join(process.cwd(), 'artifacts', 'evidence', 'task-reassignment')
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          component: 'web.assignment',
          taskId,
          rejectedMemberForbidden: denied.status,
          pendingAssignment: pending.task.assignmentStatus,
          assigneeUserId: pending.task.assigneeUserId,
          runId,
          runOwnerUserId: fact.run.ownerUserId,
          deviceId: placement.deviceId,
          status: fact.run.status,
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
