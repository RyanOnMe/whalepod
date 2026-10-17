/**
 * 交接交付与接收确认（#380；ADR-0017 §5）。
 *
 * 闭环第三段：上游发布（#379）后 `deliver`——选成员、创建或关联**同项目**下游
 * Task、落 pending receipt；接收方 `confirm`（「本次准备做什么」必填，差异可选且
 * 复用讨论落上游 Task）；上游出新版本后接收方 `adopt` 产生**新** receipt（理解必填），
 * 旧 receipt 与旧 Run 永远保留原版本。
 *
 * 幂等与守卫：
 * - deliver：任务创建走 `task.create`（自带幂等台账），receipt 走
 *   `handoff.deliver` + `(downstream_task_id, revision_id)` 唯一——重放收敛；
 * - confirm/adopt：`transactCommand` 台账 + 状态早返回，重复点击不重复创建；
 * - 确认 ≠ 接受 Task、不自动启动 Run（本模块**不碰** run 表）。
 */
import type { Actor } from '@whalepod/domain'
import type {
  Database,
  DbHandle,
  HandoffReceiptRow,
  HandoffRevisionRow,
  TaskRow,
} from '@whalepod/db'
import {
  appendTeamEvent,
  confirmHandoffReceipt,
  getEnabledMember,
  getHandoffReceipt,
  getHandoffRevision,
  getTask,
  getTeam,
  insertHandoffReceiptIfAbsent,
  latestHandoffRevisionNumber,
  listReceiptsByDownstreamTask,
  listReceiptsByUpstreamTask,
  schema,
  transactCommand,
} from '@whalepod/db'
import { desc, eq } from 'drizzle-orm'
import {
  HANDOFF_DIFFERENCE_PREFIX,
  HandoffReceiptViewSchema,
  type ConfirmHandoffReceiptRequest,
  type DeliverHandoffRequest,
  type HandoffReceiptView,
} from '@whalepod/protocol'
import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/http-error.js'
import { addComment, createTask, taskChangedPayload } from '../task/commands.js'

function toReceiptView(
  receipt: HandoffReceiptRow,
  revision: HandoffRevisionRow,
  titles: { upstreamTaskTitle: string; downstreamTaskTitle: string },
  latestRevisionNumber: number,
): HandoffReceiptView {
  return HandoffReceiptViewSchema.parse({
    id: receipt.id,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    latestRevisionNumber,
    upstreamTaskId: receipt.upstreamTaskId,
    upstreamTaskTitle: titles.upstreamTaskTitle,
    downstreamTaskId: receipt.downstreamTaskId,
    downstreamTaskTitle: titles.downstreamTaskTitle,
    receiverUserId: receipt.receiverUserId,
    deliveredByUserId: receipt.deliveredBy,
    status: receipt.status,
    understanding: receipt.understanding,
    differences: receipt.differences,
    createdAt: receipt.createdAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
    confirmedAt: receipt.confirmedAt?.toISOString() ?? null,
  })
}

/** 一个任务的完整读（交付/确认要在视图里带两个 Task 的标题）。 */
async function loadReceiptView(handle: DbHandle, receiptId: string): Promise<HandoffReceiptView> {
  const receipt = await getHandoffReceipt(handle, receiptId)
  if (receipt === undefined) throw new ApiError(404, 'NOT_FOUND', 'handoff receipt not found')
  const [revision, upstream, downstream] = await Promise.all([
    getHandoffRevision(handle, receipt.revisionId),
    getTask(handle, receipt.upstreamTaskId),
    getTask(handle, receipt.downstreamTaskId),
  ])
  if (revision === undefined || upstream === undefined || downstream === undefined) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'handoff receipt references missing rows')
  }
  const latest = await latestHandoffRevisionNumber(handle, upstream.id)
  return toReceiptView(
    receipt,
    revision,
    { upstreamTaskTitle: upstream.title, downstreamTaskTitle: downstream.title },
    latest,
  )
}

/** 差异复用讨论：非空差异作为一条讨论消息落在**上游 Task**（幂等键随确认请求）。 */
async function postDifferences(
  database: Database,
  actor: Actor,
  upstreamTaskId: string,
  differences: string | undefined,
  idempotencyKey: string,
): Promise<void> {
  if (differences === undefined || differences.trim().length === 0) return
  await addComment(database, actor, upstreamTaskId, {
    body: `${HANDOFF_DIFFERENCE_PREFIX}${differences}`,
    idempotencyKey: `${idempotencyKey}:differences`,
  })
}

/**
 * 交付（上游 Task 责任人）：新建或关联同项目下游 Task（责任人 = 被选成员），
 * 落 pending receipt。新建任务与 receipt 各自带幂等台账——重放收敛、不重复创建。
 */
export async function deliverHandoff(
  database: Database,
  actor: Actor,
  revisionId: string,
  input: DeliverHandoffRequest,
  idempotencyKey: string,
): Promise<HandoffReceiptView> {
  const revision = await getHandoffRevision(database.db, revisionId.toLowerCase())
  if (revision === undefined) throw new ApiError(404, 'NOT_FOUND', 'handoff revision not found')
  const upstream = await getTask(database.db, revision.taskId)
  if (upstream === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  if (upstream.assigneeUserId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the upstream task assignee can deliver this package')
  }
  // 接收人必须是**在册且启用**的成员（停用账号不能成为新一轮工作的人）。
  const team = await getTeam(database.db)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  const receiver = await getEnabledMember(database.db, team.id, input.receiverUserId)
  if (receiver === undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'receiver is not an active team member')
  }

  let downstream: TaskRow
  if (input.downstreamTaskId !== undefined) {
    const row = await getTask(database.db, input.downstreamTaskId.toLowerCase())
    // 跨项目 / 不存在一律 404：这个项目之外没有可用的下游 Task。
    if (row === undefined || row.projectId !== upstream.projectId) {
      throw new ApiError(404, 'NOT_FOUND', 'downstream task not found in this project')
    }
    if (row.id === upstream.id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'downstream task must differ from upstream task')
    }
    if (row.assigneeUserId !== input.receiverUserId) {
      throw new ApiError(409, 'CONFLICT', 'the downstream task is not assigned to the receiver')
    }
    if (row.status === 'done' || row.status === 'cancelled') {
      throw new ApiError(409, 'CONFLICT', 'the downstream task is already finished')
    }
    downstream = row
  } else {
    // `${key}:task`：与 receipt 的台账分开，重放时各自收敛到同一条。
    const created = await createTask(database, actor, upstream.projectId, {
      title: input.newTask!.title,
      ...(input.newTask!.description !== undefined
        ? { description: input.newTask!.description }
        : {}),
      assigneeUserId: input.receiverUserId,
      idempotencyKey: `${idempotencyKey}:task`,
    })
    const row = await getTask(database.db, created.id)
    if (row === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'created task not found')
    downstream = row
  }

  const receipt = await transactCommand(
    database,
    `handoff.deliver:${idempotencyKey}`,
    async (tx) => {
      const { row } = await insertHandoffReceiptIfAbsent(tx, {
        id: randomUUID(),
        revisionId: revision.id,
        upstreamTaskId: upstream.id,
        downstreamTaskId: downstream.id,
        receiverUserId: input.receiverUserId,
        deliveredBy: actor.userId,
        createdAt: new Date(),
      })
      // 关联既有任务时创建路径没有事件；新建路径这里再发一次也无害（同形事实）。
      await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(downstream) })
      // 评审 B9：上游「已交接」列表也是 team-visible 事实——只发下游，上游房间里
      // 别人要等刷新才看见新增的交接行。
      await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(upstream) })
      return row
    },
  )
  return loadReceiptView(database.db, receipt.id)
}

/** 命令层最低校验（HTTP 之外也要 fail-closed；与协议 schema 同口径）。 */
function assertConfirmInput(input: ConfirmHandoffReceiptRequest): void {
  if (input.understanding.trim().length === 0) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'understanding is required')
  }
  if (input.understanding.length > 10000) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'understanding is too long')
  }
  if ((input.differences ?? '').length > 10000) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'differences are too long')
  }
}

/**
 * 接收方确认：写「本次准备做什么」（必填）+ 可选差异；pending → confirmed。
 * 重复确认幂等（状态早返回，不覆盖首次理解）。确认不启动任何 Run。
 */
export async function confirmReceipt(
  database: Database,
  actor: Actor,
  receiptId: string,
  input: ConfirmHandoffReceiptRequest,
  idempotencyKey: string,
): Promise<HandoffReceiptView> {
  assertConfirmInput(input)
  const existing = await getHandoffReceipt(database.db, receiptId)
  if (existing === undefined) throw new ApiError(404, 'NOT_FOUND', 'handoff receipt not found')
  if (existing.receiverUserId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the receiver can confirm this handoff')
  }
  const now = new Date()
  const outcome = await transactCommand(
    database,
    `handoff.confirm:${idempotencyKey}`,
    async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.handoffReceipts)
        .where(eq(schema.handoffReceipts.id, receiptId))
        .for('update')
      if (locked === undefined) throw new ApiError(404, 'NOT_FOUND', 'handoff receipt not found')
      // 幂等：首次理解不回写；**这不是一次状态迁移**（评审 m4）——差异消息因此不
      // 重复发（重复发只会污染上游讨论流，旧理解已被回执确认）。
      if (locked.status === 'confirmed') return { id: locked.id, transitioned: false }
      await confirmHandoffReceipt(tx, receiptId, input.understanding, input.differences, now)
      // 收件方与上游两侧房间都要实时看到状态变化（同一事务、同形载荷）。
      const downstream = await getTask(tx, locked.downstreamTaskId)
      if (downstream !== undefined) {
        await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(downstream) })
      }
      const upstream = await getTask(tx, locked.upstreamTaskId)
      if (upstream !== undefined) {
        await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(upstream) })
      }
      // 命令台账的 result 必须可序列化（NOT NULL）：回执只记到 id+状态。
      return { id: locked.id, transitioned: true }
    },
  )
  if (outcome.transitioned) {
    await postDifferences(
      database,
      actor,
      existing.upstreamTaskId,
      input.differences,
      idempotencyKey,
    )
  }
  return loadReceiptView(database.db, receiptId)
}

/**
 * 采用新版本：上游出新版本后接收方显式 adopt —— 以最新已发布版本产生**新的
 * confirmed receipt**（理解必填），旧 receipt 保留原版本。无新版本 → 409。
 * 重复采用（同 downstream + revision）幂等返回既有 receipt。
 */
export async function adoptReceipt(
  database: Database,
  actor: Actor,
  receiptId: string,
  input: ConfirmHandoffReceiptRequest,
  idempotencyKey: string,
): Promise<HandoffReceiptView> {
  assertConfirmInput(input)
  const existing = await getHandoffReceipt(database.db, receiptId)
  if (existing === undefined) throw new ApiError(404, 'NOT_FOUND', 'handoff receipt not found')
  if (existing.receiverUserId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the receiver can adopt a new version')
  }
  const current = await getHandoffRevision(database.db, existing.revisionId)
  if (current === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'handoff revision lost')
  const outcome = await transactCommand(database, `handoff.adopt:${idempotencyKey}`, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.handoffRevisions)
      .where(eq(schema.handoffRevisions.taskId, existing.upstreamTaskId))
      .orderBy(desc(schema.handoffRevisions.revisionNumber))
      .limit(1)
    const newest = rows[0]
    if (newest === undefined || newest.revisionNumber <= current.revisionNumber) {
      throw new ApiError(409, 'CONFLICT', '上游没有更新的交接版本可采纳')
    }
    const { row, inserted } = await insertHandoffReceiptIfAbsent(tx, {
      id: randomUUID(),
      revisionId: newest.id,
      upstreamTaskId: existing.upstreamTaskId,
      downstreamTaskId: existing.downstreamTaskId,
      receiverUserId: existing.receiverUserId,
      deliveredBy: actor.userId,
      confirmed: {
        understanding: input.understanding,
        ...(input.differences !== undefined ? { differences: input.differences } : {}),
        confirmedAt: new Date(),
      },
      createdAt: new Date(),
    })
    const downstream = await getTask(tx, existing.downstreamTaskId)
    if (downstream !== undefined) {
      await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(downstream) })
    }
    const upstream = await getTask(tx, existing.upstreamTaskId)
    if (upstream !== undefined) {
      await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(upstream) })
    }
    return { row, inserted }
  })
  // 评审 m4：只有真的产生新 receipt 才发差异消息（重复采用幂等返回，不重复打扰上游）。
  if (outcome.inserted) {
    await postDifferences(
      database,
      actor,
      existing.upstreamTaskId,
      input.differences,
      idempotencyKey,
    )
  }
  return loadReceiptView(database.db, outcome.row.id)
}

/** 下游 Task 的接收关系列表（下播「有新版本」的数据源）。 */
export async function listDownstreamReceipts(
  handle: DbHandle,
  taskId: string,
): Promise<HandoffReceiptView[]> {
  const rows = await listReceiptsByDownstreamTask(handle, taskId)
  const task = await getTask(handle, taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  const latestByUpstream = new Map<string, number>()
  const views: HandoffReceiptView[] = []
  for (const row of rows) {
    let latest = latestByUpstream.get(row.receipt.upstreamTaskId)
    if (latest === undefined) {
      latest = await latestHandoffRevisionNumber(handle, row.receipt.upstreamTaskId)
      latestByUpstream.set(row.receipt.upstreamTaskId, latest)
    }
    views.push(
      toReceiptView(
        row.receipt,
        row.revision,
        { upstreamTaskTitle: row.upstreamTaskTitle, downstreamTaskTitle: task.title },
        latest,
      ),
    )
  }
  return views
}

/** 上游 Task 的「已交接」列表。 */
export async function listUpstreamDeliveries(
  handle: DbHandle,
  taskId: string,
): Promise<HandoffReceiptView[]> {
  const rows = await listReceiptsByUpstreamTask(handle, taskId)
  const task = await getTask(handle, taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  const latest = await latestHandoffRevisionNumber(handle, taskId)
  return rows.map((row) =>
    toReceiptView(
      row.receipt,
      row.revision,
      { upstreamTaskTitle: task.title, downstreamTaskTitle: row.downstreamTaskTitle },
      latest,
    ),
  )
}
