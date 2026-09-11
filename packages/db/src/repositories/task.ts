import { asc, desc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { projects, taskMessages, tasks } from '../schema/project.js'

export type ProjectRow = typeof projects.$inferSelect
export type TaskRow = typeof tasks.$inferSelect
export type TaskMessageRow = typeof taskMessages.$inferSelect

export interface NewProject {
  id: string
  name: string
  description?: string
  createdBy: string
}

export async function insertProject(handle: DbHandle, project: NewProject): Promise<ProjectRow> {
  const [row] = await handle.insert(projects).values(project).returning()
  if (row === undefined) throw new Error('insert project returned no row')
  return row
}

export async function getProject(handle: DbHandle, id: string): Promise<ProjectRow | undefined> {
  const [row] = await handle.select().from(projects).where(eq(projects.id, id)).limit(1)
  return row
}

export interface NewTask {
  id: string
  projectId: string
  title: string
  description?: string
  status?: TaskRow['status']
  assigneeUserId: string
  assignmentStatus?: TaskRow['assignmentStatus']
  createdBy: string
  acceptedAt?: Date
}

export async function insertTask(handle: DbHandle, task: NewTask): Promise<TaskRow> {
  const [row] = await handle.insert(tasks).values(task).returning()
  if (row === undefined) throw new Error('insert task returned no row')
  return row
}

export async function getTask(handle: DbHandle, id: string): Promise<TaskRow | undefined> {
  const [row] = await handle.select().from(tasks).where(eq(tasks.id, id)).limit(1)
  return row
}

/**
 * 项目内任务列表（#137：项目页任务列表的数据源）。
 * 排序契约：updatedAt DESC + id 作 tiebreak——「最近动过的在最前」是列表的可用性
 * 前提；id tiebreak 保证同毫秒写入时顺序仍确定（UI 不抖动）。
 */
export async function listTasksByProject(handle: DbHandle, projectId: string): Promise<TaskRow[]> {
  return handle
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
}

export async function setTaskStatus(
  handle: DbHandle,
  id: string,
  status: TaskRow['status'],
  completedAt?: Date,
): Promise<TaskRow | undefined> {
  const [row] = await handle
    .update(tasks)
    .set(completedAt !== undefined ? { status, completedAt } : { status })
    .where(eq(tasks.id, id))
    .returning()
  return row
}

/**
 * 线程消息的写入形状（#185 / ADR-0009 决策 2）。
 *
 * 讨论消息只需 id/taskId/authorUserId/body（kind/origin 走默认值 human/discussion）；
 * 指令与追问要显式给 kind、targetAgentId、instructionState（追问另需 runId）——DB 的
 * check 约束会拒绝「讨论带了 Agent/Run/受理状态」与「指令缺受理状态」这类组合。
 */
export interface NewTaskMessage {
  id: string
  taskId: string
  authorUserId: string
  body: string
  kind?: 'discussion' | 'instruction' | 'followup'
  origin?: 'human' | 'auto_assignment'
  targetAgentId?: string | undefined
  runId?: string | undefined
  instructionState?: 'pending' | 'accepted' | 'rejected' | undefined
  /** 显式创建时间（默认 now()）；迁移测试与回填用。 */
  createdAt?: Date | undefined
}

export async function insertMessage(
  handle: DbHandle,
  message: NewTaskMessage,
): Promise<TaskMessageRow> {
  const [row] = await handle.insert(taskMessages).values(message).returning()
  if (row === undefined) throw new Error('insert message returned no row')
  return row
}

/**
 * 线程读取：按 `(createdAt, id)` 排序。`id` 是**决胜键**不是插入序（uuidv7 低位随机），
 * 它保证的是**确定性**——同一毫秒创建的多条消息每次读出的顺序一致。
 */
export async function listMessages(handle: DbHandle, taskId: string): Promise<TaskMessageRow[]> {
  return handle
    .select()
    .from(taskMessages)
    .where(eq(taskMessages.taskId, taskId))
    .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id))
}

/** 列出全部 Project（单 Team，所有未停用成员可见；03 §2.2）。 */
export async function listProjects(handle: DbHandle): Promise<ProjectRow[]> {
  return handle.select().from(projects).orderBy(asc(projects.createdAt))
}

/** PATCH /tasks/:taskId：只改非状态字段；updatedAt 由 task_set_updated_at 触发器写。 */
export async function updateTaskFields(
  handle: DbHandle,
  id: string,
  patch: { title?: string; description?: string },
): Promise<TaskRow | undefined> {
  const set: Record<string, unknown> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.description !== undefined) set.description = patch.description
  if (Object.keys(set).length === 0) return getTask(handle, id)
  const [row] = await handle.update(tasks).set(set).where(eq(tasks.id, id)).returning()
  return row
}

/** 迁移 Assignment 状态（accept→accepted、reject→rejected、reassign→pending）。 */
export async function setAssignment(
  handle: DbHandle,
  id: string,
  assignmentStatus: TaskRow['assignmentStatus'],
  acceptedAt: Date | null,
): Promise<TaskRow | undefined> {
  const [row] = await handle
    .update(tasks)
    .set({ assignmentStatus, acceptedAt })
    .where(eq(tasks.id, id))
    .returning()
  return row
}

/**
 * 重新指派：assignee 变化后 assignment_status 重置为 pending（03 §2.2/§3.1）。
 * 调用方负责「无活跃 Run」守卫（G2-05）与新 assignee 存在性校验。
 */
export async function reassignTask(
  handle: DbHandle,
  id: string,
  assigneeUserId: string,
): Promise<TaskRow | undefined> {
  const [row] = await handle
    .update(tasks)
    .set({ assigneeUserId, assignmentStatus: 'pending', acceptedAt: null })
    .where(eq(tasks.id, id))
    .returning()
  return row
}
