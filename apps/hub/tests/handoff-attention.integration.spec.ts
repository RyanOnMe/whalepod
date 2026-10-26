/**
 * 交接待办直达（#428；ADR-0021 §6）集成判据。
 *
 * 覆盖：pending receipt 只在接收人队列里出现（对象是 receipt，不是 Task/Run）、
 * 交接事项排在「接受任务」之前、确认理解/接受任务/任务终态后各自消失、
 * 提问走上游讨论且不改变 receipt 状态。真实命令路径（发布→交付→确认），
 * 不直插业务表。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getHandoffReceipt, getTask, schema } from '@whalepod/db'
import type { HandoffNarrative, TaskSpecContent } from '@whalepod/protocol'
import { adoptReceipt, deliverHandoff, confirmReceipt } from '../src/modules/handoff/index.js'
import {
  createManualHandoffDraft,
  publishHandoffDraft,
  updateManualHandoffDraft,
} from '../src/modules/handoff/drafts.js'
import { confirmAgreement, saveAgreementDraft } from '../src/modules/task/agreement.js'
import {
  acceptAssignment,
  addComment,
  cancelTask,
  reassignAssignment,
  updateTask,
} from '../src/modules/task/commands.js'
import { personalAttention } from '../src/modules/task/attention.js'
import {
  createTestDatabase,
  idemKey,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
  seedSecondUserDevice,
} from './helpers.js'

const SPEC_CONTENT: TaskSpecContent = {
  goal: '交付订单查询接口',
  constraints: '不引入新依赖',
  acceptance: '全部用例通过',
  openQuestions: '',
}

function narrative(): HandoffNarrative {
  return {
    completed: [],
    interfaces: [{ text: 'GET /orders', verified: false, refs: [] }],
    unfinished: [],
    decisions: [],
    evidence: [],
    downstream: [],
    commits: [],
    prs: [],
  }
}

function sessionActor(userId: string, role: 'owner' | 'admin' | 'member') {
  return {
    sessionId: randomUUID(),
    userId,
    username: userId.slice(0, 8),
    displayName: 'Member',
    role,
  }
}

describe('handoff attention (#428)', () => {
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

  /** 上游齐备：约定 v1 → 完成业务 Run → 发布交接 v1 → 交付给第二成员。 */
  async function seedPendingHandoff() {
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
    const manual = await createManualHandoffDraft(database, actor, run.id, idemKey())
    await updateManualHandoffDraft(
      database,
      actor,
      run.id,
      { narrative: narrative(), expectedDraftVersion: manual.draftVersion },
      idemKey(),
    )
    // 材料摘要只在有 Artifact 时填写；本用例不依赖材料，直接发布正文。
    const published = await publishHandoffDraft(database, actor, run.id, idemKey())
    const receipt = await deliverHandoff(
      database,
      actor,
      published.revision.id,
      { receiverUserId: receiver.userId, newTask: { title: '前端接入' } },
      idemKey(),
    )
    return { ids, receiver, receipt, revisionId: published.revision.id, runId: run.id, harness }
  }

  it('pending receipt 只进接收人队列；对象是 receipt、不指向 Run', async () => {
    const { ids, receiver, receipt } = await seedPendingHandoff()
    const otherMember = await seedSecondUserDevice(database.db, ids)
    const view = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(view.items[0]).toMatchObject({
      kind: 'confirm_handoff',
      taskId: receipt.downstreamTaskId,
      objectId: receipt.id,
      runId: null,
      taskTitle: '前端接入',
    })
    // 同一任务同时待接受：交接卡在前，接受任务事项仍在（#428）。
    expect(view.items.map((item) => item.kind)).toEqual(['confirm_handoff', 'accept_assignment'])
    for (const actor of [
      sessionActor(ids.userId, 'owner'),
      sessionActor(randomUUID(), 'admin'),
      // 同项目普通成员（不是接收人）也不该看到别人的交接待办。
      sessionActor(otherMember.userId, 'member'),
    ]) {
      const other = await personalAttention(database.db, actor)
      expect(other.items.some((item) => item.kind === 'confirm_handoff')).toBe(false)
      expect(JSON.stringify(other.items)).not.toContain(receipt.id)
    }
  })

  it('交接卡排在「接受任务」之前；确认理解后交接事项消失、接受任务仍在', async () => {
    const { receiver, receipt } = await seedPendingHandoff()
    const receiverActor = sessionActor(receiver.userId, 'member')
    const both = await personalAttention(database.db, receiverActor)
    expect(both.items.map((item) => item.kind)).toEqual(['confirm_handoff', 'accept_assignment'])
    await confirmReceipt(
      database,
      makeActor(receiver.userId, 'member'),
      receipt.id,
      { understanding: '先做列表页' },
      idemKey(),
    )
    const afterConfirm = await personalAttention(database.db, receiverActor)
    expect(afterConfirm.items.map((item) => item.kind)).toEqual(['accept_assignment'])
  })

  it('接受任务后不再有关系待办；交接已确认也不复活', async () => {
    const { receiver, receipt } = await seedPendingHandoff()
    await confirmReceipt(
      database,
      makeActor(receiver.userId, 'member'),
      receipt.id,
      { understanding: '先做列表页' },
      idemKey(),
    )
    await acceptAssignment(database, makeActor(receiver.userId, 'member'), receipt.downstreamTaskId)
    const view = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(view.items).toEqual([])
  })

  it('下游任务终态：待接收事项不再出现', async () => {
    const { receiver, receipt, harness } = await seedPendingHandoff()
    const actor = makeActor(receiver.userId, 'member')
    await acceptAssignment(database, actor, receipt.downstreamTaskId)
    await cancelTask(database, harness.outbox, actor, receipt.downstreamTaskId)
    const view = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(view.items.some((item) => item.kind === 'confirm_handoff')).toBe(false)
  })

  it('改派：未确认回执随责任转移；旧接收人不能再确认，新责任人可确认', async () => {
    const { ids, receiver, receipt } = await seedPendingHandoff()
    await acceptAssignment(database, makeActor(receiver.userId, 'member'), receipt.downstreamTaskId)
    await reassignAssignment(database, makeActor(ids.userId, 'owner'), receipt.downstreamTaskId, {
      assigneeUserId: ids.userId,
      idempotencyKey: idemKey(),
    })
    const oldView = await personalAttention(database.db, sessionActor(receiver.userId, 'member'))
    expect(oldView.items.some((item) => item.kind === 'confirm_handoff')).toBe(false)
    const newView = await personalAttention(database.db, sessionActor(ids.userId, 'owner'))
    expect(newView.items).toContainEqual(
      expect.objectContaining({
        kind: 'confirm_handoff',
        objectId: receipt.id,
        taskId: receipt.downstreamTaskId,
      }),
    )
    await expect(
      confirmReceipt(
        database,
        makeActor(receiver.userId, 'member'),
        receipt.id,
        { understanding: '旧责任人确认' },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const confirmed = await confirmReceipt(
      database,
      makeActor(ids.userId, 'owner'),
      receipt.id,
      { understanding: '新责任人确认' },
      idemKey(),
    )
    expect(confirmed.status).toBe('confirmed')
  })

  it('已确认后改派：同 key 回放仍重判权限，不把旧成功当成当前授权', async () => {
    const { ids, receiver, receipt } = await seedPendingHandoff()
    const key = idemKey()
    const actor = makeActor(receiver.userId, 'member')
    await confirmReceipt(database, actor, receipt.id, { understanding: '首次确认' }, key)
    await acceptAssignment(database, actor, receipt.downstreamTaskId)
    await reassignAssignment(database, makeActor(ids.userId, 'owner'), receipt.downstreamTaskId, {
      assigneeUserId: ids.userId,
      idempotencyKey: idemKey(),
    })
    await expect(
      confirmReceipt(database, actor, receipt.id, { understanding: '重放' }, key),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      confirmReceipt(
        database,
        makeActor(ids.userId, 'owner'),
        receipt.id,
        { understanding: '另一人重放' },
        key,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await getHandoffReceipt(database.db, receipt.id))?.understanding).toBe('首次确认')
  })

  it('改派后已确认回执：新责任人可采纳上游新版本，旧接收人不能代办', async () => {
    const { ids, receiver, receipt, runId } = await seedPendingHandoff()
    await confirmReceipt(
      database,
      makeActor(receiver.userId, 'member'),
      receipt.id,
      { understanding: '按 v1 做' },
      idemKey(),
    )
    await acceptAssignment(database, makeActor(receiver.userId, 'member'), receipt.downstreamTaskId)
    await reassignAssignment(database, makeActor(ids.userId, 'owner'), receipt.downstreamTaskId, {
      assigneeUserId: ids.userId,
      idempotencyKey: idemKey(),
    })
    const manual = await createManualHandoffDraft(
      database,
      makeActor(ids.userId, 'owner'),
      runId,
      idemKey(),
    )
    await updateManualHandoffDraft(
      database,
      makeActor(ids.userId, 'owner'),
      runId,
      { narrative: narrative(), expectedDraftVersion: manual.draftVersion },
      idemKey(),
    )
    await publishHandoffDraft(database, makeActor(ids.userId, 'owner'), runId, idemKey())
    await expect(
      adoptReceipt(
        database,
        makeActor(receiver.userId, 'member'),
        receipt.id,
        { understanding: '旧接收人采用' },
        idemKey(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const adopted = await adoptReceipt(
      database,
      makeActor(ids.userId, 'owner'),
      receipt.id,
      { understanding: '新责任人采用 v2' },
      idemKey(),
    )
    expect(adopted.revisionNumber).toBe(2)
    expect(adopted.receiverUserId).toBe(ids.userId)
    expect(adopted.status).toBe('confirmed')
  })

  it('向上游提问不要求先确认接收，也不改变 receipt 状态', async () => {
    const { ids, receiver, receipt } = await seedPendingHandoff()
    await addComment(database, makeActor(receiver.userId, 'member'), ids.taskId, {
      body: '订单号为空时怎么处理？',
      idempotencyKey: idemKey(),
    })
    expect((await getHandoffReceipt(database.db, receipt.id))?.status).toBe('pending')
    expect((await getTask(database.db, receipt.downstreamTaskId))?.assignmentStatus).toBe('pending')
    const messages = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, ids.taskId))
    expect(messages.some((row) => row.body === '订单号为空时怎么处理？')).toBe(true)
  })
})
