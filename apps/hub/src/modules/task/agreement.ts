/**
 * 任务约定（#378；ADR-0017 §1）：编辑、确认、版本历史。
 *
 * 语义（命令层职责，domain 只持状态边）：
 * - 草稿：每 Task 至多一个；任何成员可落盘（归属记录 created_by），编辑带
 *   `expectedDraftVersion` 并发令牌——不匹配即 409，不覆盖他人版本。
 * - 确认：**仅 Task 真人责任人**；确认的就是「看过的这一版」（draftVersion 必须相等）；
 *   目标不得为空；版本号在 Task 行锁内分配（部分唯一索引兜底）。
 * - 丢弃草稿：责任人或被记录的作者；confirmed 不可删。
 * - `enabled` 开关的重守卫在 updateTask（同事务）；这里只读。
 *
 * 幂等：三个写命令都走 transactCommand 回执（同 key 重放返回首次结果），
 * 「超时重试」不会落出第二份草稿/第二个版本。
 */
import type { TaskSpecContent } from '@whalepod/protocol'
import { TaskAgreementViewSchema, TaskSpecContentSchema } from '@whalepod/protocol'
import { eq } from 'drizzle-orm'
import { transitionTaskSpecRevision } from '@whalepod/domain'
import type { Actor } from '@whalepod/domain'
import type { Database, DbHandle, TaskSpecRevisionRow, TaskRow, Tx } from '@whalepod/db'
import {
  appendTeamEvent,
  confirmSpecDraftCas,
  countConfirmedSpecRevisions,
  deleteSpecDraft,
  getLatestConfirmedSpec,
  getOpenSpecDraft,
  getTask,
  insertSpecDraft,
  listConfirmedSpecRevisions,
  nextSpecRevisionNumber,
  schema,
  transactCommand,
  updateSpecDraftContentCas,
} from '@whalepod/db'
import { TASK_AGREEMENT_HISTORY_LIMIT } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import type { TaskAgreementView, TaskSpecRevisionView } from '@whalepod/protocol'

export function toSpecRevisionView(row: TaskSpecRevisionRow): TaskSpecRevisionView {
  return {
    id: row.id,
    taskId: row.taskId,
    revisionNumber: row.revisionNumber,
    status: row.status,
    content: row.content,
    draftVersion: row.draftVersion,
    origin: row.origin,
    createdByUserId: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    confirmedByUserId: row.confirmedBy,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  }
}

/** 锁 Task 行串行化「编辑 / 确认 / 编号分配」；不存在统一 404（不可枚举）。 */
async function lockTask(tx: Tx, taskId: string): Promise<TaskRow> {
  const [task] = await tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .for('update')
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  return task
}

async function taskChangedPayloadFor(tx: Tx, taskId: string): Promise<unknown> {
  const task = await getTask(tx, taskId)
  return {
    taskId,
    projectId: task?.projectId,
    status: task?.status,
    assignmentStatus: task?.assignmentStatus,
    assigneeUserId: task?.assigneeUserId,
    assigneeAgentId: task?.assigneeAgentId,
    approvalPolicy: task?.approvalPolicy,
    agreementEnabled: task?.agreementEnabled,
  }
}

export interface SaveAgreementDraftInput {
  content: TaskSpecContent
  expectedDraftVersion?: number
}

/**
 * 落盘约定草稿：无开放草稿 → 新建（`expectedDraftVersion` 必须缺省——带了说明
 * 客户端在看旧状态，409 让刷新）；有草稿 → CAS 版本匹配才写。
 */
export async function saveAgreementDraft(
  database: Database,
  actor: Actor,
  taskId: string,
  input: SaveAgreementDraftInput,
  idempotencyKey: string,
): Promise<TaskSpecRevisionView> {
  taskId = taskId.toLowerCase()
  return transactCommand(database, `agreement.save:${idempotencyKey}`, async (tx) => {
    await lockTask(tx, taskId)
    const now = new Date()
    const draft = await getOpenSpecDraft(tx, taskId)
    if (draft === undefined) {
      if (input.expectedDraftVersion !== undefined) {
        throw new ApiError(
          409,
          'CONFLICT',
          '约定草稿已被确认或丢弃；请刷新后重试（不会覆盖已确认版本）',
        )
      }
      const row = await insertSpecDraft(tx, {
        id: uuidv7(),
        taskId,
        content: input.content,
        origin: 'manual',
        createdBy: actor.userId,
        createdAt: now,
      })
      await appendTeamEvent(tx, {
        type: 'task.changed',
        payload: await taskChangedPayloadFor(tx, taskId),
      })
      return toSpecRevisionView(row)
    }
    if (
      input.expectedDraftVersion === undefined ||
      input.expectedDraftVersion !== draft.draftVersion
    ) {
      throw new ApiError(409, 'CONFLICT', '约定草稿已被他人修改；请刷新后重试（未覆盖任何版本）')
    }
    const row = await updateSpecDraftContentCas(
      tx,
      draft.id,
      input.content,
      draft.draftVersion,
      now,
    )
    if (row === undefined) {
      throw new ApiError(409, 'CONFLICT', '约定草稿已被他人修改；请刷新后重试（未覆盖任何版本）')
    }
    await appendTeamEvent(tx, {
      type: 'task.changed',
      payload: await taskChangedPayloadFor(tx, taskId),
    })
    return toSpecRevisionView(row)
  })
}

export interface ConfirmAgreementInput {
  draftVersion: number
}

/** 确认草稿为不可变版本（仅 Task 责任人；版本号在 Task 锁内单调分配）。 */
export async function confirmAgreement(
  database: Database,
  actor: Actor,
  taskId: string,
  input: ConfirmAgreementInput,
  idempotencyKey: string,
): Promise<TaskSpecRevisionView> {
  taskId = taskId.toLowerCase()
  return transactCommand(database, `agreement.confirm:${idempotencyKey}`, async (tx) => {
    const task = await lockTask(tx, taskId)
    if (task.assigneeUserId !== actor.userId) {
      throw new ApiError(403, 'FORBIDDEN', 'only the task assignee can confirm the agreement')
    }
    const draft = await getOpenSpecDraft(tx, taskId)
    if (draft === undefined) {
      throw new ApiError(409, 'CONFLICT', '没有待确认的约定草稿（可能已确认或已丢弃）')
    }
    if (draft.draftVersion !== input.draftVersion) {
      throw new ApiError(409, 'CONFLICT', '约定草稿已更新；请刷新后重新确认')
    }
    const content = TaskSpecContentSchema.parse(draft.content)
    if (content.goal.trim() === '') {
      throw new ApiError(400, 'VALIDATION_FAILED', '任务约定的「目标」不能为空，先补全再确认')
    }
    // 状态边单点校验（对 draft 应用 confirm）；表外状态在此响。
    transitionTaskSpecRevision({ status: draft.status }, { type: 'confirm' })
    const revisionNumber = await nextSpecRevisionNumber(tx, taskId)
    const row = await confirmSpecDraftCas(tx, draft.id, revisionNumber, actor.userId, new Date())
    if (row === undefined) {
      throw new ApiError(409, 'CONFLICT', '约定草稿状态已变化；请刷新后重试')
    }
    await appendTeamEvent(tx, {
      type: 'task.changed',
      payload: await taskChangedPayloadFor(tx, taskId),
    })
    return toSpecRevisionView(row)
  })
}

/** 丢弃开放草稿（责任人或被记录的作者）；confirmed 不可删。幂等：无草稿返回 discarded=false。 */
export async function discardAgreementDraft(
  database: Database,
  actor: Actor,
  taskId: string,
  idempotencyKey: string,
): Promise<{ discarded: boolean }> {
  taskId = taskId.toLowerCase()
  return transactCommand(database, `agreement.discard:${idempotencyKey}`, async (tx) => {
    const task = await lockTask(tx, taskId)
    const draft = await getOpenSpecDraft(tx, taskId)
    if (draft === undefined) return { discarded: false }
    if (task.assigneeUserId !== actor.userId && draft.createdBy !== actor.userId) {
      throw new ApiError(403, 'FORBIDDEN', 'only the task assignee or the draft author can discard')
    }
    const row = await deleteSpecDraft(tx, draft.id)
    if (row === undefined) return { discarded: false }
    await appendTeamEvent(tx, {
      type: 'task.changed',
      payload: await taskChangedPayloadFor(tx, taskId),
    })
    return { discarded: true }
  })
}

/** GET /tasks/:taskId/agreement 的读模型；Task 不存在返回 undefined（路由 404）。 */
export async function getAgreementView(
  handle: DbHandle,
  taskId: string,
): Promise<TaskAgreementView | undefined> {
  const task = await getTask(handle, taskId)
  if (task === undefined) return undefined
  const [draft, latest, history, confirmedCount] = await Promise.all([
    getOpenSpecDraft(handle, taskId),
    getLatestConfirmedSpec(handle, taskId),
    listConfirmedSpecRevisions(handle, taskId, TASK_AGREEMENT_HISTORY_LIMIT),
    countConfirmedSpecRevisions(handle, taskId),
  ])
  return TaskAgreementViewSchema.parse({
    enabled: task.agreementEnabled,
    draft: draft === undefined ? null : toSpecRevisionView(draft),
    confirmed: latest === undefined ? null : toSpecRevisionView(latest),
    history: history.map(toSpecRevisionView),
    confirmedCount,
  })
}
