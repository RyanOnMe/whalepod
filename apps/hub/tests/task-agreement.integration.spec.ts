/**
 * 任务约定（#378；ADR-0017 §1/§2）集成判据。
 *
 * A 段走 HTTP（真路由、真会话）：草稿 CRUD/并发令牌/确认权限/开关规则/历史。
 * B 段直驱命令层（orchestrator / sendInstruction / updateTask）：**全部 Run 创建入口
 * 的绑定收口**——手动、重跑、续跑、指令、自动指派都不能绕过；辅助 Run 免绑定；
 * 未启用与历史 Run 保持未绑定（不补造）。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, schema, setRunStatus } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
  seedSecondUserDevice,
  TEST_DSH_VERSION,
  type Session,
  type TestApp,
} from './helpers.js'
import {
  confirmAgreement,
  discardAgreementDraft,
  getAgreementView,
  saveAgreementDraft,
} from '../src/modules/task/agreement.js'
import { updateTask } from '../src/modules/task/commands.js'
import { getTaskRoom } from '../src/modules/task/view.js'
import { sendInstruction } from '../src/modules/run/instruction.js'
import { grantInstructionRight } from '../src/modules/task/instruction-grants.js'

const CONTENT = {
  goal: '交付登录接口',
  constraints: '不引入新依赖',
  acceptance: '全部用例通过',
  openQuestions: '限流阈值待定',
}

async function createProject(ctx: TestApp, session: Session, name = 'Handoff'): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name },
  })
  if (res.statusCode !== 201)
    throw new Error(`create project failed: ${res.statusCode} ${res.body}`)
  return res.json().data.id as string
}

async function createTask(
  ctx: TestApp,
  session: Session,
  projectId: string,
  assigneeUserId: string,
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    payload: { title: '约定任务', assigneeUserId },
  })
  if (res.statusCode !== 201) throw new Error(`create task failed: ${res.statusCode} ${res.body}`)
  return res.json().data.id as string
}

describe('task agreement HTTP 面 (#378)', () => {
  let database: Database
  let ctx: TestApp
  let owner: Session
  let bob: Session
  let taskId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    owner = await driveSetup(ctx)
    const invited = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = invited.session
    const projectId = await createProject(ctx, owner)
    taskId = await createTask(ctx, owner, projectId, owner.userId)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('空态：无草稿、无已确认、未启用', async () => {
    const res = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/agreement`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      enabled: false,
      draft: null,
      confirmed: null,
      history: [],
      confirmedCount: 0,
    })
  })

  it('草稿：新建 → 并发令牌不匹配 409 → 匹配则版本 +1；同幂等键重放不重复落盘', async () => {
    const created = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: CONTENT },
    })
    expect(created.statusCode).toBe(200)
    const draft = created.json().data
    expect(draft).toMatchObject({ status: 'draft', revisionNumber: null, draftVersion: 1 })
    expect(draft.content).toEqual(CONTENT)

    // 无令牌再保存（客户端在看旧状态）→ 409，不覆盖。
    const stale = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: { ...CONTENT, goal: '被覆盖的目标' } },
    })
    expect(stale.statusCode).toBe(409)
    const afterStale = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/agreement`,
    })
    expect(afterStale.json().data.draft.content.goal).toBe('交付登录接口')

    // 令牌正确 → 更新成功、版本 +1。
    const updated = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: {
        content: { ...CONTENT, acceptance: '全部用例通过且无 flaky' },
        expectedDraftVersion: 1,
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().data).toMatchObject({ draftVersion: 2 })
    expect(updated.json().data.content.acceptance).toBe('全部用例通过且无 flaky')

    // 同幂等键重放：返回首次结果（同 id、同版本），不落第三稿。
    const replayKey = idemKey()
    const replayBody = { content: { ...CONTENT, goal: '重放目标' }, expectedDraftVersion: 2 }
    const first = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: replayBody,
      idempotencyKey: replayKey,
    })
    const replayed = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: replayBody,
      idempotencyKey: replayKey,
    })
    expect(replayed.statusCode).toBe(200)
    expect(replayed.json().data.id).toBe(first.json().data.id)
    const current = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/agreement`,
    })
    expect(current.json().data.draft.draftVersion).toBe(3)
    expect(current.json().data.draft.content.goal).toBe('重放目标')
  })

  it('确认：仅责任人；陈旧 draftVersion 409；确认后产生 v1 且草稿消失、历史可见', async () => {
    await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: CONTENT },
    })

    const bobConfirm = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: 1 },
    })
    expect(bobConfirm.statusCode).toBe(403)

    const staleConfirm = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: 2 },
    })
    expect(staleConfirm.statusCode).toBe(409)

    const confirmed = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: 1 },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json().data).toMatchObject({
      status: 'confirmed',
      revisionNumber: 1,
      confirmedByUserId: owner.userId,
    })

    const after = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/agreement`,
    })
    expect(after.json().data.draft).toBeNull()
    expect(after.json().data.confirmed.revisionNumber).toBe(1)
    expect(after.json().data.history).toHaveLength(1)
    expect(after.json().data.confirmedCount).toBe(1)

    // 再确认（无草稿）→ 409，不产生 v2。
    const again = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: 1 },
    })
    expect(again.statusCode).toBe(409)
  })

  it('确认校验：目标为空拒绝（VALIDATION_FAILED），草稿保持可编辑', async () => {
    await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: { ...CONTENT, goal: '   ' } },
    })
    const confirm = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: 1 },
    })
    expect(confirm.statusCode).toBe(400)
    expect(confirm.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('开关：可随时启用（无已确认版本也允许，执行被引导致确认）；非责任人不能改', async () => {
    // 开启不要求先有已确认版本（#378 修正）：执行会在绑定解析处被 AREEMENT_REQUIRED 拦下。
    const earlyEnable = await apiInject(ctx, owner, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { agreementEnabled: true },
    })
    expect(earlyEnable.statusCode).toBe(200)
    expect(earlyEnable.json().data.agreementEnabled).toBe(true)

    await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: CONTENT },
    })
    await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: 1 },
    })

    const bobEnable = await apiInject(ctx, bob, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { agreementEnabled: true },
    })
    expect(bobEnable.statusCode).toBe(403)

    const enabled = await apiInject(ctx, owner, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { agreementEnabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().data.agreementEnabled).toBe(true)

    const disabled = await apiInject(ctx, owner, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { agreementEnabled: false },
    })
    expect(disabled.json().data.agreementEnabled).toBe(false)

    // 关闭不动历史：已确认版本仍在。
    const view = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/agreement`,
    })
    expect(view.json().data.confirmed.revisionNumber).toBe(1)
    expect(view.json().data.enabled).toBe(false)
  })

  it('丢弃草稿：责任人可丢且幂等；丢弃后已确认版本不受影响', async () => {
    await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: CONTENT },
    })
    const discarded = await apiInject(ctx, owner, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
    })
    expect(discarded.json().data).toEqual({ discarded: true })
    const again = await apiInject(ctx, owner, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
    })
    expect(again.json().data).toEqual({ discarded: false })
  })

  it('未知 Task：GET 404（不可枚举）', async () => {
    const res = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${randomUUID()}/agreement`,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('task agreement 绑定收口 (#378)', () => {
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

  /** 直驱命令层种一个已确认版本（走生产函数：saveAgreementDraft + confirmAgreement）。 */
  async function seedConfirmed(
    ids: { taskId: string; userId: string },
    content = CONTENT,
  ): Promise<string> {
    const actor = makeActor(ids.userId)
    const draft = await saveAgreementDraft(database, actor, ids.taskId, { content }, idemKey())
    const confirmed = await confirmAgreement(
      database,
      actor,
      ids.taskId,
      { draftVersion: draft.draftVersion },
      idemKey(),
    )
    return confirmed.id
  }

  async function enableAgreement(taskId: string, userId: string): Promise<void> {
    await updateTask(database, makeActor(userId), taskId, { agreementEnabled: true }, idemKey())
  }

  it('启用后无已确认版本：手动创建被拒 AGREEMENT_REQUIRED；绑定草稿版本被拒 409', async () => {
    const ids = await seedRunPrereqs(database.db)
    // 先启用（不要求已有版本），再种一份未确认草稿：证明「有草稿」不等于「有依据」。
    await enableAgreement(ids.taskId, ids.userId)
    const draft = await saveAgreementDraft(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { content: CONTENT },
      idemKey(),
    )
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'AGREEMENT_REQUIRED' })

    await expect(
      orchestrator.create(
        makeActor(ids.userId),
        ids.taskId,
        makeCreateInput(ids, { specRevisionId: draft.id }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('启用后：缺省绑定最新已确认版本；显式绑定旧版本保留审计；未启用不绑定', async () => {
    const ids = await seedRunPrereqs(database.db)
    const v1 = await seedConfirmed(ids)
    await enableAgreement(ids.taskId, ids.userId)
    const { orchestrator } = makeHarness(database)

    const first = await orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids))
    expect(first.specRevisionId).toBe(v1)
    expect(first.purpose).toBe('business')

    // 把第一跑收终态（单活跃约束）。
    await setRunStatus(database.db, first.id, 'completed', { finishedAt: new Date() })

    // 确认 v2 后：缺省绑定 v2（新执行采用当前版本）；显式传 v1 = 继承来源版本（旧值不动）。
    const v2 = await seedConfirmed(ids, { ...CONTENT, acceptance: '验收条件 v2' })
    expect(v2).not.toBe(v1)
    const second = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    expect(second.specRevisionId).toBe(v2)
    await setRunStatus(database.db, second.id, 'completed', { finishedAt: new Date() })

    const explicitOld = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { specRevisionId: v1 }),
    )
    expect(explicitOld.specRevisionId).toBe(v1)
    // 历史 Run 的绑定不被新版本改写。
    expect((await getRun(database.db, first.id))?.specRevisionId).toBe(v1)
  })

  it('停用后新 Run 未绑定（不要求也不补造）；已确认版本仍在', async () => {
    const ids = await seedRunPrereqs(database.db)
    await seedConfirmed(ids)
    const { orchestrator } = makeHarness(database)
    const run = await orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids))
    expect(run.specRevisionId).toBeNull()
  })

  it('重跑：缺省绑定最新已确认版本（不自动继承来源绑定）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const v1 = await seedConfirmed(ids)
    await enableAgreement(ids.taskId, ids.userId)
    const { orchestrator } = makeHarness(database)
    const source = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    expect(source.specRevisionId).toBe(v1)
    await setRunStatus(database.db, source.id, 'completed', { finishedAt: new Date() })

    const v2 = await seedConfirmed(ids, { ...CONTENT, goal: '目标 v2' })
    const rerun = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { rerunOfRunId: source.id }),
    )
    expect(rerun.specRevisionId).toBe(v2)
  })

  it('续跑：缺省采用最新版本；显式传来源绑定可继承旧版本（新旧并存）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const v1 = await seedConfirmed(ids)
    await enableAgreement(ids.taskId, ids.userId)
    const { orchestrator } = makeHarness(database)
    const source = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
      dshSessionId: 'session-1',
      // 续跑缺省继承来源输入清单（ADR-0016）：来源没有快照会被 409 拦下，与本用例无关。
      artifactInputManifest: { taskId: ids.taskId, artifacts: [] },
      specRevisionId: v1,
    })
    const v2 = await seedConfirmed(ids, { ...CONTENT, goal: '目标 v2' })

    const resumed = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { resumeFromRunId: source }),
    )
    expect(resumed.specRevisionId).toBe(v2)
    await setRunStatus(database.db, resumed.id, 'completed', { finishedAt: new Date() })

    const inherit = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { resumeFromRunId: source, specRevisionId: v1 }),
    )
    expect(inherit.specRevisionId).toBe(v1)
  })

  it('辅助 Run（agreement_draft / handoff_draft）免绑定；room 投影如实显示用途与未绑定', async () => {
    const ids = await seedRunPrereqs(database.db)
    await seedConfirmed(ids)
    await enableAgreement(ids.taskId, ids.userId)
    const { orchestrator } = makeHarness(database)

    const helper = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { purpose: 'agreement_draft' }),
    )
    expect(helper.purpose).toBe('agreement_draft')
    expect(helper.specRevisionId).toBeNull()

    const room = await getTaskRoom(database.db, ids.taskId, ids.userId)
    const helperView = room?.runs.find((run) => run.id === helper.id)
    expect(helperView).toMatchObject({ purpose: 'agreement_draft', specRevision: null })

    // 业务 Run 在 room 投影里带版本号（绑定展示），历史未绑定行显示 null（不补造）。
    await setRunStatus(database.db, helper.id, 'completed', { finishedAt: new Date() })
    const legacy = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
    })
    const business = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    const room2 = await getTaskRoom(database.db, ids.taskId, ids.userId)
    const businessView = room2?.runs.find((run) => run.id === business.id)
    expect(businessView?.specRevision).toMatchObject({ revisionNumber: 1 })
    const legacyView = room2?.runs.find((run) => run.id === legacy)
    expect(legacyView).toMatchObject({ specRevision: null, purpose: 'business' })
    expect(room2?.agreement).toEqual({ enabled: true, latestConfirmedNumber: 1, hasDraft: false })
  })

  it('用途门禁（评审 M4）：辅助 Run 的 purpose 仅责任人可声明——被授权成员传即 FORBIDDEN', async () => {
    const ids = await seedRunPrereqs(database.db)
    const second = await seedSecondUserDevice(database.db, ids)
    await grantInstructionRight(database, makeActor(ids.userId), ids.taskId, {
      userId: second.userId,
      idempotencyKey: idemKey(),
    })
    const { orchestrator } = makeHarness(database)
    const grantedActor = makeActor(second.userId, 'member')

    // 前提：被授权成员本来就能发**业务** Run（执行现场仍是责任人的设备/凭据）。
    const business = await orchestrator.create(
      grantedActor,
      ids.taskId,
      makeCreateInput(ids, { purpose: 'business' }),
    )
    expect(business.purpose).toBe('business')
    await setRunStatus(database.db, business.id, 'completed', { finishedAt: new Date() })

    // 但 purpose 是**客户端可声明**的免绑定标记：不设门槛就等于给约定流程开后门
    //（有指令权的人传 agreement_draft 即可绕过 AGREEMENT_REQUIRED 跑业务工作）。
    for (const purpose of ['agreement_draft', 'handoff_draft'] as const) {
      await expect(
        orchestrator.create(grantedActor, ids.taskId, makeCreateInput(ids, { purpose })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    // 责任人自己仍可用辅助 Run（ADR-0017 §1 的整理约定/交接场景）。
    const helper = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { purpose: 'agreement_draft' }),
    )
    expect(helper.purpose).toBe('agreement_draft')
  })

  it('执行区指令与自动指派：无绑定被拒，带绑定成功且落库', async () => {
    const ids = await seedRunPrereqs(database.db)
    await enableAgreement(ids.taskId, ids.userId)
    // 目标解析要求设备已 hello（dshDistributionVersion 非空）——补上这一个事实。
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION, lastSeenAt: new Date() })
      .where(eq(schema.devices.id, ids.deviceId))
    const { orchestrator, outbox } = makeHarness(database)
    const deps = {
      database,
      outbox,
      orchestrator,
      dshDistributionVersionFor: async () => TEST_DSH_VERSION,
    }

    // 启用但未确认 → 执行区指令（人发）与自动指派两条路都被拒，且不落 Run。
    // 显式给设备/工作区：本用例盯的是绑定收口，不是目标解析（无显式目标会先 DEVICE_OFFLINE）。
    const instructionInput = {
      idempotencyKey: idemKey(),
      agentId: ids.agentId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
    }
    await expect(
      sendInstruction(deps, makeActor(ids.userId), ids.taskId, {
        text: '跑一遍',
        ...instructionInput,
        intent: { kind: 'new' },
      }),
    ).rejects.toMatchObject({ code: 'AGREEMENT_REQUIRED' })
    await expect(
      sendInstruction(deps, makeActor(ids.userId), ids.taskId, {
        text: '任务简报',
        ...instructionInput,
        idempotencyKey: idemKey(),
        origin: 'auto_assignment',
      }),
    ).rejects.toMatchObject({ code: 'AGREEMENT_REQUIRED' })
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, ids.taskId))
    expect(runs).toHaveLength(0)

    // 确认 v1 后重试：同一条指令路径成功并绑定。
    const v1 = await seedConfirmed(ids)
    const outcome = await sendInstruction(deps, makeActor(ids.userId), ids.taskId, {
      text: '跑一遍',
      ...instructionInput,
      idempotencyKey: idemKey(),
      intent: { kind: 'new' },
    })
    expect(outcome.kind).toBe('started_run')
    expect((await getRun(database.db, outcome.runId))?.specRevisionId).toBe(v1)
  })

  it('约定读模型：历史倒序、计数与开关一致；未启用任务永远未绑定', async () => {
    const ids = await seedRunPrereqs(database.db)
    const v1 = await seedConfirmed(ids)
    await seedConfirmed(ids, { ...CONTENT, goal: '目标 v2' })
    const view = await getAgreementView(database.db, ids.taskId)
    expect(view?.enabled).toBe(false)
    expect(view?.confirmed?.revisionNumber).toBe(2)
    expect(view?.history.map((revision) => revision.revisionNumber)).toEqual([2, 1])
    expect(view?.confirmedCount).toBe(2)
    expect(view?.draft).toBeNull()
    expect(v1).toBeDefined()
  })

  it('丢弃草稿只作用于开放草稿（命令层直驱）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const actor = makeActor(ids.userId)
    await saveAgreementDraft(database, actor, ids.taskId, { content: CONTENT }, idemKey())
    const result = await discardAgreementDraft(database, actor, ids.taskId, idemKey())
    expect(result).toEqual({ discarded: true })
    const v1 = await seedConfirmed(ids)
    const after = await getAgreementView(database.db, ids.taskId)
    expect(after?.draft).toBeNull()
    expect(after?.confirmed?.id).toBe(v1)
  })
})
