import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  grantInstruction,
  insertUser,
  listInstructionGrants,
  listMessages,
  resolveInstructionRight,
  revokeInstruction,
  schema,
  setRunStatus,
} from '@whalepod/db'
import { sendInstruction } from '../src/modules/run/instruction.js'
import { sendRunFollowup } from '../src/modules/run/followup.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
  type TestApp,
} from './helpers.js'

/**
 * P1-198 切片④：指令权授权——把「只有责任人能驱动 Agent」泛化成「责任人 ∪ 被授权成员」。
 *
 * 边界（本片刻意不放松的东西，逐条有判据）：
 *   * 授权**只**作用于执行区：讨论区任何成员都能评论，不需要授权；
 *   * **审批决定权不可授予**：被授权成员不能替责任人拍板；
 *   * **Run 归属永远是责任人**：被授权成员驱动时，设备/工作区仍是责任人的，owner 也不变。
 */
describe('instruction grants (P1-198)', () => {
  let database: Database
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  /** 造一个「非责任人的团队成员」——授权的对象。 */
  async function addMember(): Promise<string> {
    const id = randomUUID()
    await insertUser(database.db, {
      id,
      username: `member-${id.slice(0, 8)}`,
      displayName: '小李',
      passwordHash: 'x',
    })
    return id
  }

  function deps(harness: ReturnType<typeof makeHarness>) {
    return {
      database,
      outbox: harness.outbox,
      orchestrator: harness.orchestrator,
      dshDistributionVersionFor: async () => '1.2.3-test',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    }
  }

  async function bringOnline(deviceId: string) {
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: '9.9.9-test', lastSeenAt: new Date() })
      .where(eq(schema.devices.id, deviceId))
  }

  it('判据 1：未授权成员发指令 → 403 FORBIDDEN，且**不落指令、不建 Run**', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const outsider = await addMember()
    const harness = makeHarness(database)

    expect(await resolveInstructionRight(database.db, ids.taskId, outsider)).toBe('none')
    await expect(
      sendInstruction(deps(harness), makeActor(outsider), ids.taskId, {
        text: '我不是责任人也不是被授权人',
        idempotencyKey: 'g1',
      }),
    ).rejects.toThrow(/granted member/)

    expect(await database.db.select().from(schema.runs)).toEqual([])
    expect(await listMessages(database.db, ids.taskId)).toEqual([])
  })

  it('判据 2：授权后同一成员发指令 → 成功，且消息作者是**该成员**（审计看得出谁驱动的）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const member = await addMember()
    const harness = makeHarness(database)

    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })
    expect(await resolveInstructionRight(database.db, ids.taskId, member)).toBe('granted')

    const outcome = await sendInstruction(deps(harness), makeActor(member), ids.taskId, {
      text: '我来跑这一轮',
      idempotencyKey: 'g2',
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
    })
    expect(outcome.kind).toBe('started_run')

    const [message] = await listMessages(database.db, ids.taskId)
    expect(message).toMatchObject({ authorUserId: member, body: '我来跑这一轮' })
    // **红线**：Run 的归属仍是责任人，不是开口的那个人。
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, outcome.runId))
    expect(run?.ownerUserId).toBe(ids.userId)
  })

  it('判据 3：撤销授权**立刻**失效（下一次指令 403，不需要重启或等缓存过期）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const member = await addMember()
    const harness = makeHarness(database)
    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })

    const first = await sendInstruction(deps(harness), makeActor(member), ids.taskId, {
      text: '授权期内可以发',
      idempotencyKey: 'g3a',
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
    })
    expect(first.kind).toBe('started_run')
    // 把 Run 收到终态，好让下一次指令走「起新 Run」而不是追问路径（两条路径的守卫都要验）。
    await setRunStatus(database.db, first.runId, 'completed', { finishedAt: new Date() })

    expect(await revokeInstruction(database.db, ids.taskId, member)).toBe(true)
    expect(await resolveInstructionRight(database.db, ids.taskId, member)).toBe('none')
    const before = (await listMessages(database.db, ids.taskId)).length
    await expect(
      sendInstruction(deps(harness), makeActor(member), ids.taskId, {
        text: '撤销之后就不该能发了',
        idempotencyKey: 'g3b',
      }),
    ).rejects.toThrow(/granted member/)
    // 拒绝不留痕：消息数不变，Run 数不变。
    expect((await listMessages(database.db, ids.taskId)).length).toBe(before)
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('判据 3b：追问路径同样认授权（有活跃 Run 时的守卫不是另一套）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const member = await addMember()
    const harness = makeHarness(database)

    // 责任人先起一轮并推到 running，让"接着说"走追问路径。
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.outbox.claim()
    await setRunStatus(database.db, run.id, 'running')

    // 未授权：追问被拒。
    await expect(
      sendRunFollowup(database, harness.outbox, makeActor(member), run.id, {
        text: '能插一句吗',
        idempotencyKey: 'g3b-1',
      }),
    ).rejects.toThrow(/granted member/)

    // 授权后：同一个动作成功，且消息作者是该成员。
    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })
    const message = await sendRunFollowup(database, harness.outbox, makeActor(member), run.id, {
      text: '现在可以了',
      idempotencyKey: 'g3b-2',
    })
    expect(message).toMatchObject({ authorUserId: member, kind: 'followup', runId: run.id })
  })

  it('判据 4：被授权成员驱动时，设备/工作区仍必须是**责任人的**（执行不换机器）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const member = await addMember()
    const harness = makeHarness(database)
    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })

    // 该成员自己的设备：不属于责任人 → 不能作为执行目标（否则"执行发生在责任人设备上"就破了）。
    const ownDevice = randomUUID()
    await database.db.insert(schema.devices).values({
      id: ownDevice,
      ownerUserId: member,
      name: '小李的笔记本',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: new Uint8Array([9, 9, 9]),
      capabilities: {},
      dshDistributionVersion: '9.9.9-test',
    })
    await expect(
      sendInstruction(deps(harness), makeActor(member), ids.taskId, {
        text: '用我自己的机器跑',
        idempotencyKey: 'g4',
        deviceId: ownDevice,
        agentId: ids.agentId,
      }),
    ).rejects.toThrow(/does not belong/)

    // 不给显式目标时，三段式解析出的是**责任人**的设备（不是他自己的）。
    const resolved = await sendInstruction(deps(harness), makeActor(member), ids.taskId, {
      text: '用责任人的机器跑',
      idempotencyKey: 'g4b',
      agentId: ids.agentId,
    })
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, resolved.runId))
    expect(run).toMatchObject({ deviceId: ids.deviceId, ownerUserId: ids.userId })
  })

  it('判据 5：授权驱动 ≠ 授权拍板——被授权成员仍不能决定审批', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const member = await addMember()
    const harness = makeHarness(database)
    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })

    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.outbox.claim()
    await setRunStatus(database.db, run.id, 'waiting_approval')
    await database.db.insert(schema.approvals).values({
      id: randomUUID(),
      runId: run.id,
      callId: 'call-1',
      toolName: 'git.push',
      reason: '需要把回归清单推到 release 分支',
      preview: { command: 'git push origin release/v2.4' },
      expiresAt: new Date(Date.now() + 60_000),
    })
    const [approval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, run.id))
    if (approval === undefined) throw new Error('approval seed failed')

    // 同一条审批：被授权成员决定 → 拒绝（授权驱动 ≠ 授权拍板）。
    await expect(
      harness.orchestrator.decideApproval(makeActor(member), approval.id, 'allowed_once'),
    ).rejects.toThrow(/FORBIDDEN|assignee|owner/i)

    // 对照组：责任人决定 → 通过。证明上一条拒绝来自**权限**，而不是状态/过期之类的别的原因。
    const decided = await harness.orchestrator.decideApproval(
      makeActor(ids.userId),
      approval.id,
      'allowed_once',
    )
    expect(decided).toMatchObject({ status: 'allowed_once', decidedBy: ids.userId })
  })

  it('判据 6：讨论区不受授权影响——任何成员的评论都不需要授权（回归）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const member = await addMember()
    const memberActor = makeActor(member)

    // 直接走讨论服务（与 HTTP 路由同一条函数）：没有授权也应当成功。
    const { addComment } = await import('../src/modules/task/commands.js')
    const comment = await addComment(database, memberActor, ids.taskId, {
      body: '我不需要授权也能说话',
      idempotencyKey: 'g6',
    })
    expect(comment).toMatchObject({ body: '我不需要授权也能说话' })
    // 讨论**不会**因此获得指令权。
    expect(await resolveInstructionRight(database.db, ids.taskId, member)).toBe('none')
  })

  it('守卫的单一入口：授权行本身有唯一约束（重复授予幂等，不产生第二行）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const member = await addMember()
    const first = await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })
    const second = await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })
    expect(second.id).toBe(first.id)
    expect(await listInstructionGrants(database.db, ids.taskId)).toHaveLength(1)
    // 责任人**永远**能驱动，不需要授权行（判据：即使表是空的，责任人也是 assignee）。
    expect(await resolveInstructionRight(database.db, ids.taskId, ids.userId)).toBe('assignee')
    expect(await listInstructionGrants(database.db, ids.taskId)).toHaveLength(1)
  })

  it('HTTP 面：未授权成员发指令 → 403（不是 500，也不是误导性的 409）', async () => {
    const ctx: TestApp = await createTestApp(database)
    try {
      const alice = await driveSetup(ctx)
      const project = await apiInject(ctx, alice, {
        method: 'POST',
        url: '/api/v1/projects',
        payload: { name: 'P' },
      })
      const task = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${project.json().data.id}/tasks`,
        payload: { title: 'T', assigneeUserId: alice.userId },
      })
      const taskId = task.json().data.id as string
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/accept`,
        idempotencyKey: idemKey(),
      })

      // 真实邀请路径造一个团队成员（非责任人）。
      const { session: bob } = await driveInviteAndAccept(ctx, alice, {
        username: `bob-${randomUUID().slice(0, 6)}`,
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })

      const denied = await apiInject(ctx, bob, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/instructions`,
        payload: { text: '我不是责任人' },
        idempotencyKey: idemKey(),
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().error.code).toBe('FORBIDDEN')
      // 拒绝不留痕。
      expect(await database.db.select().from(schema.runs)).toEqual([])
      expect(await listMessages(database.db, taskId)).toEqual([])

      // 授予之后同一个成员再发 → 不再 403（此处没有设备，所以是 409 DEVICE_OFFLINE——
      // 关键是**权限这层已经过了**：错误码从 FORBIDDEN 变成目标解析的结果）。
      const [taskRow] = await database.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
      const bobUserId = bob.userId
      await grantInstruction(database.db, {
        id: randomUUID(),
        taskId,
        userId: bobUserId,
        grantedBy: taskRow!.assigneeUserId,
      })
      const allowed = await apiInject(ctx, bob, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/instructions`,
        payload: { text: '现在我是被授权成员' },
        idempotencyKey: idemKey(),
      })
      expect(allowed.statusCode).toBe(409)
      expect(allowed.json().error.code).toBe('DEVICE_OFFLINE')
    } finally {
      await ctx.close()
    }
  })
})
