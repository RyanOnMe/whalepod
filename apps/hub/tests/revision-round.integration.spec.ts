/**
 * 交付物修订批次（#430；ADR-0021 §5）集成判据。
 *
 * 覆盖：冻结快照、只允许责任人组织/启动、启动复用既有 Run 入口并注入执行上下文、
 * 重复启动不建第二条、新版必须由本轮 Run 产出、复核的作者/责任人权限与理由，
 * 以及后来补充的批注不进入已启动批次。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  claimArtifactRevisionRoundStart,
  getArtifactRevisionRound,
  getRun,
  insertArtifact,
  schema,
} from '@whalepod/db'
import { ArtifactStore } from '../src/modules/artifact/store.js'
import { createArtifactComment } from '../src/modules/review/review.js'
import {
  createRevisionRound,
  getRevisionRoundView,
  linkRevisionCandidate,
  listRevisionRoundViews,
  resolveReviewComment,
  startRevisionRound,
} from '../src/modules/review/rounds.js'
import {
  createTestDatabase,
  idemKey,
  insertRunRow,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
  seedSecondUserDevice,
  TEST_DSH_VERSION,
} from './helpers.js'

const TEXT = '第一段：订单号 orderId 必填。\n第二段：重复字段 orderId 出现在两处。\n结束。'

function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('artifact revision round (#430)', () => {
  let database: Database
  let store: ArtifactStore
  let storeRoot: string

  beforeAll(async () => {
    database = await createTestDatabase()
    storeRoot = await mkdtemp(join(tmpdir(), 'whalepod-round-'))
    store = new ArtifactStore({ root: storeRoot })
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
    await rm(storeRoot, { recursive: true, force: true })
  })

  async function seedSource() {
    const ids = await seedRunPrereqs(database.db)
    const receiver = await seedSecondUserDevice(database.db, ids)
    const sourceRunId = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
      dshSessionId: 'source-session',
    })
    const bytes = Buffer.from(TEXT, 'utf8')
    const blob = await store.saveUpload(hashOf(bytes), bytes)
    // 注记（#99 口径）：直插 artifact 行是**声明式前置**——真实路径要起 Node 经 WS
    // 上传材料并由责任人发布（integration 层没有 Node）；删除条件：Hub 提供按 Run
    // 登记材料的 fixture 通道后改走通道。本轮判据只关心批次/快照/复核语义。
    const sourceId = randomUUID()
    await insertArtifact(database.db, {
      id: sourceId,
      taskId: ids.taskId,
      runId: sourceRunId,
      ownerUserId: ids.userId,
      title: '接口约定.md',
      mediaType: 'text/markdown',
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      storageKey: blob.storageKey,
    })
    await database.db
      .update(schema.artifacts)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(schema.artifacts.id, sourceId))
    const refBytes = Buffer.from('参考资料：字段命名规范\n', 'utf8')
    const refBlob = await store.saveUpload(hashOf(refBytes), refBytes)
    const referenceId = randomUUID()
    await insertArtifact(database.db, {
      id: referenceId,
      taskId: ids.taskId,
      runId: sourceRunId,
      ownerUserId: ids.userId,
      title: '命名规范.md',
      mediaType: 'text/markdown',
      byteSize: refBlob.byteSize,
      sha256: refBlob.sha256,
      storageKey: refBlob.storageKey,
    })
    await database.db
      .update(schema.artifacts)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(schema.artifacts.id, referenceId))
    return { ids, receiver, sourceRunId, sourceId, referenceId }
  }

  async function seedComments(
    ids: { userId: string },
    receiver: { userId: string },
    sourceId: string,
  ) {
    const owner = makeActor(ids.userId)
    const member = makeActor(receiver.userId, 'member')
    const first = await createArtifactComment(
      database,
      store,
      member,
      sourceId,
      { body: '字段名要统一。' },
      idemKey(),
    )
    const reply = await createArtifactComment(
      database,
      store,
      owner,
      sourceId,
      { body: '收到，本轮处理。', parentCommentId: first.id },
      idemKey(),
    )
    const second = await createArtifactComment(
      database,
      store,
      member,
      sourceId,
      { body: '第二段也要改。' },
      idemKey(),
    )
    return { first, reply, second }
  }

  function startInput(ids: Awaited<ReturnType<typeof seedRunPrereqs>>) {
    return {
      agentId: ids.agentId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
    }
  }

  const version = async () => TEST_DSH_VERSION

  it('创建批次冻结选定线程（含回复）；非责任人 403', async () => {
    const { ids, receiver, sourceId, referenceId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    await expect(
      createRevisionRound(
        database,
        makeActor(receiver.userId, 'member'),
        ids.taskId,
        { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      {
        sourceArtifactId: sourceId,
        commentIds: [comments.first.id],
        referenceArtifactIds: [referenceId],
        direction: '优先改字段命名',
      },
      idemKey(),
    )
    expect(round.status).toBe('preparing')
    expect(round.sourceArtifact).toMatchObject({ artifactId: sourceId, title: '接口约定.md' })
    expect(round.comments).toHaveLength(1)
    expect(round.comments[0]).toMatchObject({
      commentId: comments.first.id,
      body: '字段名要统一。',
      replies: [{ commentId: comments.reply.id, body: '收到，本轮处理。' }],
    })
    expect(round.references.map((item) => item.artifactId)).toEqual([referenceId])
    expect(round.direction).toBe('优先改字段命名')
  })

  it('启动复用既有 Run：快照写入 run.review_input，执行上下文含意见；后来补的意见不进入', async () => {
    const { ids, receiver, sourceId, sourceRunId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
      idemKey(),
    )
    // 批次创建后才补的意见：只能在下一轮。
    const later = await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      sourceId,
      { body: '补充：分页参数也要核对。' },
      idemKey(),
    )
    const harness = makeHarness(database)
    const started = await startRevisionRound(
      database,
      harness.orchestrator,
      makeActor(ids.userId),
      round.id,
      { ...startInput(ids), resumeFromRunId: sourceRunId },
      idemKey(),
      version,
    )
    expect(started.status).toBe('started')
    expect(started.runId).not.toBeNull()
    const run = await getRun(database.db, started.runId!)
    expect(run?.reviewInput).toMatchObject({
      roundId: round.id,
      sourceArtifact: { artifactId: sourceId },
      comments: [{ commentId: comments.first.id }],
    })
    expect(JSON.stringify(run?.reviewInput)).not.toContain(later.id)
    // 原稿与参考材料进入同 Task 只读输入清单（不是交接输入）。
    expect(run?.artifactInputManifest?.artifacts.map((item) => item.artifactId)).toContain(sourceId)
    const dispatch = await database.db.select().from(schema.dispatchOutbox)
    const payload = JSON.stringify(dispatch.map((row) => row.payload))
    expect(payload).toContain('本轮交付物审阅修订')
    expect(payload).toContain('字段名要统一。')
    expect(payload).not.toContain(later.id)

    // 重复启动：返回同一 Run，不建第二条。
    const replay = await startRevisionRound(
      database,
      harness.orchestrator,
      makeActor(ids.userId),
      round.id,
      startInput(ids),
      idemKey(),
      version,
    )
    expect(replay.runId).toBe(started.runId)
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, ids.taskId))
    expect(runs).toHaveLength(2) // 原产出 Run + 本轮修订 Run
  })

  it('认领后崩溃恢复：按 run.review_input.roundId 找回 Run，不再建第二条', async () => {
    const { ids, receiver, sourceId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
      idemKey(),
    )
    const stored = await getArtifactRevisionRound(database.db, round.id)
    expect(stored).toBeDefined()
    // 模拟：认领后、回写批次前进程退出（Run 已经建出）。
    await claimArtifactRevisionRoundStart(database.db, round.id)
    const harness = makeHarness(database)
    const created = await harness.orchestrator.create(makeActor(ids.userId), ids.taskId, {
      ...makeCreateInput(ids),
      artifactInputIds: [sourceId],
      reviewInput: stored!.input,
    })
    const recovered = await startRevisionRound(
      database,
      harness.orchestrator,
      makeActor(ids.userId),
      round.id,
      startInput(ids),
      idemKey(),
      version,
    )
    expect(recovered.runId).toBe(created.id)
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, ids.taskId))
    expect(runs).toHaveLength(2)
  })

  it('非责任人不能启动；设备离线明确失败并退回可重试状态', async () => {
    const { ids, receiver, sourceId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
      idemKey(),
    )
    const harness = makeHarness(database)
    await expect(
      startRevisionRound(
        database,
        harness.orchestrator,
        makeActor(receiver.userId, 'member'),
        round.id,
        startInput(ids),
        idemKey(),
        version,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      startRevisionRound(
        database,
        harness.orchestrator,
        makeActor(ids.userId),
        round.id,
        startInput(ids),
        idemKey(),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' })
    expect((await getRevisionRoundView(database.db, round.id)).status).toBe('preparing')
  })

  it('新版必须由本轮 Run 产出；发布后作者可复核、责任人代收口必须写理由', async () => {
    const { ids, receiver, sourceId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
      idemKey(),
    )
    const harness = makeHarness(database)
    const started = await startRevisionRound(
      database,
      harness.orchestrator,
      makeActor(ids.userId),
      round.id,
      startInput(ids),
      idemKey(),
      version,
    )
    const candidateId = randomUUID()
    const bytes = Buffer.from('修订版内容\n', 'utf8')
    const blob = await store.saveUpload(hashOf(bytes), bytes)
    await insertArtifact(database.db, {
      id: candidateId,
      taskId: ids.taskId,
      runId: started.runId!,
      ownerUserId: ids.userId,
      title: '接口约定-v2.md',
      mediaType: 'text/markdown',
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      storageKey: blob.storageKey,
    })
    const linked = await linkRevisionCandidate(
      database,
      makeActor(ids.userId),
      round.id,
      { candidateArtifactId: candidateId },
      idemKey(),
    )
    expect(linked.candidate?.artifactId).toBe(candidateId)
    expect(linked.candidate?.publishedAt).toBeNull()
    expect(
      (await getRevisionRoundView(database.db, round.id, makeActor(receiver.userId, 'member')))
        .candidate,
    ).toBeNull()
    expect(
      (
        await listRevisionRoundViews(database.db, ids.taskId, makeActor(receiver.userId, 'member'))
      )[0]?.candidate,
    ).toBeNull()
    expect(
      (await getRevisionRoundView(database.db, round.id, makeActor(ids.userId))).candidate
        ?.artifactId,
    ).toBe(candidateId)

    // 未发布不能复核。
    await expect(
      resolveReviewComment(database, makeActor(receiver.userId, 'member'), round.id, {
        commentId: comments.first.id,
        status: 'resolved',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await database.db
      .update(schema.artifacts)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(schema.artifacts.id, candidateId))

    expect(
      (await getRevisionRoundView(database.db, round.id, makeActor(receiver.userId, 'member')))
        .candidate?.artifactId,
    ).toBe(candidateId)
    // 作者可确认；责任人代收口必须写理由。
    const resolved = await resolveReviewComment(
      database,
      makeActor(receiver.userId, 'member'),
      round.id,
      { commentId: comments.first.id, status: 'resolved' },
    )
    expect(resolved.resolutions[0]).toMatchObject({
      commentId: comments.first.id,
      status: 'resolved',
      resolvedBy: receiver.userId,
    })
    await expect(
      resolveReviewComment(database, makeActor(ids.userId), round.id, {
        commentId: comments.first.id,
        status: 'needs_work',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const overridden = await resolveReviewComment(database, makeActor(ids.userId), round.id, {
      commentId: comments.first.id,
      status: 'needs_work',
      note: '新版仍未统一 orderId 命名',
    })
    expect(overridden.resolutions[0]).toMatchObject({
      status: 'needs_work',
      resolvedBy: ids.userId,
      note: '新版仍未统一 orderId 命名',
    })
  })

  it('选择边界：回复不能单独入选、跨版本批注 404、未发布参考材料 409', async () => {
    const { ids, receiver, sourceId, sourceRunId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const otherArtifactId = randomUUID()
    const otherBytes = Buffer.from('另一份交付物\n', 'utf8')
    const otherBlob = await store.saveUpload(hashOf(otherBytes), otherBytes)
    await insertArtifact(database.db, {
      id: otherArtifactId,
      taskId: ids.taskId,
      runId: sourceRunId,
      ownerUserId: ids.userId,
      title: '另一份.md',
      mediaType: 'text/markdown',
      byteSize: otherBlob.byteSize,
      sha256: otherBlob.sha256,
      storageKey: otherBlob.storageKey,
    })
    await database.db
      .update(schema.artifacts)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(schema.artifacts.id, otherArtifactId))
    const foreign = await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      otherArtifactId,
      { body: '另一份交付物上的意见' },
      idemKey(),
    )
    await expect(
      createRevisionRound(
        database,
        makeActor(ids.userId),
        ids.taskId,
        { sourceArtifactId: sourceId, commentIds: [comments.reply.id] },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(
      createRevisionRound(
        database,
        makeActor(ids.userId),
        ids.taskId,
        { sourceArtifactId: sourceId, commentIds: [foreign.id] },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const unpublishedId = randomUUID()
    await insertArtifact(database.db, {
      id: unpublishedId,
      taskId: ids.taskId,
      runId: sourceRunId,
      ownerUserId: ids.userId,
      title: '未发布参考.md',
      mediaType: 'text/markdown',
      byteSize: 1,
      sha256: 'c'.repeat(64),
      storageKey: 'sha256/cc/' + 'c'.repeat(60),
    })
    await expect(
      createRevisionRound(
        database,
        makeActor(ids.userId),
        ids.taskId,
        {
          sourceArtifactId: sourceId,
          commentIds: [comments.first.id],
          referenceArtifactIds: [unpublishedId],
        },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('启动边界：未开始不能关联候选；续跑只能指向原产出 Run', async () => {
    const { ids, receiver, sourceId, sourceRunId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
      idemKey(),
    )
    await expect(
      linkRevisionCandidate(
        database,
        makeActor(ids.userId),
        round.id,
        { candidateArtifactId: sourceId },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const harness = makeHarness(database)
    const otherRun = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
      dshSessionId: 'other-session',
    })
    await expect(
      startRevisionRound(
        database,
        harness.orchestrator,
        makeActor(ids.userId),
        round.id,
        { ...startInput(ids), resumeFromRunId: otherRun },
        idemKey(),
        version,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await getRevisionRoundView(database.db, round.id)).status).toBe('preparing')
    expect(sourceRunId).not.toBe(otherRun)
  })

  it('执行上下文超限：启动明确 400，认领退回可修正后重试', async () => {
    const { ids, receiver, sourceId } = await seedSource()
    const commentIds: string[] = []
    for (let i = 0; i < 12; i++) {
      const comment = await createArtifactComment(
        database,
        store,
        makeActor(receiver.userId, 'member'),
        sourceId,
        { body: `${i}:${'x'.repeat(9_990)}` },
        idemKey(),
      )
      commentIds.push(comment.id)
    }
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds },
      idemKey(),
    )
    const harness = makeHarness(database)
    await expect(
      startRevisionRound(
        database,
        harness.orchestrator,
        makeActor(ids.userId),
        round.id,
        startInput(ids),
        idemKey(),
        version,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect((await getRevisionRoundView(database.db, round.id)).status).toBe('preparing')
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, ids.taskId))
    expect(runs).toHaveLength(1) // 只有原产出 Run
  })

  it('候选不属于本轮 Run / 第二轮新版：明确拒绝', async () => {
    const { ids, receiver, sourceId, referenceId } = await seedSource()
    const comments = await seedComments(ids, receiver, sourceId)
    const round = await createRevisionRound(
      database,
      makeActor(ids.userId),
      ids.taskId,
      { sourceArtifactId: sourceId, commentIds: [comments.first.id] },
      idemKey(),
    )
    const harness = makeHarness(database)
    await startRevisionRound(
      database,
      harness.orchestrator,
      makeActor(ids.userId),
      round.id,
      startInput(ids),
      idemKey(),
      version,
    )
    await expect(
      linkRevisionCandidate(
        database,
        makeActor(ids.userId),
        round.id,
        { candidateArtifactId: referenceId },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
