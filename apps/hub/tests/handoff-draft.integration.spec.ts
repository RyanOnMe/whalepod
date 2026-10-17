/**
 * 交接草稿与版本（#379；ADR-0017 §3-4）集成判据。
 *
 * 覆盖：
 * - 事件落库的幂等与「不复活终态」（迟到事件只更新草稿侧事实）；
 * - 私有边界：草稿只对源 Run owner 可见——其他成员与**管理员**一律 404；
 * - 受众纪律与容量（评审 m1/M1）：非 owner 受众的帧 fail-closed 拒绝（整帧回滚、
 *   不留痕迹）；材料超 64 条落「未生成」失败草稿，绝不把容量错误抛穿 ingest 事务；
 *  内容容量按 DB 的 jsonb 文本口径守（含分隔符），显式路径超限一律 409；
 * - 发布通知（评审 B4）与迟到再造帧短路（F3）、published 档约束（m6/F5）。
 * - owner 手工新建/编辑（CAS）/失败草稿替换；
 * - 发布校验：流程未启用、证据无引用、候选材料引用、跨任务 run 引用一律拒绝；
 *   发布形态系统块只含已发布 Artifact；不可变 + Task 级编号单调递增。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, schema, unwrapPgError } from '@whalepod/db'
import type { HandoffContent, HandoffNarrative } from '@whalepod/protocol'
import {
  HANDOFF_CONTENT_MAX_BYTES,
  HandoffCapacityError,
  assertHandoffContentFits,
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
    // 注记（#99 口径）：直插 artifact 行是**声明式前置**——真实路径要起 Node 经 WS 上传
    // 材料（integration 层没有 Node）；删除条件：hub 提供按 Run 登记材料的 fixture 通道后改走通道。
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

  it('受众纪律（评审 m1）：非 owner 受众的 handoff.draft 帧 fail-closed 拒绝，整帧回滚', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    const content = narrative({
      completed: [{ text: '伪造帧里的私有内容', verified: false, refs: [] }],
    })
    for (const audience of ['project', 'admin'] as const) {
      await expect(
        harness.orchestrator.ingestNodeEvent(
          harness.deviceFor(ids),
          runEventFrame(
            run.id,
            3,
            { type: 'handoff.draft', status: 'generated', content },
            audience,
          ),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    // 拒绝发生在同一事务内：草稿行、run_event 留痕、团队扇出一个都不落
    //（不这样，伪造的 project 行就把私有草稿内容推给了全团队）。
    expect(await draftRows(run.id)).toHaveLength(0)
    const runEvents = await database.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id))
    expect(runEvents.some((row) => row.type === 'handoff.draft')).toBe(false)
    // owner 受众照常落库（被拒事务回滚，不占 seq）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, { type: 'handoff.draft', status: 'generated', content }),
    )
    expect(await draftRows(run.id)).toHaveLength(1)
    expect((await getRun(database.db, run.id))?.status).toBe('completed')
  })

  it('Unicode 防线（评审 F-残余）：带孤立代理项的帧在解析层拒绝，不落任何痕迹', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    // 孤立代理项能过结构与字节上限，但 PG 的 jsonb 编码会以 22P02 拒行——必须在
    // 解析层挡住（毒帧路径回归；与 M1 容量毒帧同一类，此处走 schema 而非容量转换）。
    await expect(
      harness.orchestrator.ingestNodeEvent(
        harness.deviceFor(ids),
        runEventFrame(run.id, 3, {
          type: 'handoff.draft',
          status: 'generated',
          content: narrative({
            completed: [{ text: 'bad \uD800 tail', verified: false, refs: [] }],
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await draftRows(run.id)).toHaveLength(0)
    expect((await getRun(database.db, run.id))?.status).toBe('completed')
    // 正控：同一入口的合法叙述照常落库（拒绝的是码位，不是这条路径）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: '正常内容 😀', verified: false, refs: [] }] }),
      }),
    )
    expect(await draftRows(run.id)).toHaveLength(1)
  })

  it('容量上限（评审 M1）：材料超 64 条 → 落「未生成」失败草稿，ingest 不抛、终态不动', async () => {
    const { ids, harness, run } = await seedCompletedRun()
    // 注记（#99 口径）：直插 65 条 artifact 行是**声明式前置**——真实路径要起 Node 从
    // WS 上传 65 个材料，超出本判据的关切；删除条件同「生成事件落库」用例的注记。
    await database.db.insert(schema.artifacts).values(
      Array.from({ length: 65 }, (_, index) => {
        const digest = String(index).padStart(2, '0').repeat(32)
        return {
          id: randomUUID(),
          taskId: ids.taskId,
          runId: run.id,
          ownerUserId: ids.userId,
          title: `out/${index}.md`,
          mediaType: 'text/markdown',
          byteSize: 1,
          sha256: digest,
          storageKey: `sha256/${digest.slice(0, 2)}/${digest.slice(2)}`,
          status: 'candidate' as const,
        }
      }),
    )
    // 帧照发：容量不足转失败草稿，绝不许把错误抛穿 ingest（抛穿会让 WS 以 4003
    // 反复重连、重发帧永远排不进事务，Run 卡死——评审 M1 实测的毒帧路径）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: 'x', verified: false, refs: [] }] }),
      }),
    )
    const rows = await draftRows(run.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'failed',
      failureReason: 'capacity-exceeded',
      content: null,
      origin: 'auto',
    })
    // 业务终态不受影响；换 seq 重发也不抛（幂等：开放失败草稿已存在 → 跳过）。
    expect((await getRun(database.db, run.id))?.status).toBe('completed')
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 4, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: 'y', verified: false, refs: [] }] }),
      }),
    )
    expect(await draftRows(run.id)).toHaveLength(1)
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
    // 注记同「生成事件落库」用例：直插是声明式前置，删除条件见该处。
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

    // 换**新 seq** 的迟到再造帧：这里的短路才是 alreadyPublished（评审 F3——同 seq 在
    // run_event 去重处就早返，走不到 drafts.ts 的短路；开放草稿唯一索引只覆盖
    // ready/failed，published 行挡不住新 ready 行，保修不修会让该断言失败）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 4, {
        type: 'handoff.draft',
        status: 'generated',
        content: narrative({ completed: [{ text: '换 seq 的迟到帧', verified: false, refs: [] }] }),
      }),
    )
    const rowsAfterNewSeq = await draftRows(run.id)
    expect(rowsAfterNewSeq).toHaveLength(1)
    expect(rowsAfterNewSeq[0]?.status).toBe('published')

    // published 档约束（评审 m6/F5）：failure_reason 非空的 published 行必须被 DB 拒绝
    //（唯一索引不覆盖 published，这一行只会撞 check——插进去才证明约束有效）。
    let constraintError: unknown
    try {
      await database.db.insert(schema.handoffDrafts).values({
        id: randomUUID(),
        taskId: ids.taskId,
        sourceRunId: run.id,
        specRevisionId: null,
        status: 'published',
        content: rowsAfterNewSeq[0]!.content,
        publishedRevisionId: rowsAfterNewSeq[0]!.publishedRevisionId,
        failureReason: 'capacity-exceeded',
        origin: 'auto',
        createdBy: ids.userId,
        createdAt: new Date(),
      })
    } catch (error) {
      constraintError = error
    }
    expect(unwrapPgError(constraintError)).toMatchObject({
      code: '23514',
      constraintName: 'handoff_draft_fields',
    })
  })

  it('显式路径容量（评审 F1/F4）：内容按 DB 的 jsonb 文本口径超 32 KiB → 409，草稿不动', async () => {
    const { ids, run } = await seedCompletedRun()
    // 注记（#99 口径）：直插 artifact 行是声明式前置，理由/删除条件同「生成事件落库」用例。
    // 48 条 × 约 190 字标题 ≈ 16 KiB 系统块——单独不超，配上大叙述必超 32 KiB。
    await database.db.insert(schema.artifacts).values(
      Array.from({ length: 48 }, (_, index) => {
        const digest = String(index).padStart(2, '0').repeat(32)
        return {
          id: randomUUID(),
          taskId: ids.taskId,
          runId: run.id,
          ownerUserId: ids.userId,
          title: `out/${index}.md ${'t'.repeat(180)}`,
          mediaType: 'text/markdown',
          byteSize: 1,
          sha256: digest,
          storageKey: `sha256/${digest.slice(0, 2)}/${digest.slice(2)}`,
          status: 'candidate' as const,
        }
      }),
    )
    const draft = await createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    // 11 × 2000 字 ≈ 22 KiB（单条与整篇的协议 refine 都满足）；+16 KiB 系统块 → 超限。
    const bigNarrative = narrative({
      completed: Array.from({ length: 11 }, (_, index) => ({
        text: `${index}`.padEnd(2000, 'x'),
        verified: false,
        refs: [],
      })),
    })
    await expect(
      updateManualHandoffDraft(
        database,
        makeActor(ids.userId),
        run.id,
        { narrative: bigNarrative, expectedDraftVersion: draft.draftVersion },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // 守卫在落库前：草稿内容保持原样（不是事务半提交，也不是 23514）。
    const view = await getRunHandoffDraft(database.db, run.id, ids.userId)
    expect(view?.content?.narrative.completed).toHaveLength(0)
  })

  it('容量守卫口径（评审 F1）：紧贴上限时按 jsonb 文本口径拒绝，旧口径会放行', () => {
    const withText = (len: number): HandoffContent => ({
      system: { sourceRunId: randomUUID(), specRevision: null, artifacts: [] },
      narrative: narrative({
        completed: [{ text: 'x'.repeat(len), verified: false, refs: [] }],
      }),
    })
    const compactAt = (len: number) => JSON.stringify(withText(len))
    const overhead = compactAt(1000).length - 1000
    const separators = (compactAt(1000).match(/[:,]/g) ?? []).length
    // 距上限 10 字节：只数 JSON.stringify 的旧口径放行（< 上限），但 DB 的 jsonb 文本
    // 会因分隔符补空格而超限——守卫必须在这一条上先拒（上界 ≥ 实际，只会更严格）。
    const candidate = withText(HANDOFF_CONTENT_MAX_BYTES - overhead - 10)
    expect(new TextEncoder().encode(JSON.stringify(candidate)).length).toBeLessThanOrEqual(
      HANDOFF_CONTENT_MAX_BYTES,
    )
    expect(JSON.stringify(candidate).length + separators).toBeGreaterThan(HANDOFF_CONTENT_MAX_BYTES)
    expect(() => assertHandoffContentFits(candidate)).toThrowError(HandoffCapacityError)
  })

  it('发布通知上游房间（评审 B4）：publish 后出现新的 task.changed，版本列表不再等刷新', async () => {
    const { ids, run } = await seedCompletedRun()
    const draft = await createManualHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    await updateTask(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { agreementEnabled: true },
      idemKey(),
    )
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId),
      run.id,
      {
        narrative: narrative({
          evidence: [{ text: '测试通过', verified: false, refs: [{ kind: 'run', runId: run.id }] }],
        }),
        expectedDraftVersion: draft.draftVersion,
      },
      idemKey(),
    )
    const changedForTask = async (): Promise<number> => {
      const rows = await database.db
        .select()
        .from(schema.teamEvents)
        .where(eq(schema.teamEvents.type, 'task.changed'))
      return rows.filter((row) => (row.payload as { taskId?: string }).taskId === ids.taskId).length
    }
    // 增量判据（不依赖事件顺序/清表）：这一条只可能由 publish 自己产生。
    const before = await changedForTask()
    await publishHandoffDraft(database, makeActor(ids.userId), run.id, idemKey())
    expect(await changedForTask()).toBeGreaterThan(before)
  })
})
