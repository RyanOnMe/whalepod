import { eq } from 'drizzle-orm'
import { authorize, asUserId, transitionAssignment, transitionTask } from '@project311/domain'
import type { Actor } from '@project311/domain'
import type { Database, Outbox, TaskRow, Tx } from '@project311/db'
import {
  appendTeamEvent,
  getEnabledMember,
  getTeam,
  hasPublishedArtifactByTask,
  insertComment,
  insertTask,
  listActiveRunsByTask,
  reassignTask,
  setAssignment,
  setTaskStatus,
  schema,
  transactCommand,
  updateTaskFields,
} from '@project311/db'
import { cancelRunInTransaction } from '../run/cancel.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { toCommentView, toTaskView } from './queries.js'
import type { CommentView, TaskView } from './queries.js'

function assertAuthorized(
  actor: Actor,
  action: Parameters<typeof authorize>[1],
  resource: Parameters<typeof authorize>[2],
): void {
  if (!authorize(actor, action, resource)) {
    throw new ApiError(403, 'FORBIDDEN', `not allowed to ${action.replace(/_/g, ' ')}`)
  }
}

/** 锁 Task 行串行化并发状态迁移；不存在统一 404（不可枚举）。 */
async function lockTask(tx: Tx, taskId: string): Promise<TaskRow> {
  const [task] = await tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .for('update')
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  return task
}

async function requireActiveAssignee(tx: Tx, assigneeUserId: string): Promise<void> {
  const team = await getTeam(tx)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  const member = await getEnabledMember(tx, team.id, assigneeUserId)
  if (member === undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'assignee is not an active team member')
  }
}

function taskChangedPayload(task: TaskRow): unknown {
  return {
    taskId: task.id,
    projectId: task.projectId,
    status: task.status,
    assignmentStatus: task.assignmentStatus,
    assigneeUserId: task.assigneeUserId,
  }
}

export interface CreateTaskInput {
  title: string
  description?: string
  assigneeUserId: string
  idempotencyKey: string
}

/** 创建 Task（02 Task 6 Step 3）：Assignment 始终 pending，不静默接受人工指派。 */
export async function createTask(
  database: Database,
  actor: Actor,
  projectId: string,
  input: CreateTaskInput,
): Promise<TaskView> {
  const id = uuidv7()
  return transactCommand(database, `task.create:${input.idempotencyKey}`, async (tx) => {
    const [project] = await tx
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .for('update')
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    if (project.archivedAt !== null) throw new ApiError(409, 'CONFLICT', 'project is archived')
    await requireActiveAssignee(tx, input.assigneeUserId)
    const task = await insertTask(tx, {
      id,
      projectId,
      title: input.title,
      description: input.description ?? '',
      assigneeUserId: input.assigneeUserId,
      createdBy: actor.userId,
    })
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(task) })
    return toTaskView(task)
  })
}

/** 接受 Assignment（03 §3.1：pending → accepted）；仅 assignee。 */
export async function acceptAssignment(
  database: Database,
  actor: Actor,
  taskId: string,
): Promise<TaskView> {
  return database.transaction(async (tx) => {
    const task = await lockTask(tx, taskId)
    assertAuthorized(actor, 'accept_assignment', { assigneeUserId: asUserId(task.assigneeUserId) })
    const next = transitionAssignment(
      { assignmentStatus: task.assignmentStatus },
      { type: 'accept' },
    )
    const now = new Date()
    const updated = await setAssignment(tx, taskId, next.assignmentStatus, now)
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

/** 拒绝 Assignment（03 §3.1：pending → rejected）；仅 assignee，不删 Task。 */
export async function rejectAssignment(
  database: Database,
  actor: Actor,
  taskId: string,
): Promise<TaskView> {
  return database.transaction(async (tx) => {
    const task = await lockTask(tx, taskId)
    assertAuthorized(actor, 'reject_assignment', { assigneeUserId: asUserId(task.assigneeUserId) })
    const next = transitionAssignment(
      { assignmentStatus: task.assignmentStatus },
      { type: 'reject' },
    )
    const updated = await setAssignment(tx, taskId, next.assignmentStatus, null)
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

/** 重新指派（03 §2.2/§3.1：accepted|rejected → pending）；Owner/Admin；有活跃 Run 时拒绝（G2-05）。 */
export async function reassignAssignment(
  database: Database,
  actor: Actor,
  taskId: string,
  assigneeUserId: string,
): Promise<TaskView> {
  if (!authorize(actor, 'reassign_task', {})) {
    throw new ApiError(403, 'FORBIDDEN', 'only owner or admin can reassign a task')
  }
  return database.transaction(async (tx) => {
    const task = await lockTask(tx, taskId)
    const active = await listActiveRunsByTask(tx, taskId)
    if (active.length > 0) {
      throw new ApiError(409, 'CONFLICT', 'cannot reassign a task with an active run')
    }
    transitionAssignment({ assignmentStatus: task.assignmentStatus }, { type: 'reassign' })
    await requireActiveAssignee(tx, assigneeUserId)
    const updated = await reassignTask(tx, taskId, assigneeUserId)
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

/** PATCH /tasks/:taskId：只改非状态字段（03 §4）。 */
export async function updateTask(
  database: Database,
  taskId: string,
  patch: { title?: string; description?: string },
  idempotencyKey: string,
): Promise<TaskView> {
  return transactCommand(database, `task.update:${idempotencyKey}`, async (tx) => {
    await lockTask(tx, taskId)
    const updated = await updateTaskFields(tx, taskId, patch)
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

/**
 * 提交验收（03 §3.1：in_progress → in_review）：accepted assignee、无活跃 Run、
 * 且已有至少一个 published Artifact（02 Task 6 Step 6）。
 */
export async function submitTaskForReview(
  database: Database,
  actor: Actor,
  taskId: string,
): Promise<TaskView> {
  return database.transaction(async (tx) => {
    const task = await lockTask(tx, taskId)
    assertAuthorized(actor, 'submit_review', {
      assigneeUserId: asUserId(task.assigneeUserId),
      assignmentStatus: task.assignmentStatus,
    })
    const active = await listActiveRunsByTask(tx, taskId)
    if (active.length > 0) {
      throw new ApiError(409, 'CONFLICT', 'cannot submit a task with an active run for review')
    }
    if (!(await hasPublishedArtifactByTask(tx, taskId))) {
      throw new ApiError(409, 'CONFLICT', 'task has no published artifact to review')
    }
    const next = transitionTask({ status: task.status }, { type: 'review_submitted' })
    const updated = await setTaskStatus(tx, taskId, next.status)
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

/** 完成 Task（03 §3.1：in_review → done）：accepted assignee 显式完成。 */
export async function completeTask(
  database: Database,
  actor: Actor,
  taskId: string,
): Promise<TaskView> {
  return database.transaction(async (tx) => {
    const task = await lockTask(tx, taskId)
    assertAuthorized(actor, 'complete_task', {
      assigneeUserId: asUserId(task.assigneeUserId),
      assignmentStatus: task.assignmentStatus,
    })
    const next = transitionTask({ status: task.status }, { type: 'complete' })
    const updated = await setTaskStatus(tx, taskId, next.status, new Date())
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

/**
 * 取消 Task（03 §3.1 → cancelled）：accepted assignee；带活跃 Run 时 Task transition 与
 * Run cancel Outbox 在同一 transaction 提交（02 Task 6 Step 6）。
 */
export async function cancelTask(
  database: Database,
  outbox: Outbox,
  actor: Actor,
  taskId: string,
): Promise<TaskView> {
  return database.transaction(async (tx) => {
    const task = await lockTask(tx, taskId)
    assertAuthorized(actor, 'cancel_task', {
      assigneeUserId: asUserId(task.assigneeUserId),
      assignmentStatus: task.assignmentStatus,
    })
    transitionTask({ status: task.status }, { type: 'cancel' })
    const now = new Date()
    // 活跃 Run 在同一事务内请求取消（Run owner == Task assignee，cause='user'）。
    for (const run of await listActiveRunsByTask(tx, taskId)) {
      const [locked] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, run.id))
        .for('update')
      if (locked === undefined) continue
      await cancelRunInTransaction(tx, { outbox, now }, locked, 'user')
    }
    const updated = await setTaskStatus(tx, taskId, 'cancelled', now)
    if (updated === undefined) throw new Error('task vanished in its own transaction')
    await appendTeamEvent(tx, { type: 'task.changed', payload: taskChangedPayload(updated) })
    return toTaskView(updated)
  })
}

export interface AddCommentInput {
  body: string
  idempotencyKey: string
}

/** 添加 Comment（03 §2.2）：Member 可评论；幂等创建 + comment.created 同事务。 */
export async function addComment(
  database: Database,
  actor: Actor,
  taskId: string,
  input: AddCommentInput,
): Promise<CommentView> {
  const id = uuidv7()
  return transactCommand(database, `comment.create:${input.idempotencyKey}`, async (tx) => {
    await lockTask(tx, taskId)
    const comment = await insertComment(tx, {
      id,
      taskId,
      authorUserId: actor.userId,
      body: input.body,
    })
    await appendTeamEvent(tx, {
      type: 'comment.created',
      payload: { commentId: comment.id, taskId, authorUserId: actor.userId },
    })
    return toCommentView(comment)
  })
}
