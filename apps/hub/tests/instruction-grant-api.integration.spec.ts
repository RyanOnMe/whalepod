import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { insertMember, insertUser, listTeamEvents, schema, type Database } from '@whalepod/db'
import { RunCommandError } from '../src/modules/run/errors.js'
import { sendInstruction } from '../src/modules/run/instruction.js'
import { revokeInstructionRight } from '../src/modules/task/instruction-grants.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  makeActor,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
  type TestApp,
} from './helpers.js'

/**
 * P1-198 切片④b：授权管理面（授予 / 撤销 / 名单）。
 *
 * 这一面的**写入者只有一个**：Task 责任人。被授权成员不能自我复制，团队管理员也不能替责任人授权
 * （管理员的权力不是责任人的权力）。读取面团队成员可读——协作需要看得见"谁在驱动"。
 */
describe('instruction grant management (P1-198 ④b)', () => {
  let database: Database
  let ctx: TestApp
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
  })
  afterEach(async () => {
    await ctx.close()
  })

  /** 经 HTTP 建好 project/task 并接受指派。 */
  async function seedTask(): Promise<{
    alice: Awaited<ReturnType<typeof driveSetup>>
    taskId: string
  }> {
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
    return { alice, taskId }
  }

  it('授予 → 201；名单里责任人排第一（永远可驱动），被授权成员带"由谁何时授"', async () => {
    const { alice, taskId } = await seedTask()
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: `bob-${randomUUID().slice(0, 6)}`,
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })

    const granted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
      payload: { userId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(granted.statusCode).toBe(201)
    expect(granted.json().data).toMatchObject({ userId: bob.userId, grantedBy: alice.userId })

    const list = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
    })
    expect(list.statusCode).toBe(200)
    const drivers = list.json().data as { userId: string; reason: string }[]
    expect(drivers[0]).toMatchObject({ userId: alice.userId, reason: 'assignee' })
    expect(drivers[1]).toMatchObject({ userId: bob.userId, reason: 'granted' })
  })

  it('重复授予幂等：201 但不产生第二行，且**审计里只有一条真变更**', async () => {
    const { alice, taskId } = await seedTask()
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: `bob-${randomUUID().slice(0, 6)}`,
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    for (let i = 0; i < 3; i += 1) {
      const res = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/instruction-grants`,
        payload: { userId: bob.userId },
        idempotencyKey: idemKey(),
      })
      expect(res.statusCode).toBe(201)
    }
    const rows = await database.db
      .select()
      .from(schema.taskInstructionGrants)
      .where(eq(schema.taskInstructionGrants.taskId, taskId))
    expect(rows).toHaveLength(1)

    const events = await listTeamEvents(database.db)
    const grants = events.filter(
      (event) =>
        (event.payload as { change?: string }).change === 'instruction_granted' &&
        (event.payload as { taskId?: string }).taskId === taskId,
    )
    // 三次调用、一次真新增 ⇒ 一条事件（否则审计会被"又授了一次"的噪音淹没）。
    expect(grants).toHaveLength(1)
  })

  it('非责任人不能授：被授权成员与管理员的尝试都被 403，且不落行', async () => {
    const { alice, taskId } = await seedTask()
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: `bob-${randomUUID().slice(0, 6)}`,
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const { session: admin } = await driveInviteAndAccept(
      ctx,
      alice,
      {
        username: `admin-${randomUUID().slice(0, 6)}`,
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
      'admin',
    )
    // 先让 Bob 成为被授权成员，再让他尝试自我复制（也不许）。
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
      payload: { userId: bob.userId },
      idempotencyKey: idemKey(),
    })

    const carol = randomUUID()
    await insertUser(database.db, {
      id: carol,
      username: `carol-${carol.slice(0, 6)}`,
      displayName: 'Carol',
      passwordHash: 'x',
    })
    const [team] = await database.db.select().from(schema.teams).limit(1)
    await insertMember(database.db, {
      teamId: team!.id,
      userId: carol,
      role: 'member',
    })

    for (const [who, session] of [
      ['被授权成员', bob],
      ['团队管理员', admin],
    ] as const) {
      const res = await apiInject(ctx, session, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/instruction-grants`,
        payload: { userId: carol },
        idempotencyKey: idemKey(),
      })
      expect(res.statusCode, who).toBe(403)
      expect(res.json().error.code, who).toBe('FORBIDDEN')
    }
    // 只有 alice 授给 bob 的那一行。
    const rows = await database.db
      .select()
      .from(schema.taskInstructionGrants)
      .where(eq(schema.taskInstructionGrants.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(bob.userId)
  })

  it('幽灵名单：授权给**非团队成员** → 404，不落行', async () => {
    const { alice, taskId } = await seedTask()
    const outsider = randomUUID()
    await insertUser(database.db, {
      id: outsider,
      username: `outsider-${outsider.slice(0, 6)}`,
      displayName: 'Outsider',
      passwordHash: 'x',
    })
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
      payload: { userId: outsider },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(404)
    expect(await database.db.select().from(schema.taskInstructionGrants)).toEqual([])
  })

  it('给责任人自己授予 / 撤销责任人 → 明确 400（他本来就永远可驱动）', async () => {
    const { alice, taskId } = await seedTask()
    const grant = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
      payload: { userId: alice.userId },
      idempotencyKey: idemKey(),
    })
    expect(grant.statusCode).toBe(400)
    expect(grant.json().error.code).toBe('VALIDATION_FAILED')

    const revoke = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/instruction-grants/${alice.userId}`,
      idempotencyKey: idemKey(),
    })
    expect(revoke.statusCode).toBe(400)
  })

  it('撤销立刻生效：撤销后该成员发指令 403（HTTP 面），审计留下撤销事件', async () => {
    const { alice, taskId } = await seedTask()
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: `bob-${randomUUID().slice(0, 6)}`,
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
      payload: { userId: bob.userId },
      idempotencyKey: idemKey(),
    })

    const revoked = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/instruction-grants/${bob.userId}`,
      idempotencyKey: idemKey(),
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json().data).toMatchObject({ revoked: true })

    // 撤销之后：同一成员发指令 → 先撞权限（403），而不是目标解析（409）。
    const denied = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instructions`,
      payload: { text: '撤销之后还能发吗' },
      idempotencyKey: idemKey(),
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('FORBIDDEN')

    const events = await listTeamEvents(database.db)
    const revokes = events.filter(
      (event) => (event.payload as { change?: string }).change === 'instruction_revoked',
    )
    expect(revokes).toHaveLength(1)
  })

  it('撤销一个从未被授权的人 → 200 且 revoked=false（幂等，不报错也不发事件）', async () => {
    const { alice, taskId } = await seedTask()
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: `bob-${randomUUID().slice(0, 6)}`,
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const res = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/instruction-grants/${bob.userId}`,
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ revoked: false })
    const events = await listTeamEvents(database.db)
    expect(
      events.filter(
        (event) => (event.payload as { change?: string }).change === 'instruction_revoked',
      ),
    ).toEqual([])
  })

  it('23514 翻译：真实形态的错误被翻成人话，且**不误翻**不相关的错误（正反例）', async () => {
    const { translateGrantConstraintError } =
      await import('../src/modules/task/instruction-grants.js')
    // 正例：逐字复现真实的错误链形态（外层是 Drizzle 的 `Failed query: …`，内层是触发器文案）。
    // 断言目标是**"真的被翻译了"**（类型 + 错误码），而不是"输出里没有 SQL 字样"——
    // 后者是永真判据（复核 #205 观察 2 实测：把 fixture 换成不含 SQL 的文案，9/9 仍全绿）。
    const raw = Object.assign(new Error('Failed query: insert into "task_instruction_grant" ...'), {
      cause: new Error('task_instruction_grant.granted_by must be the task assignee'),
    })
    const translated = translateGrantConstraintError(raw) as { code?: string; message?: string }
    expect(translated).not.toBe(raw) // 确实换了一个对象（没翻译时会原样返回）
    expect(translated.code).toBe('VALIDATION_FAILED')
    expect(translated.message).toMatch(/assignee/)
    expect(translated.message).not.toMatch(/insert into|task_instruction_grant/)

    // 反例（负对照）：不含该触发文案的 PG 错误**不得**被误翻成"授权必须由责任人"——
    // 否则 0005 的 `run_trigger_message_same_task` 那类 23514 会被错误归因。
    const unrelated = Object.assign(new Error('Failed query: insert into "run" ...'), {
      cause: new Error('run.trigger_message_id must reference a message of the same task'),
    })
    expect(translateGrantConstraintError(unrelated)).toBe(unrelated)
  })

  it('GET 名单的错误面与 POST/DELETE 一致：未知 Task → **404**（复核 S1：此前是 500）', async () => {
    const { alice } = await seedTask()
    const missing = randomUUID()
    for (const [method, url] of [
      ['GET', `/api/v1/tasks/${missing}/instruction-grants`],
      ['POST', `/api/v1/tasks/${missing}/instruction-grants`],
    ] as const) {
      const res = await apiInject(ctx, alice, {
        method,
        url,
        ...(method === 'POST' ? { payload: { userId: missing }, idempotencyKey: idemKey() } : {}),
      })
      // 三条路由的错误面必须自相矛盾地一致：未知资源就是 404，不是 500。
      expect(res.statusCode, `${method} 未知 Task`).toBe(404)
    }
  })

  it('落库前的判权复核**有判据**（复核 S2）：撤销后复核必须抛 FORBIDDEN', async () => {
    const ids = await seedRunPrereqs(database.db)
    const member = randomUUID()
    await insertUser(database.db, {
      id: member,
      username: `guard-${member.slice(0, 6)}`,
      displayName: 'Guard',
      passwordHash: 'x',
    })
    const { grantInstruction } = await import('@whalepod/db')
    const { RunOrchestrator } = await import('../src/modules/run/orchestrator.js')

    // 授权在 → 复核通过（这是"删掉复核也全绿"的反面：这条断言要求它真的存在且不误拒）。
    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })
    await database.transaction(async (tx) => {
      await RunOrchestrator.assertInstructionRightStillValid(tx, ids.taskId, member)
    })

    // **带外**删除（绕过 `revokeInstructionRight` 的 Task 锁，模拟运维脚本/批量接口）→ 复核必须拦住。
    // 生产可达路径（走 revoke 服务）本来就被同一把 Task 行锁串行化（复核 PROBE C），
    // 复核真正防的是这条带外路径。
    await database.db
      .delete(schema.taskInstructionGrants)
      .where(eq(schema.taskInstructionGrants.taskId, ids.taskId))
    const error = await database
      .transaction(async (tx) => {
        await RunOrchestrator.assertInstructionRightStillValid(tx, ids.taskId, member)
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(RunCommandError)
    expect((error as RunCommandError).code).toBe('FORBIDDEN')
    expect((error as RunCommandError).message).toMatch(/revoked before the run could be created/)
  })

  it('撤销与建 Run 的竞态：撤销后**紧接着**发指令必被拒（判权在建 Run 前复读）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: '9.9.9-test', lastSeenAt: new Date() })
      .where(eq(schema.devices.id, ids.deviceId))
    const member = randomUUID()
    await insertUser(database.db, {
      id: member,
      username: `racer-${member.slice(0, 6)}`,
      displayName: 'Racer',
      passwordHash: 'x',
    })
    const harness = makeHarness(database)
    const { grantInstruction } = await import('@whalepod/db')
    await grantInstruction(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      userId: member,
      grantedBy: ids.userId,
    })

    // 先起一次拿到回执/目标解析路径都走过的状态，再撤销，然后立刻发新指令。
    await revokeInstructionRight(database, makeActor(ids.userId), ids.taskId, member, 'race-revoke')
    await expect(
      sendInstruction(
        {
          database,
          outbox: harness.outbox,
          orchestrator: harness.orchestrator,
          dshDistributionVersionFor: async () => '1.2.3-test',
        },
        makeActor(member),
        ids.taskId,
        { text: '撤销后立刻发', idempotencyKey: 'race-send', agentId: ids.agentId },
      ),
    ).rejects.toThrow(/granted member/)
    expect(await database.db.select().from(schema.runs)).toEqual([])
  })
})
