/**
 * 交接草稿与版本（#379；ADR-0017 §3-4）集成判据。
 *
 * 覆盖：
 * - 事件落库的幂等与「不复活终态」（迟到事件只更新草稿侧事实）；
 * - 私有边界：草稿只对源 Run owner 可见——其他成员与**管理员**一律 404；
 * - owner 手工新建/编辑（CAS）/失败草稿替换；
 * - 发布校验：流程未启用、证据无引用、候选材料引用、跨任务 run 引用一律拒绝；
 *   发布形态系统块只含已发布 Artifact；不可变 + Task 级编号单调递增。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, schema } from '@whalepod/db'
import type { HandoffNarrative } from '@whalepod/protocol'
import {
  createManualHandoffDraft,
  getRunHandoffDraft,
  listTaskHandoffRevisions,
  publishHandoffDraft,
  updateManualHandoffDraft,
} from '../src/modules/handoff/index.js'
import { updateTask } from '../src/modules/task/commands.js'
import {
  idemKey,
  insertRunRow,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
  seedSecondUserDevice,
  createTestDatabase,
} from './helpers.js'

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

describe('handoff draft (#379)', () => {
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

  /** 建一个已到终态的 Run（replay 帧驱动：ready → completed），返回种子与 harness。 */
  async function seedCompletedRun() {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, { type: 'run.completed', finalText: 'done' }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('completed')
    return { ids, harness, run }
  }

  async function draftRows(runId: string) {
    return database.db
      .select()
      .from(schema.handoffDrafts)
      .where(eq(schema.handoffDrafts.sourceRunId, runId))
  }

  it('生成事件落库：系统块来自权威事实；重放/重申不产生第二行；迟到事件不复活终态', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    // 本次 Run 的候选 Artifact（系统块应登记其身份与摘要，含候选状态）。
    const artifactId = randomUUID()
    await database.db.insert(schema.artifacts).values({
      id: artifactId,
      taskId: ids.taskId,
      runId: run.id,
      ownerUserId: ids.userId,
      title: 'out/report.md',
      mediaType: 'text/markdown',
      byteSize: 12,
      sha256: 'e'.repeat(64),
      storageKey: 'sha256/ee/' + 'e'.repeat(60),
      status: 'candidate',
    })
    const content = narrative({
      completed: [{ text: '登录接口完成', verified: false, refs: [] }],
      evidence: [
        {
          text: '测试通过',
          verified: false,
          refs: [{ kind: 'run', runId: run.id }],
        },
      ],
    })
    // 迟到：run.completed（seq 2）之后才到（seq 3）——只落草稿，不改状态。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, { type: 'handoff.draft', status: 'generated', content }),
    )
    const rows = await draftRows(run.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'ready', origin: 'auto', draftVersion: 1 })
    expect(rows[0]?.content?.system).toMatchObject({ sourceRunId: run.id, specRevision: null })
    expect(rows[0]?.content?.system.artifacts).toEqual([
      {
        artifactId,
        title: 'out/report.md',
        sha256: 'e'.repeat(64),
        byteSize: 12,
        status: 'candidate',
      },
    ])
    expect((await getRun(database.db, run.id))?.status).toBe('completed')

    // 同一 seq 重放：run_event 去重，行数不变。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, { type: 'handoff.draft', status: 'generated', content }),
    )
    expect(await draftRows(run.id)).toHaveLength(1)
    // 换 seq 重申（不同内容）：幂等兜底——不覆盖、不新增。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 4, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: '另一份内容', verified: false, refs: [] }] }),
      }),
    )
    const after = await draftRows(run.id)
    expect(after).toHaveLength(1)
    expect(after[0]?.content?.narrative.completed[0]?.text).toBe('登录接口完成')
    expect((await getRun(database.db, run.id))?.status).toBe('completed')
  })

  it('失败事件：落 failed 草稿（原因可读）；owner 手工新建替换它（失败恢复）', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, { type: 'handoff.draft', status: 'failed', reason: 'timeout' }),
    )
    const failed = await draftRows(run.id)
    expect(failed[0]).toMatchObject({ status: 'failed', failureReason: 'timeout', content: null })

    const manual = await createManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      idemKey(),
    )
    expect(manual.status).toBe('ready')
    expect(manual.origin).toBe('manual')
    expect(manual.content?.narrative).toEqual(narrative())
    const rows = await draftRows(run.id)
    // failed 行被替换（不是并存）：未发布草稿恒至多一条。
    expect(rows.filter((row) => row.status !== 'published')).toHaveLength(1)

    // 已有 ready 草稿时再手工新建 → 409。
    await expect(
      createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('私有边界：仅 owner 可见/可建——其他成员与管理员一律 404', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    const other = await seedSecondUserDevice(database.db, ids)
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: '私有内容', verified: false, refs: [] }] }),
      }),
    )
    const ownerView = await getRunHandoffDraft(database.db, run.id, ids.userId)
    expect(ownerView?.status).toBe('ready')

    for (const actorUserId of [other.userId, makeActor(randomUUID(), 'admin').userId]) {
      await expect(getRunHandoffDraft(database.db, run.id, actorUserId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(
        createManualHandoffDraft(database, makeActor(actorUserId, 'admin'), run.id, idemKey()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    // 不存在与不可见同形。
    await expect(getRunHandoffDraft(database.db, randomUUID(), ids.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('手工新建只在终态后；运行中 409', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await expect(
      createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('编辑：CAS 令牌不匹配 409；匹配则版本 +1 且系统块保持', async () => {
    const { ids, run } = await seedCompletedRun()
    const draft = await createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    await expect(
      updateManualHandoffDraft(
        database,
        makeActor(ids.userId),
        run.id,
        {
          narrative: narrative({ completed: [{ text: 'x', verified: false, refs: [] }] }),
          expectedDraftVersion: draft.draftVersion + 5,
        },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const updated = await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      {
        narrative: narrative({
          completed: [{ text: '目标对齐', verified: true, refs: [] }],
        }),
        expectedDraftVersion: draft.draftVersion,
      },
      idemKey(),
    )
    expect(updated.draftVersion).toBe(draft.draftVersion + 1)
    expect(updated.content?.narrative.completed[0]).toMatchObject({
      text: '目标对齐',
      verified: true,
    })
    expect(updated.content?.system).toEqual(draft.content?.system)
  })

  it('发布校验与不可变版本：未启用/证据无引用/候选引用/跨任务 run 引用都拒绝；发布后编号递增', async () => {
    const { ids, run } = await seedCompletedRun()
    const draft = await createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    // ① 任务未启用约定流程 → 拒绝。
    await expect(
      publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await updateTask(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { agreementEnabled: true },
      idemKey(),
    )

    // ② 证据条目没有引用 → 拒绝。
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      {
        narrative: narrative({
          evidence: [{ text: '测试通过', verified: false, refs: [] }],
        }),
        expectedDraftVersion: draft.draftVersion,
      },
      idemKey(),
    )
    await expect(
      publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // ③ 引用候选 Artifact → 拒绝；发布该 Artifact 后通过。
    const candidateId = randomUUID()
    await database.db.insert(schema.artifacts).values({
      id: candidateId,
      taskId: ids.taskId,
      runId: run.id,
      ownerUserId: ids.userId,
      title: 'out/report.md',
      mediaType: 'text/markdown',
      byteSize: 12,
      sha256: 'f'.repeat(64),
      storageKey: 'sha256/ff/' + 'f'.repeat(60),
      status: 'candidate',
    })
    const withCandidateRef = narrative({
      evidence: [
        {
          text: '报告已产出',
          verified: false,
          refs: [{ kind: 'artifact', artifactId: candidateId }],
        },
      ],
    })
    const draft2 = await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      { narrative: withCandidateRef, expectedDraftVersion: draft.draftVersion + 1 },
      idemKey(),
    )
    await expect(
      publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await database.db
      .update(schema.artifacts)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(schema.artifacts.id, candidateId))

    // ④ 跨任务 run 引用 → 拒绝（同 Team 内另一任务；seedRunPrereqs 的 team 是单例，
    // 不能二次落种子——直接插第二个任务的 Run 行）。
    const otherTaskId = randomUUID()
    await database.db.insert(schema.tasks).values({
      id: otherTaskId,
      projectId: ids.projectId,
      title: '另一个任务',
      assigneeUserId: ids.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: ids.userId,
    })
    const otherRunId = await insertRunRow(database.db, {
      taskId: otherTaskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
    })
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      {
        narrative: narrative({
          downstream: [
            {
              text: '外部依赖',
              verified: false,
              refs: [{ kind: 'run', runId: otherRunId }],
            },
          ],
        }),
        expectedDraftVersion: draft2.draftVersion,
      },
      idemKey(),
    )
    await expect(
      publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // 回到合法形态（本任务 run 引用 × 已发布材料引用）→ 发布成功：v1、系统块只含已发布。
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      { narrative: withCandidateRef, expectedDraftVersion: draft2.draftVersion + 1 },
      idemKey(),
    )
    const published = await publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    expect(published.revision.revisionNumber).toBe(1)
    expect(published.revision.content.system.artifacts).toHaveLength(1)
    expect(published.revision.content.system.artifacts[0]).toMatchObject({
      artifactId: candidateId,
      status: 'published',
    })
    const rows = await draftRows(run.id)
    expect(rows.filter((row) => row.status === 'published')).toHaveLength(1)

    // 发布不可变：草稿已发布 → 再发布 409；再次编辑 → 409（应新建草稿）。
    await expect(
      publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      updateManualHandoffDraft(
        database,
        makeActor(ids.userId),
        run.id,
        { narrative: narrative(), expectedDraftVersion: 1 },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // 修改产生新版本：新手工草稿 → 发布 v2；团队可见列表倒序。
    await createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    // 新草稿同样是空叙述：给它一条带引用的证据再发布。
    const fresh = await getRunHandoffDraft(database.db, run.id, ids.userId)
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      {
        narrative: withCandidateRef,
        expectedDraftVersion: fresh!.draftVersion,
      },
      idemKey(),
    )
    const published2 = await publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    expect(published2.revision.revisionNumber).toBe(2)
    const revisions = await listTaskHandoffRevisions(database.db, ids.taskId)
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1])
  })

  it('已发布后重放原始事件（同 seq）：不新增草稿行、版本不动', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({
          evidence: [{ text: 'e', verified: false, refs: [{ kind: 'run', runId: run.id }] }],
        }),
      }),
    )
    await updateTask(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { agreementEnabled: true },
      idemKey(),
    )
    await publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())

    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: '迟到重放', verified: false, refs: [] }] }),
      }),
    )
    const rows = await draftRows(run.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('published')
    expect(await listTaskHandoffRevisions(database.db, ids.taskId)).toHaveLength(1)
    expect((await getRun(database.db, run.id))?.status).toBe('completed')
  })
})
