import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { projects, taskMessages, tasks } from '../schema/project.js'
import { runs } from '../schema/run.js'

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
  /** Agent 指派（#239）：非空时 assignment 由命令层直接落 accepted（Agent 不走人的受理）。 */
  assigneeAgentId?: string
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

/**
 * 最近活动任务（#252 侧栏「最近任务」）：按「最近活动」排序，活动 =
 * greatest(task.updated_at, 该任务最新 task_message.created_at, 该任务最新 run.created_at)。
 * **按活动不按建单**——昨天建、今天有人发言的旧任务要排在刚建的新任务前面。
 */
export interface RecentTaskRow {
  task: TaskRow
  projectName: string | null
  lastActiveAt: Date
}

export async function listRecentTasks(handle: DbHandle, limit: number): Promise<RecentTaskRow[]> {
  // 活动聚合用**内联相关子查询**，不用「聚合子查询 + LEFT JOIN + 外层引用」：
  // drizzle 0.45 对子查询里 `sql.as()` 字段的外层引用会丢限定名——`lastMessage.last`
  // 渲染成裸 `"last"` 而不是 `"last_message"."last"`（两个子查询还同名撞列），真
  // PostgreSQL 上直接 column not exists。toSQL() 文本可本地复现（无需连库），CI 两轮
  // 500 的教训。相关子查询每行两扫，团队规模（3–10 人）下代价可接受。
  const lastMessageAt = sql<Date>`(select max(${taskMessages.createdAt}) from ${taskMessages} where ${taskMessages.taskId} = ${tasks.id})`
  const lastRunAt = sql<Date>`(select max(${runs.createdAt}) from ${runs} where ${runs.taskId} = ${tasks.id})`
  const lastActive = sql<Date>`greatest(
    ${tasks.updatedAt},
    coalesce(${lastMessageAt}, ${tasks.updatedAt}),
    coalesce(${lastRunAt}, ${tasks.updatedAt})
  )`
  const rows = await handle
    .select({ task: tasks, projectName: projects.name, lastActiveAt: lastActive })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .orderBy(desc(lastActive), desc(tasks.id))
    .limit(limit)
  // **裸 sql 字段拿到的是字符串**：drizzle 的 postgres-js 驱动把 timestamptz 等类型的
  // 解析器换成透传（driver.cjs 的 transparentParser），普通列靠列映射器转 Date，
  // raw sql 表达式绕过映射器——直接 .toISOString() 就是 TypeError（CI 第三轮 500 的
  // 根因，TEMP-DEBUG 直调定位：仓储不炸、视图层炸）。仓储对调用方承诺 Date，
  // 归一化收敛在这一层，别让每个调用点各自 new Date。
  return rows.map((row) => ({
    task: row.task,
    projectName: row.projectName,
    lastActiveAt: row.lastActiveAt instanceof Date ? row.lastActiveAt : new Date(row.lastActiveAt),
  }))
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
  /** 拒绝理由（#186）：只在 `instructionState='rejected'` 时可有值（DB check 钉住）。 */
  instructionErrorCode?: string | undefined
  instructionErrorMessage?: string | undefined
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
 * 指令受理结算（#186 / ADR-0009 决策 3）：把 `pending` 收敛成 `accepted` / `rejected`，
 * 拒绝时**同时落理由**（team_event 只有 24 小时窗口，理由不能只活在事件里）。
 *
 * 只从 `pending` 收敛：已是终态的行返回 undefined（重复 ack 重放、Hub 重启后的旧 ack
 * 都不得二次改写既成事实）。返回 undefined 与「行不存在」对调用方同一处理——都不改账。
 */
export async function settleInstruction(
  handle: DbHandle,
  messageId: string,
  settlement:
    | { state: 'accepted'; runId?: string }
    | { state: 'rejected'; error: { code: string; message: string } },
): Promise<TaskMessageRow | undefined> {
  const [row] = await handle
    .update(taskMessages)
    .set(
      settlement.state === 'accepted'
        ? {
            instructionState: 'accepted',
            ...(settlement.runId !== undefined ? { runId: settlement.runId } : {}),
          }
        : {
            instructionState: 'rejected',
            instructionErrorCode: settlement.error.code,
            instructionErrorMessage: settlement.error.message,
          },
    )
    .where(and(eq(taskMessages.id, messageId), eq(taskMessages.instructionState, 'pending')))
    .returning()
  return row
}

/**
 * 列出任务的全部消息——**审计用全量查询**（含讨论、指令、追问）。
 *
 * 排序：按 `(created_at, id)`；`id` 是**决胜键**而不是插入序（uuidv7 低位随机），它保证的是
 * **确定性**——同一毫秒创建的多条消息每次读出的顺序一致。
 *
 * **展示用不要用它**（ADR-0010：评论区只承载人际交流）：走下面两个按用途切开的口径——
 * `listDiscussionMessages`（讨论流）/ `listInstructionMessages`（执行流）。
 */
export async function listMessages(handle: DbHandle, taskId: string): Promise<TaskMessageRow[]> {
  return handle
    .select()
    .from(taskMessages)
    .where(eq(taskMessages.taskId, taskId))
    .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id))
}

/**
 * 讨论流（ADR-0010 决策 1）：**只含 `kind='discussion'`**。
 *
 * 这是**读模型**约束而不是前端过滤——指令消息带着 `pending`/`accepted`/`rejected` 三种命运
 * 与执行副作用，混进人际评论流会让「我这句话被 Agent 拒了」和「我的讨论没发出去」长得一样
 *（ADR-0010 背景节）。库里仍存着指令（审计链要求），但讨论流不返回它们。
 */
export async function listDiscussionMessages(
  handle: DbHandle,
  taskId: string,
): Promise<TaskMessageRow[]> {
  return handle
    .select()
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), eq(taskMessages.kind, 'discussion')))
    .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id))
}

/**
 * 执行流（ADR-0010 决策 2）：`kind in ('instruction','followup')`——执行区据此渲染
 * 「指令列表与状态」（含被拒理由：`instruction_error_code` / `_message`）。
 */
export async function listInstructionMessages(
  handle: DbHandle,
  taskId: string,
): Promise<TaskMessageRow[]> {
  return handle
    .select()
    .from(taskMessages)
    .where(
      and(eq(taskMessages.taskId, taskId), inArray(taskMessages.kind, ['instruction', 'followup'])),
    )
    .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id))
}

/** 列出全部 Project（单 Team，所有未停用成员可见；03 §2.2）。 */
export async function listProjects(handle: DbHandle): Promise<ProjectRow[]> {
  return handle.select().from(projects).orderBy(asc(projects.createdAt))
}

/**
 * PATCH /tasks/:taskId：只改非状态字段；updatedAt 由 task_set_updated_at 触发器写。
 * approvalPolicy（#241）：`null` = 清除覆盖回继承（键**在场**即生效——与 title 的
 * 「缺省=不动」同构：undefined 不动，null 显式清空）。
 */
export async function updateTaskFields(
  handle: DbHandle,
  id: string,
  patch: {
    title?: string
    description?: string
    approvalPolicy?: 'approval_required' | 'full_access' | null
  },
): Promise<TaskRow | undefined> {
  const set: Record<string, unknown> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.description !== undefined) set.description = patch.description
  if (patch.approvalPolicy !== undefined) set.approvalPolicy = patch.approvalPolicy
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

/** 重新指派的目标（#239 起 assignee 多态）：member（只有 userId）或 Agent（两者都有）。 */
export interface ReassignTarget {
  assigneeUserId: string
  /** Agent 指派：非空 = 该 Agent 执行；此时 assignment 直接落 accepted（Agent 不走人的受理）。 */
  assigneeAgentId?: string
}

/**
 * 重新指派：assignee 变化后 assignment_status 重置 pending（03 §2.2/§3.1）。
 * Agent 目标例外（#239/ADR-0009 决策 6）：指派即受理，直接 accepted + acceptedAt=now
 * （Agent 没有受理动作，pending 等的会是永远不来的人）。
 * 调用方负责「无活跃 Run」守卫（G2-05）与目标存在性/有效性校验。
 */
export async function reassignTask(
  handle: DbHandle,
  id: string,
  target: ReassignTarget,
  now: Date,
): Promise<TaskRow | undefined> {
  const agentAssigned = target.assigneeAgentId !== undefined
  const [row] = await handle
    .update(tasks)
    .set({
      assigneeUserId: target.assigneeUserId,
      assigneeAgentId: target.assigneeAgentId ?? null,
      assignmentStatus: agentAssigned ? 'accepted' : 'pending',
      acceptedAt: agentAssigned ? now : null,
    })
    .where(eq(tasks.id, id))
    .returning()
  return row
}
