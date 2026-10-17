/**
 * 交接交付与接收确认（#380；ADR-0017 §5）集成判据。
 *
 * 覆盖：
 * - deliver：建/联同项目下游 Task（责任人 = 被选成员）、pending receipt、幂等重放；
 *   跨项目/改派不符/非责任人交付一律拒绝；
 * - confirm：仅接收方、理解必填、差异落上游讨论、重复确认不覆盖首次理解、不启动 Run；
 * - 下游 Run 固定输入：显式 receipt 快照（逐件摘要）、pending 拒绝、重跑/续跑继承、
 *   全新执行不带；上游发新版本不改任何历史 Run；
 * - adopt：上游新版本 → 新 confirmed receipt，旧 receipt/旧 Run 保留原版本，重复采用幂等；
 * - Node 下载授权：该设备自己的 Run 的交接快照引用了该 Artifact 才可下载（HTTP，
 *   真实 Device Token），快照外材料与第三台设备一律 404。
 */
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, schema } from '@whalepod/db'
import type { HandoffNarrative, TaskSpecContent } from '@whalepod/protocol'
import {
  adoptReceipt,
  confirmReceipt,
  deliverHandoff,
  listDownstreamReceipts,
  listUpstreamDeliveries,
} from '../src/modules/handoff/index.js'
import {
  createManualHandoffDraft,
  publishHandoffDraft,
  updateManualHandoffDraft,
} from '../src/modules/handoff/drafts.js'
import { confirmAgreement, saveAgreementDraft } from '../src/modules/task/agreement.js'
import { acceptAssignment, updateTask } from '../src/modules/task/commands.js'
import { hashToken } from '../src/modules/auth/token.js'
import { ArtifactStore } from '../src/modules/artifact/store.js'
import {
  createTestApp,
  createTestDatabase,
  idemKey,
  insertRunRow,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
  seedSecondUserDevice,
  TEST_DSH_VERSION,
} from './helpers.js'
import type { TestApp } from './helpers.js'
import type { Harness, SeedIds } from './helpers.js'

const SPEC_CONTENT: TaskSpecContent = {
  goal: '交付订单查询接口',
  constraints: '不引入新依赖',
  acceptance: '全部用例通过',
  openQuestions: '',
}

function narrative(overrides: Partial<HandoffNarrative> = {}): HandoffNarrative {
  return {
    completed: [],
    interfaces: [],
    unfinished: [],
    decisions: [],
    evidence: [],
    downstream: [],
    commits: [],
    prs: [],
    ...overrides,
  }
}

describe('handoff delivery & receipt (#380)', () => {
  let database: Database
  let tmpDirs: string[]

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    tmpDirs = []
  })
  afterAll(async () => {
    await database.close()
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
  })

  /**
   * 上游齐备态：任务 U（启用约定 + 已确认 v1）→ 完成一个业务 Run → 已发布材料 →
   * 已发布交接版本 v1。返回全部句柄（下游测试自取）。
   */
  async function seedUpstream(): Promise<{
    ids: SeedIds
    receiver: { userId: string; deviceId: string; workspaceId: string }
    harness: Harness
    runId: string
    artifactId: string
    artifactSha: string
    revisionId: string
  }> {
    const ids = await seedRunPrereqs(database.db)
    const receiver = await seedSecondUserDevice(database.db, ids)
    const actor = makeActor(ids.userId)
    await updateTask(database, actor, ids.taskId, { agreementEnabled: true }, idemKey())
    const draft = await saveAgreementDraft(
      database,
      actor,
      ids.taskId,
      { content: SPEC_CONTENT },
      idemKey(),
    )
    await confirmAgreement(
      database,
      actor,
      ids.taskId,
      { draftVersion: draft.draftVersion },
      idemKey(),
    )

    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(actor, ids.taskId, makeCreateInput(ids))
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, { type: 'run.completed', finalText: 'done' }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('completed')

    const content = Buffer.from('# 接口约定\nGET /orders\n')
    const artifactSha = createHash('sha256').update(content).digest('hex')
    const artifactId = randomUUID()
    await database.db.insert(schema.artifacts).values({
      id: artifactId,
      taskId: ids.taskId,
      runId: run.id,
      ownerUserId: ids.userId,
      title: '接口约定.md',
      mediaType: 'text/markdown',
      byteSize: content.byteLength,
      sha256: artifactSha,
      storageKey: 'sha256/aa/' + 'a'.repeat(60),
      status: 'candidate',
    })
    await database.db
      .update(schema.artifacts)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(schema.artifacts.id, artifactId))

    const manual = await createManualHandoffDraft(database, actor, run.id, idemKey())
    await updateManualHandoffDraft(
      database,
      actor,
      run.id,
      {
        narrative: narrative({
          evidence: [
            {
              text: '接口约定已发布',
              verified: true,
              refs: [{ kind: 'artifact', artifactId }],
            },
          ],
        }),
        expectedDraftVersion: manual.draftVersion,
      },
      idemKey(),
    )
    const published = await publishHandoffDraft(database, actor, run.id, idemKey())
    expect(published.revision.content.system.artifacts[0]).toMatchObject({ artifactId })
    return {
      ids,
      receiver,
      harness,
      runId: run.id,
      artifactId,
      artifactSha,
      revisionId: published.revision.id,
    }
  }

  async function receiptRows() {
    return database.db.select().from(schema.handoffReceipts)
  }

  it('deliver：新建下游任务（责任人=被选成员、待接受）→ pending receipt；重放不重复建', async () => {
    const { ids, receiver, revisionId } = await seedUpstream()
    const key = idemKey()
    const first = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入订单接口' } },
      key,
    )
    expect(first.status).toBe('pending')
    expect(first.revisionNumber).toBe(1)
    expect(first.receiverUserId).toBe(receiver.userId)
    const downstream = await database.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, first.downstreamTaskId))
    expect(downstream[0]).toMatchObject({
      projectId: ids.projectId,
      assigneeUserId: receiver.userId,
      assignmentStatus: 'pending',
    })

    // 同 key 重放：不重复建 Task / receipt。
    const replay = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入订单接口' } },
      key,
    )
    expect(replay.id).toBe(first.id)
    expect(await receiptRows()).toHaveLength(1)
    const taskCount = await database.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, ids.projectId))
    expect(taskCount).toHaveLength(2)
  })

  it('deliver 守卫：非上游责任人 403；跨项目/不存在 404；任务不归接收人/已完结 409', async () => {
    const { ids, receiver, revisionId } = await seedUpstream()
    await expect(
      deliverHandoff(
        database,
        makeActor(receiver.userId),
        revisionId,
        { receiverUserId: receiver.userId, newTask: { title: 'x' } },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // 关联既有任务：归接收人且未完结 → 通过；归别人 → 409；跨项目 → 404。
    const own = await database.db
      .insert(schema.tasks)
      .values({
        id: randomUUID(),
        projectId: ids.projectId,
        title: '前端任务（既有）',
        assigneeUserId: receiver.userId,
        assignmentStatus: 'accepted',
        acceptedAt: new Date(),
        createdBy: ids.userId,
      })
      .returning()
    const linked = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, downstreamTaskId: own[0]!.id },
      idemKey(),
    )
    expect(linked.downstreamTaskId).toBe(own[0]!.id)
    expect(linked.status).toBe('pending')

    const otherProjectId = randomUUID()
    await database.db.insert(schema.projects).values({
      id: otherProjectId,
      name: '另一个项目',
      createdBy: ids.userId,
    })
    const crossProject = await database.db
      .insert(schema.tasks)
      .values({
        id: randomUUID(),
        projectId: otherProjectId,
        title: '别项目任务',
        assigneeUserId: receiver.userId,
        createdBy: ids.userId,
      })
      .returning()
    await expect(
      deliverHandoff(
        database,
        makeActor(ids.userId),
        revisionId,
        { receiverUserId: receiver.userId, downstreamTaskId: crossProject[0]!.id },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const notMine = await database.db
      .insert(schema.tasks)
      .values({
        id: randomUUID(),
        projectId: ids.projectId,
        title: '别人手上的任务',
        assigneeUserId: ids.userId,
        createdBy: ids.userId,
      })
      .returning()
    await expect(
      deliverHandoff(
        database,
        makeActor(ids.userId),
        revisionId,
        { receiverUserId: receiver.userId, downstreamTaskId: notMine[0]!.id },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('confirm：仅接收方、理解必填、差异落上游讨论、重复确认不覆盖、不启动 Run', async () => {
    const { ids, receiver, revisionId } = await seedUpstream()
    const pending = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入' } },
      idemKey(),
    )
    // 非接收方确认 → 403；空理解 → 400（命令层 fail-closed，不只在 HTTP schema）。
    await expect(
      confirmReceipt(
        database,
        makeActor(ids.userId),
        pending.id,
        { understanding: '我来做' },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      confirmReceipt(
        database,
        makeActor(receiver.userId),
        pending.id,
        { understanding: '   ' },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    const confirmed = await confirmReceipt(
      database,
      makeActor(receiver.userId),
      pending.id,
      { understanding: '先实现订单列表页', differences: '接口字段名要再对齐 orderId' },
      idemKey(),
    )
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.understanding).toBe('先实现订单列表页')
    expect(confirmed.differences).toBe('接口字段名要再对齐 orderId')
    // 差异落上游 Task 的讨论（接收方署名）。
    const comments = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, ids.taskId))
    const difference = comments.find((row) => row.kind === 'discussion')
    expect(difference?.authorUserId).toBe(receiver.userId)
    expect(difference?.body).toContain('【交接差异】')
    expect(difference?.body).toContain('orderId')

    // 重复确认（新 key，另一份理解）：不覆盖首次理解；仍是一条 receipt。
    const again = await confirmReceipt(
      database,
      makeActor(receiver.userId),
      pending.id,
      { understanding: '改口：先做订单详情' },
      idemKey(),
    )
    expect(again.understanding).toBe('先实现订单列表页')
    expect(await receiptRows()).toHaveLength(1)

    // 确认不启动 Run、不接受 Task。
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, pending.downstreamTaskId))
    expect(runs).toHaveLength(0)
    const downstream = await database.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, pending.downstreamTaskId))
    expect(downstream[0]?.assignmentStatus).toBe('pending')
  })

  it('下游 Run 固定输入：显式 receipt 快照逐件固化；pending 拒绝；上游新版本不改历史 Run', async () => {
    const { ids, receiver, harness, revisionId, artifactId, artifactSha } = await seedUpstream()
    const pending = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入' } },
      idemKey(),
    )
    // 先把指派接受掉（否则先撞的是「assignment must be accepted」，验不到 receipt 守卫）。
    await acceptAssignment(database, makeActor(receiver.userId), pending.downstreamTaskId)
    // pending receipt 不能喂 Run。
    await expect(
      harness.orchestrator.create(makeActor(receiver.userId), pending.downstreamTaskId, {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: receiver.deviceId,
        workspaceId: receiver.workspaceId,
        prompt: '接入后端接口',
        dshDistributionVersion: TEST_DSH_VERSION,
        handoffReceiptId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await confirmReceipt(
      database,
      makeActor(receiver.userId),
      pending.id,
      { understanding: '先做订单列表' },
      idemKey(),
    )
    const created = await harness.orchestrator.create(
      makeActor(receiver.userId),
      pending.downstreamTaskId,
      {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: receiver.deviceId,
        workspaceId: receiver.workspaceId,
        prompt: '接入后端接口',
        dshDistributionVersion: TEST_DSH_VERSION,
        handoffReceiptId: pending.id,
      },
    )
    const run = await getRun(database.db, created.id)
    expect(run?.handoffInput).toMatchObject({
      upstreamTaskId: ids.taskId,
      upstreamTaskTitle: 'Seed task',
      receiptId: pending.id,
      revisionId,
      revisionNumber: 1,
      artifacts: [
        {
          artifactId,
          sha256: artifactSha,
          runId: expect.any(String),
        },
      ],
    })
    // 与同 Task 清单互不合并：本 Run 的 artifact_input_manifest 仍是空（未选择本任务材料）。
    expect(run?.artifactInputManifest?.artifacts).toEqual([])

    // 收尾本 Run（重跑来源必须终态）。
    const receiverDevice = { deviceId: receiver.deviceId, ownerUserId: receiver.userId }
    await harness.orchestrator.ingestNodeEvent(
      receiverDevice,
      runEventFrame(created.id, 1, { type: 'runtime.ready', dshSessionId: 'd-1' }),
    )
    await harness.orchestrator.ingestNodeEvent(
      receiverDevice,
      runEventFrame(created.id, 2, { type: 'run.completed', finalText: 'done' }),
    )

    // 上游发新版本 v2：历史 Run 的固定输入一个字节都不动。
    const sourceRun = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.taskId, ids.taskId))
    )[0]!
    const draft2 = await createManualHandoffDraft(
      database,
      makeActor(ids.userId),
      sourceRun.id,
      idemKey(),
    )
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      sourceRun.id,
      {
        narrative: narrative({
          completed: [{ text: '补充字段', verified: true, refs: [] }],
          evidence: [
            { text: '接口约定已发布', verified: true, refs: [{ kind: 'artifact', artifactId }] },
          ],
        }),
        expectedDraftVersion: draft2.draftVersion,
      },
      idemKey(),
    )
    const v2 = await publishHandoffDraft(database, makeActor(ids.userId), sourceRun.id, idemKey())
    expect(v2.revision.revisionNumber).toBe(2)
    const after = await getRun(database.db, created.id)
    expect(after?.handoffInput).toEqual(run?.handoffInput)

    // 重跑/续跑继承来源快照；全新执行不带。
    const rerun = await harness.orchestrator.create(
      makeActor(receiver.userId),
      pending.downstreamTaskId,
      {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: receiver.deviceId,
        workspaceId: receiver.workspaceId,
        prompt: '再来一遍',
        dshDistributionVersion: TEST_DSH_VERSION,
        rerunOfRunId: created.id,
      },
    )
    expect((await getRun(database.db, rerun.id))?.handoffInput).toEqual(run?.handoffInput)
    // 收尾重跑（单活跃约束：下一发的全新执行需要它离开活跃集）。
    await harness.orchestrator.ingestNodeEvent(
      receiverDevice,
      runEventFrame(rerun.id, 1, { type: 'runtime.ready', dshSessionId: 'd-2' }),
    )
    await harness.orchestrator.ingestNodeEvent(
      receiverDevice,
      runEventFrame(rerun.id, 2, { type: 'run.completed', finalText: 'done again' }),
    )
    const fresh = await harness.orchestrator.create(
      makeActor(receiver.userId),
      pending.downstreamTaskId,
      {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: receiver.deviceId,
        workspaceId: receiver.workspaceId,
        prompt: '不带交接材料',
        dshDistributionVersion: TEST_DSH_VERSION,
      },
    )
    expect((await getRun(database.db, fresh.id))?.handoffInput).toBeNull()
  })

  it('receipt 守卫：跨任务 receipt 404；接收人已非责任人 409；列表含最新版本号', async () => {
    const { ids, receiver, harness, revisionId } = await seedUpstream()
    const pending = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入' } },
      idemKey(),
    )
    await confirmReceipt(
      database,
      makeActor(receiver.userId),
      pending.id,
      { understanding: '做前端' },
      idemKey(),
    )
    await acceptAssignment(database, makeActor(receiver.userId), pending.downstreamTaskId)
    // 另一个下游任务（归接收人）拿别人的 receipt → 404。
    const otherTask = await database.db
      .insert(schema.tasks)
      .values({
        id: randomUUID(),
        projectId: ids.projectId,
        title: '另一个下游任务',
        assigneeUserId: receiver.userId,
        assignmentStatus: 'accepted',
        acceptedAt: new Date(),
        createdBy: ids.userId,
      })
      .returning()
    await expect(
      harness.orchestrator.create(makeActor(receiver.userId), otherTask[0]!.id, {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: receiver.deviceId,
        workspaceId: receiver.workspaceId,
        prompt: 'x',
        dshDistributionVersion: TEST_DSH_VERSION,
        handoffReceiptId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // 接收人不再是责任人（改派）→ 409，不自动喂给新责任人。
    await database.db
      .update(schema.tasks)
      .set({ assigneeUserId: ids.userId, assignmentStatus: 'pending', acceptedAt: null })
      .where(eq(schema.tasks.id, pending.downstreamTaskId))
    await acceptAssignment(database, makeActor(ids.userId), pending.downstreamTaskId)
    await expect(
      harness.orchestrator.create(makeActor(ids.userId), pending.downstreamTaskId, {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        prompt: 'x',
        dshDistributionVersion: TEST_DSH_VERSION,
        handoffReceiptId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const views = await listDownstreamReceipts(database.db, pending.downstreamTaskId)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      id: pending.id,
      revisionNumber: 1,
      latestRevisionNumber: 1,
      status: 'confirmed',
      upstreamTaskTitle: 'Seed task',
    })
    const upstreamViews = await listUpstreamDeliveries(database.db, ids.taskId)
    expect(upstreamViews).toHaveLength(1)
    expect(upstreamViews[0]).toMatchObject({
      downstreamTaskTitle: '前端接入',
      status: 'confirmed',
      understanding: '做前端',
    })
  })

  it('adopt：无新版本 409；新版本产生新 confirmed receipt；旧 receipt 保留；重复采用幂等', async () => {
    const { ids, receiver, revisionId, artifactId } = await seedUpstream()
    const pending = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入' } },
      idemKey(),
    )
    const confirmed = await confirmReceipt(
      database,
      makeActor(receiver.userId),
      pending.id,
      { understanding: 'v1 的理解' },
      idemKey(),
    )
    // 还没有新版本 → 409。
    await expect(
      adoptReceipt(
        database,
        makeActor(receiver.userId),
        confirmed.id,
        { understanding: '采用' },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // 上游发布 v2。
    const sourceRun = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.taskId, ids.taskId))
    )[0]!
    const draft2 = await createManualHandoffDraft(
      database,
      makeActor(ids.userId),
      sourceRun.id,
      idemKey(),
    )
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      sourceRun.id,
      {
        narrative: narrative({
          evidence: [
            { text: '接口约定已发布', verified: true, refs: [{ kind: 'artifact', artifactId }] },
          ],
        }),
        expectedDraftVersion: draft2.draftVersion,
      },
      idemKey(),
    )
    await publishHandoffDraft(database, makeActor(ids.userId), sourceRun.id, idemKey())
    const before = await listDownstreamReceipts(database.db, pending.downstreamTaskId)
    expect(before[0]?.latestRevisionNumber).toBe(2)

    // adopt：新 receipt（confirmed、理解必填已由命令层校验）；旧 receipt 原样。
    const adopted = await adoptReceipt(
      database,
      makeActor(receiver.userId),
      confirmed.id,
      { understanding: 'v2 的新打算：先对齐字段' },
      idemKey(),
    )
    expect(adopted.revisionNumber).toBe(2)
    expect(adopted.status).toBe('confirmed')
    // 重复采用（同 key 重放 + 新 key 第二次）都收敛到同一条。
    const replay = await adoptReceipt(
      database,
      makeActor(receiver.userId),
      confirmed.id,
      { understanding: 'v2 的新打算：先对齐字段' },
      idemKey(),
    )
    expect(replay.id).toBe(adopted.id)
    expect(await receiptRows()).toHaveLength(2)
    const after = await listDownstreamReceipts(database.db, pending.downstreamTaskId)
    expect(after.map((row) => row.revisionNumber).sort()).toEqual([1, 2])
    expect(after.find((row) => row.revisionNumber === 1)?.understanding).toBe('v1 的理解')
  })

  it('Node 下载授权（HTTP + 真实 Device Token）：快照内材料可下载，快照外与第三台设备 404', async () => {
    const { ids, receiver, harness, revisionId, artifactId, artifactSha } = await seedUpstream()
    const pending = await deliverHandoff(
      database,
      makeActor(ids.userId),
      revisionId,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入' } },
      idemKey(),
    )
    await confirmReceipt(
      database,
      makeActor(receiver.userId),
      pending.id,
      { understanding: '做前端' },
      idemKey(),
    )
    await acceptAssignment(database, makeActor(receiver.userId), pending.downstreamTaskId)
    const created = await harness.orchestrator.create(
      makeActor(receiver.userId),
      pending.downstreamTaskId,
      {
        idempotencyKey: idemKey(),
        agentId: ids.agentId,
        deviceId: receiver.deviceId,
        workspaceId: receiver.workspaceId,
        prompt: '接入',
        dshDistributionVersion: TEST_DSH_VERSION,
        handoffReceiptId: pending.id,
      },
    )
    // 快照外的上游材料（同任务、已发布，但不在交接包里）。
    const upstreamRunId = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.taskId, ids.taskId))
    )[0]!.id
    const outsiderId = randomUUID()
    await database.db.insert(schema.artifacts).values({
      id: outsiderId,
      taskId: ids.taskId,
      runId: upstreamRunId,
      ownerUserId: ids.userId,
      title: '不在包里的材料.md',
      mediaType: 'text/plain',
      byteSize: 4,
      sha256: 'b'.repeat(64),
      storageKey: 'sha256/bb/' + 'b'.repeat(60),
      status: 'published',
      publishedAt: new Date(),
    })
    // 第三台设备（同 Team，另一成员）。
    const third = await seedSecondUserDevice(database.db, ids)

    const ctx: TestApp = await createTestApp(database)
    tmpDirs.push(ctx.config.artifactStoreDir)
    try {
      // 上游材料的真实字节落进 Hub 的 Artifact Store（生产类，内容寻址）。
      const store = new ArtifactStore({ root: ctx.config.artifactStoreDir })
      const content = Buffer.from('# 接口约定\nGET /orders\n')
      const blob = await store.saveUpload(artifactSha, content)
      await database.db
        .update(schema.artifacts)
        .set({ storageKey: blob.storageKey, sha256: blob.sha256, byteSize: blob.byteSize })
        .where(eq(schema.artifacts.id, artifactId))
      // 设备 B 的 Device Token（fixture 只铸 hash；认证仍走真实 hashToken 比对）。
      const receiverToken = 'device-b-raw-token'
      await database.db
        .update(schema.devices)
        .set({ tokenHash: hashToken(receiverToken) })
        .where(eq(schema.devices.id, receiver.deviceId))

      const download = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/node/artifacts/${artifactId}/content`,
        headers: { authorization: `Device ${receiverToken}` },
      })
      expect(download.statusCode).toBe(200)
      expect(download.rawPayload.toString()).toBe(content.toString())

      // 快照外材料：同一条 Token 一律 404（不开放上游其他材料）。
      const outside = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/node/artifacts/${outsiderId}/content`,
        headers: { authorization: `Device ${receiverToken}` },
      })
      expect(outside.statusCode).toBe(404)
      // 第三台设备：既不在上游任务上跑，快照也不归它 → 404。
      const thirdToken = 'device-c-raw-token'
      await database.db
        .update(schema.devices)
        .set({ tokenHash: hashToken(thirdToken) })
        .where(eq(schema.devices.id, third.deviceId))
      const stranger = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/node/artifacts/${artifactId}/content`,
        headers: { authorization: `Device ${thirdToken}` },
      })
      expect(stranger.statusCode).toBe(404)

      // Node 读面：本 Run 设备可读快照；他人设备 404。
      const own = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/node/runs/${created.id}/handoff-input`,
        headers: { authorization: `Device ${receiverToken}` },
      })
      expect(own.statusCode).toBe(200)
      expect(own.json().data).toMatchObject({ revisionId, revisionNumber: 1 })
      const other = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/node/runs/${created.id}/handoff-input`,
        headers: { authorization: `Device ${thirdToken}` },
      })
      expect(other.statusCode).toBe(404)
    } finally {
      await ctx.app.close()
    }
  })

  it('历史 Run（无交接输入列）：轮询读面为 null，不当成错误', async () => {
    const ids = await seedRunPrereqs(database.db)
    const legacy = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
      artifactInputManifest: { taskId: ids.taskId, artifacts: [] },
    })
    const row = await getRun(database.db, legacy)
    expect(row?.handoffInput).toBeNull()
  })
})
