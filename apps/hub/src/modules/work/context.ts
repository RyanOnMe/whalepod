import {
  getEnabledMember,
  getTaskForUpdate,
  getTeam,
  getWorkByKey,
  getWorkByKeyForUpdate,
  type TaskRow,
  type Tx,
  type WorkRow,
} from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'

// ADR-0028：工作写命令、准入与收件箱共用的锁序与 assignee-only 授权。
// 锁序固定 task → work；所有调用方必须保持这一顺序，避免与 Task 改派交叉死锁。

export interface LockedWork {
  readonly work: WorkRow
  readonly task: TaskRow
}

export async function lockWorkContext(tx: Tx, workKey: string): Promise<LockedWork> {
  const snapshot = await getWorkByKey(tx, workKey)
  if (snapshot === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  const task = await getTaskForUpdate(tx, snapshot.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  const work = await getWorkByKeyForUpdate(tx, workKey)
  if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  if (work.taskId !== task.id) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'work and task are inconsistent')
  }
  return { work, task }
}

export async function requireAssignee(
  tx: Tx,
  task: TaskRow,
  actorUserId: string,
  message = 'only the task assignee can manage this work',
): Promise<void> {
  if (task.assigneeUserId !== actorUserId) throw new ApiError(403, 'FORBIDDEN', message)
  const team = await getTeam(tx)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  const member = await getEnabledMember(tx, team.id, actorUserId)
  if (member === undefined) throw new ApiError(403, 'FORBIDDEN', 'actor is not an active member')
}
