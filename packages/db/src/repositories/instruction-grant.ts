/**
 * 指令权授权仓储（#198；ADR-0009 决策 4）。
 *
 * 一句话：**谁能在执行区驱动这个 Task 的 Agent**。与"谁能说话"无关——讨论区任何成员都能评论
 * （ADR-0010），本表只管指令面。
 *
 * 三个不变量（别在别处重新解释）：
 *   1. 责任人**永远**能驱动，不需要也不应该被授予（授予责任人是无意义的行，直接拒绝）；
 *   2. 审批决定权**不在本表**：`decide_approval` 只看 `run.owner_user_id`；
 *   3. Run 归属永远是责任人（`run.owner_user_id = task.assignee_user_id`），被授权成员只是"能开口"。
 */
import { and, asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { taskInstructionGrants } from '../schema/project.js'
import { tasks } from '../schema/project.js'

export type TaskInstructionGrantRow = typeof taskInstructionGrants.$inferSelect

/** 授权（幂等）：同一 (taskId, userId) 重复授予不产生第二行，只回读既有行。 */
export async function grantInstruction(
  handle: DbHandle,
  grant: { id: string; taskId: string; userId: string; grantedBy: string; createdAt?: Date },
): Promise<TaskInstructionGrantRow> {
  const [row] = await handle
    .insert(taskInstructionGrants)
    .values({
      id: grant.id,
      taskId: grant.taskId,
      userId: grant.userId,
      grantedBy: grant.grantedBy,
      ...(grant.createdAt !== undefined ? { createdAt: grant.createdAt } : {}),
    })
    // 重复授予是幂等操作：冲突时不报错、不回滚事务（调用方可能在别处还有写入）。
    .onConflictDoNothing({ target: [taskInstructionGrants.taskId, taskInstructionGrants.userId] })
    .returning()
  if (row !== undefined) return row
  const existing = await findInstructionGrant(handle, grant.taskId, grant.userId)
  if (existing === undefined) throw new Error('grant insert conflicted but no row found')
  return existing
}

/** 撤销（#198 判据 3）：删行即可——守卫每次都点查本表，没有缓存，所以"立刻失效"是真的立刻。 */
export async function revokeInstruction(
  handle: DbHandle,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const rows = await handle
    .delete(taskInstructionGrants)
    .where(and(eq(taskInstructionGrants.taskId, taskId), eq(taskInstructionGrants.userId, userId)))
    .returning({ id: taskInstructionGrants.id })
  return rows.length > 0
}

export async function findInstructionGrant(
  handle: DbHandle,
  taskId: string,
  userId: string,
): Promise<TaskInstructionGrantRow | undefined> {
  const [row] = await handle
    .select()
    .from(taskInstructionGrants)
    .where(and(eq(taskInstructionGrants.taskId, taskId), eq(taskInstructionGrants.userId, userId)))
    .limit(1)
  return row
}

/** 某 Task 的授权名单（按授予时间，老的在前——UI 与审计都按这个顺序读）。 */
export async function listInstructionGrants(
  handle: DbHandle,
  taskId: string,
): Promise<TaskInstructionGrantRow[]> {
  return handle
    .select()
    .from(taskInstructionGrants)
    .where(eq(taskInstructionGrants.taskId, taskId))
    .orderBy(asc(taskInstructionGrants.createdAt), asc(taskInstructionGrants.id))
}

export type InstructionRight = 'assignee' | 'granted' | 'none'

/**
 * 谁能驱动这个 Task 的 Agent——**唯一的判定入口**（守卫都调它，别各写一份）：
 *   * `assignee`：Task 责任人（永远可以）；
 *   * `granted`：被授权成员（授权行存在）；
 *   * `none`：都不满足 → 调用方回 403 `FORBIDDEN`。
 *
 * Task 不存在时也返回 `none`（调用方按 404 处理，不在这一层区分）。
 */
export async function resolveInstructionRight(
  handle: DbHandle,
  taskId: string,
  userId: string,
): Promise<InstructionRight> {
  const [task] = await handle
    .select({ assigneeUserId: tasks.assigneeUserId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (task === undefined) return 'none'
  if (task.assigneeUserId === userId) return 'assignee'
  const grant = await findInstructionGrant(handle, taskId, userId)
  return grant === undefined ? 'none' : 'granted'
}
