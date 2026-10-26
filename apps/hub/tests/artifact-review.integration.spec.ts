/**
 * 交付物审阅（#429；ADR-0021 §2-4）集成判据。
 *
 * 覆盖：整件/原位批注、重复文字消歧与无法定位明确失败、回复边界、审阅邀请权限与
 * 幂等、提交本轮意见（含本轮无意见）、待办身份与消失。真实发布前的 Artifact 行
 * 按声明式前置直插（与 handoff 集成同一口径与注记）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertArtifact, schema, setArtifactStatus } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import { ArtifactStore } from '../src/modules/artifact/store.js'
import {
  createArtifactComment,
  getArtifactReviewView,
  inviteReviewers,
  submitArtifactReview,
} from '../src/modules/review/review.js'
import { personalAttention } from '../src/modules/task/attention.js'
import {
  createTestDatabase,
  idemKey,
  insertRunRow,
  makeActor,
  resetDatabase,
  seedRunPrereqs,
  seedSecondUserDevice,
} from './helpers.js'

const TEXT = '第一段：订单号 orderId 必填。\n第二段：重复字段 orderId 出现在两处。\n结束。'

function sessionActor(userId: string, role: 'owner' | 'admin' | 'member') {
  return {
    sessionId: randomUUID(),
    userId,
    username: userId.slice(0, 8),
    displayName: 'Member',
    role,
  }
}

describe('artifact review (#429)', () => {
  let database: Database
  let store: ArtifactStore
  let storeRoot: string

  beforeAll(async () => {
    database = await createTestDatabase()
    storeRoot = await mkdtemp(join(tmpdir(), 'whalepod-review-'))
    store = new ArtifactStore({ root: storeRoot })
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
    await rm(storeRoot, { recursive: true, force: true })
  })

  /** 已发布文本 Artifact 的声明式前置（真实路径要 Node 经 WS 上传并由 owner 发布）。 */
  async function seedPublishedText(status: 'candidate' | 'published' = 'published') {
    const ids = await seedRunPrereqs(database.db)
    const receiver = await seedSecondUserDevice(database.db, ids)
    const runId = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
    })
    const bytes = Buffer.from(TEXT, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const blob = await store.saveUpload(sha256, bytes)
    const artifact = await insertArtifact(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      runId,
      ownerUserId: ids.userId,
      title: '接口约定.md',
      mediaType: 'text/markdown',
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      storageKey: blob.storageKey,
    })
    if (status === 'published')
      await setArtifactStatus(database.db, artifact.id, 'published', new Date())
    return { ids, receiver, artifactId: artifact.id, runId }
  }

  function anchorFor(offset: number, quote: string) {
    return {
      quote,
      prefix: TEXT.slice(Math.max(0, offset - 8), offset),
      suffix: TEXT.slice(offset + quote.length, offset + quote.length + 8),
      start: offset,
      end: offset + quote.length,
    }
  }

  it('整件批注：团队成员可读可写，回复只有一层', async () => {
    const { ids, receiver, artifactId } = await seedPublishedText()
    const commentKey = idemKey()
    const comment = await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      artifactId,
      { body: '整体方向可以。' },
      commentKey,
    )
    const replayed = await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      artifactId,
      { body: '整体方向可以。' },
      commentKey,
    )
    expect(replayed.id).toBe(comment.id)
    expect(comment.kind).toBe('whole')
    expect(comment.anchor).toBeNull()
    const reply = await createArtifactComment(
      database,
      store,
      makeActor(ids.userId),
      artifactId,
      { body: '收到。', parentCommentId: comment.id },
      idemKey(),
    )
    expect(reply.parentCommentId).toBe(comment.id)
    await expect(
      createArtifactComment(
        database,
        store,
        makeActor(receiver.userId, 'member'),
        artifactId,
        { body: '嵌套回复', parentCommentId: reply.id },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const view = await getArtifactReviewView(
      database.db,
      makeActor(receiver.userId, 'member'),
      artifactId,
    )
    expect(view.comments).toHaveLength(2)
    expect(view.reading).toBe('text')
  })

  it('原位批注：重复文字靠前后文消歧，偏移过期可唯一重定位', async () => {
    const { receiver, artifactId } = await seedPublishedText()
    const second = TEXT.indexOf('orderId', TEXT.indexOf('orderId') + 1)
    expect(second).toBeGreaterThan(0)
    const anchor = anchorFor(second, 'orderId')
    // 模拟过期偏移：内容没变，但客户端给的 start 旧了——服务端按 quote+上下文改正。
    const comment = await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      artifactId,
      { body: '这里的字段名要统一。', anchor: { ...anchor, start: 0, end: 7 } },
      idemKey(),
    )
    expect(comment.anchor).toMatchObject({ start: second, end: second + 7, quote: 'orderId' })
  })

  it('无法唯一定位：重复文字没有上下文时明确失败，不猜位置', async () => {
    const { receiver, artifactId } = await seedPublishedText()
    await expect(
      createArtifactComment(
        database,
        store,
        makeActor(receiver.userId, 'member'),
        artifactId,
        {
          body: '哪里？',
          anchor: { quote: 'orderId', prefix: '', suffix: '', start: 0, end: 7 },
        },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'ANCHOR_NOT_FOUND' })
  })

  it('非文本 Artifact：拒绝原位批注并引导整件批注', async () => {
    const ids = await seedRunPrereqs(database.db)
    const receiver = await seedSecondUserDevice(database.db, ids)
    const runId = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
    })
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const blob = await store.saveUpload(sha256, bytes)
    const artifact = await insertArtifact(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      runId,
      ownerUserId: ids.userId,
      title: '截图.png',
      mediaType: 'image/png',
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      storageKey: blob.storageKey,
    })
    await setArtifactStatus(database.db, artifact.id, 'published', new Date())
    await expect(
      createArtifactComment(
        database,
        store,
        makeActor(receiver.userId, 'member'),
        artifact.id,
        { body: '这里', anchor: anchorFor(0, '第') },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'ANCHOR_UNSUPPORTED' })
  })

  it('候选只有拥有者可见：其他成员读面与批注一律 404', async () => {
    const ids = await seedRunPrereqs(database.db)
    const receiver = await seedSecondUserDevice(database.db, ids)
    const runId = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
    })
    const artifact = await insertArtifact(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      runId,
      ownerUserId: ids.userId,
      title: '草稿.md',
      mediaType: 'text/markdown',
      byteSize: 3,
      sha256: 'a'.repeat(64),
      storageKey: 'sha256/aa/' + 'a'.repeat(60),
    })
    await expect(
      getArtifactReviewView(database.db, makeActor(receiver.userId, 'member'), artifact.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      createArtifactComment(
        database,
        store,
        makeActor(receiver.userId, 'member'),
        artifact.id,
        { body: '偷看' },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('私有候选的拥有者批注不广播身份，发布后批注才产生团队事件', async () => {
    const { ids, receiver, artifactId } = await seedPublishedText('candidate')
    await createArtifactComment(
      database,
      store,
      makeActor(ids.userId),
      artifactId,
      { body: '仅拥有者可见的检查笔记' },
      idemKey(),
    )
    const privateView = await getArtifactReviewView(database.db, makeActor(ids.userId), artifactId)
    expect(privateView.comments).toHaveLength(1)
    await expect(
      getArtifactReviewView(database.db, makeActor(receiver.userId, 'member'), artifactId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const changedEvents = async () =>
      (
        await database.db
          .select()
          .from(schema.teamEvents)
          .where(eq(schema.teamEvents.type, 'artifact.changed'))
      ).filter((row) => (row.payload as { artifactId?: string }).artifactId === artifactId)
    expect(await changedEvents()).toHaveLength(0)

    await setArtifactStatus(database.db, artifactId, 'published', new Date())
    await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      artifactId,
      { body: '发布后团队可见的意见' },
      idemKey(),
    )
    expect(await changedEvents()).toHaveLength(1)
  })

  it('邀请：仅责任人/拥有者；重复邀请收敛；邀请不改变可见性', async () => {
    const { ids, receiver, artifactId } = await seedPublishedText()
    const input = { reviewerUserIds: [receiver.userId], focus: '重点看接口命名' }
    await expect(
      inviteReviewers(database, makeActor(receiver.userId, 'member'), artifactId, input, idemKey()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const inviteKey = idemKey()
    const first = await inviteReviewers(
      database,
      makeActor(ids.userId),
      artifactId,
      input,
      inviteKey,
    )
    // 同键重放必须回放台账里的首次结果（不是靠唯一约束另走一条路径）。
    const replay = await inviteReviewers(
      database,
      makeActor(ids.userId),
      artifactId,
      input,
      inviteKey,
    )
    expect(replay).toEqual(first)
    const reviewerView = await getArtifactReviewView(
      database.db,
      makeActor(receiver.userId, 'member'),
      artifactId,
    )
    expect(reviewerView.invitations).toHaveLength(1)
    expect(reviewerView.capabilities.canInvite).toBe(false)
    expect(reviewerView.capabilities.canSubmitReview).toBe(true)
  })

  it('提交本轮意见：没有意见且非「本轮无意见」被拒；提交后待办消失', async () => {
    const { ids, receiver, artifactId } = await seedPublishedText()
    await inviteReviewers(
      database,
      makeActor(ids.userId),
      artifactId,
      { reviewerUserIds: [receiver.userId] },
      idemKey(),
    )
    const receiverActor = makeActor(receiver.userId, 'member')
    const before = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(before.items[0]).toMatchObject({
      kind: 'submit_review',
      objectId: artifactId,
      runId: null,
    })
    await expect(
      submitArtifactReview(database, receiverActor, artifactId, { noComment: false }, idemKey()),
    ).rejects.toMatchObject({ code: 'NO_COMMENTS' })
    await createArtifactComment(
      database,
      store,
      receiverActor,
      artifactId,
      { body: '字段名建议统一。' },
      idemKey(),
    )
    const submitKey = idemKey()
    const submitted = await submitArtifactReview(
      database,
      receiverActor,
      artifactId,
      { noComment: false },
      submitKey,
    )
    const replay = await submitArtifactReview(
      database,
      receiverActor,
      artifactId,
      { noComment: false },
      submitKey,
    )
    expect(replay).toEqual(submitted)
    expect(submitted.status).toBe('submitted')
    expect(submitted.noComment).toBe(false)
    // 已有批注还说「本轮无意见」是自相矛盾：服务端明确拒绝。
    await expect(
      submitArtifactReview(database, receiverActor, artifactId, { noComment: true }, idemKey()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const after = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(after.items.some((item) => item.kind === 'submit_review')).toBe(false)
  })

  it('带 UTF-8 BOM 的文本：服务端与浏览器都去 BOM，偏移不多 1', async () => {
    const { ids, receiver } = await seedPublishedText()
    const runId = await insertRunRow(database.db, {
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'completed',
    })
    const bytes = Buffer.from('\uFEFF' + TEXT, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const blob = await store.saveUpload(sha256, bytes)
    const artifact = await insertArtifact(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      runId,
      ownerUserId: ids.userId,
      title: '带 BOM.md',
      mediaType: 'text/markdown',
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      storageKey: blob.storageKey,
    })
    await setArtifactStatus(database.db, artifact.id, 'published', new Date())
    const second = TEXT.indexOf('orderId', TEXT.indexOf('orderId') + 1)
    const comment = await createArtifactComment(
      database,
      store,
      makeActor(receiver.userId, 'member'),
      artifact.id,
      { body: 'BOM 也要对得上。', anchor: anchorFor(second, 'orderId') },
      idemKey(),
    )
    expect(comment.anchor).toMatchObject({ start: second, end: second + 7 })
  })

  it('本轮无意见后追加批注：邀请回到待提交，进展不再显示「无意见」', async () => {
    const { ids, receiver, artifactId } = await seedPublishedText()
    await inviteReviewers(
      database,
      makeActor(ids.userId),
      artifactId,
      { reviewerUserIds: [receiver.userId] },
      idemKey(),
    )
    const receiverActor = makeActor(receiver.userId, 'member')
    const noComment = await submitArtifactReview(
      database,
      receiverActor,
      artifactId,
      { noComment: true },
      idemKey(),
    )
    expect(noComment.noComment).toBe(true)
    await createArtifactComment(
      database,
      store,
      receiverActor,
      artifactId,
      { body: '补充一条意见。' },
      idemKey(),
    )
    const view = await getArtifactReviewView(database.db, receiverActor, artifactId)
    expect(view.invitations[0]).toMatchObject({ status: 'pending', noComment: false })
    const queue = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(queue.items.some((item) => item.kind === 'submit_review')).toBe(true)
  })
})
