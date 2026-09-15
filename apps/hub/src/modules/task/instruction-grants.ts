/**
 * 指令权授权的管理面（P1-198 切片④b；ADR-0009 决策 4）。
 *
 * 谁用这个模块：**Task 责任人**——他决定"除我之外，谁还能在执行区驱动这个 Agent"。
 * 被授权成员不能用它（授权不能自我复制），团队管理员也不行（管理员的权力不是责任人的权力）。
 *
 * 与讨论区无关：评论永远不需要授权（ADR-0010 决策 1/4）。
 * 与审批无关：审批决定权**不可授予**，永远只属于责任人（`decide_approval`）。
 */
import { eq } from 'drizzle-orm'
import type { Actor } from '@whalepod/domain'
import {
  appendTeamEvent,
  findInstructionGrant,
  grantInstruction,
  listInstructionGrants,
  transactCommand,
  revokeInstruction,
  schema,
  type Database,
  type Tx,
} from '@whalepod/db'
import { uuidv7 } from '../shared/uuid.js'
import { RunCommandError } from '../run/errors.js'

export interface InstructionGrantView {
  /** 被授权人。 */
  userId: string
  /** 谁授的（审计要能回答）。责任人改派后这里的含义是"**当时的**责任人"（见 0006 注释）。 */
  grantedBy: string
  grantedAt: string
}

export interface InstructionDriverView {
  userId: string
  /** `assignee` 永远可驱动（不需要授权行）；`granted` 来自授权名单。 */
  reason: 'assignee' | 'granted'
  grantedBy?: string
  grantedAt?: string
}

/** 锁 Task 行：授权是"对某个 Task 的改动"，与其它 Task 级改动串行化。 */
async function lockTask(tx: Tx, taskId: string): Promise<{ assigneeUserId: string }> {
  const [task] = await tx
    .select({ assigneeUserId: schema.tasks.assigneeUserId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .for('update')
  if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')
  return task
}

/**
 * 谁能驱动这个 Task 的 Agent——**责任人 + 被授权成员**（读模型，给权限页用）。
 *
 * 顺序有意义：责任人永远排第一（"责任人永远能驱动"这条不变量在 UI 上也要一眼可见）。
 */
export async function listInstructionDrivers(
  database: Database,
  taskId: string,
): Promise<InstructionDriverView[]> {
  const [task] = await database.db
    .select({ assigneeUserId: schema.tasks.assigneeUserId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1)
  if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')
  const grants = await listInstructionGrants(database.db, taskId)
  return [
    { userId: task.assigneeUserId, reason: 'assignee' },
    ...grants
      .filter((grant) => grant.userId !== task.assigneeUserId)
      .map((grant) => ({
        userId: grant.userId,
        reason: 'granted' as const,
        grantedBy: grant.grantedBy,
        grantedAt: grant.createdAt.toISOString(),
      })),
  ]
}

export interface GrantInstructionInput {
  userId: string
  idempotencyKey: string
}

/**
 * 授予指令权（责任人专属）。
 *
 * 三条拒绝都是有意的，别当成边界情况忽略：
 *   * 授权给**责任人自己**——他本来就永远能驱动，落一行只会让读模型出现重复项；
 *   * 授权给**非团队成员**——授权对象必须是能看见这个 Task 的人（否则是幽灵名单）；
 *   * 由**非责任人**发起——包括被授权成员与管理员（授权不能自我复制）。
 */
export async function grantInstructionRight(
  database: Database,
  actor: Actor,
  taskId: string,
  input: GrantInstructionInput,
): Promise<InstructionGrantView> {
  return transactCommand(database, `instruction.grant:${input.idempotencyKey}`, async (tx) => {
    const task = await lockTask(tx, taskId)
    if (task.assigneeUserId !== actor.userId) {
      throw new RunCommandError('FORBIDDEN', 'only the task assignee can grant instruction rights')
    }
    if (input.userId === task.assigneeUserId) {
      throw new RunCommandError(
        'VALIDATION_FAILED',
        'the assignee can always drive the task; no grant needed',
      )
    }
    // 授权对象必须是**团队成员**：否则这条授权指向一个看不到该 Task 的人，是幽灵名单。
    // 口径说明（复核 #205 观察 7）：本查询按 userId 判定，**没有**带 teamId——因为本部署是单 Team
    // （`team_member` 有 `team_member_user_unique.on(user_id)`、`getTeam` 取 limit 1），两者等价。
    // 若将来支持多 Team，这里必须补 teamId，否则会跨 Team 授权。
    const [member] = await tx
      .select({ userId: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.userId, input.userId))
      .limit(1)
    if (member === undefined) {
      throw new RunCommandError('NOT_FOUND', 'the grantee is not a member of this team')
    }

    const existing = await findInstructionGrant(tx, taskId, input.userId)
    const row =
      existing ??
      (await grantInstruction(tx, {
        id: uuidv7(),
        taskId,
        userId: input.userId,
        grantedBy: actor.userId,
      }))
    // 重复授予是幂等的（唯一约束兜底），但**只在真的新增时**发事件——
    // 否则审计里会出现一串"又授了一次"的噪音，读者无法分辨哪次是真变更。
    if (existing === undefined) {
      // 事件类型必须落在**既有封闭枚举**里（`client-events.ts` 的 8 个字面量），
      // 授权变更属于"这个 Task 变了"；用 `change` 字段让它可被审计检索，
      // 而不是新造一个浏览器帧类型（那要动协议与生成物，本片不做）。
      await appendTeamEvent(tx, {
        type: 'task.changed',
        payload: {
          taskId,
          change: 'instruction_granted',
          userId: input.userId,
          grantedBy: actor.userId,
        },
      })
    }
    return {
      userId: row.userId,
      grantedBy: row.grantedBy,
      grantedAt: row.createdAt.toISOString(),
    }
  })
}

/** 撤销指令权（责任人专属）。撤销后**下一次**指令立刻 403——没有缓存，守卫每次点查。 */
export async function revokeInstructionRight(
  database: Database,
  actor: Actor,
  taskId: string,
  targetUserId: string,
  idempotencyKey: string,
): Promise<{ revoked: boolean }> {
  return transactCommand(database, `instruction.revoke:${idempotencyKey}`, async (tx) => {
    const task = await lockTask(tx, taskId)
    if (task.assigneeUserId !== actor.userId) {
      throw new RunCommandError('FORBIDDEN', 'only the task assignee can revoke instruction rights')
    }
    if (targetUserId === task.assigneeUserId) {
      // 责任人的驱动权不是"授权来的"，所以也撤不掉——这条要拒绝，而不是静默成功。
      throw new RunCommandError('VALIDATION_FAILED', 'the assignee always keeps instruction rights')
    }
    const revoked = await revokeInstruction(tx, taskId, targetUserId)
    if (revoked) {
      await appendTeamEvent(tx, {
        type: 'task.changed',
        payload: {
          taskId,
          change: 'instruction_revoked',
          userId: targetUserId,
          grantedBy: actor.userId,
        },
      })
    }
    return { revoked }
  })
}

/**
 * 把"表级兜底触发器"的拒绝翻译成人话（`23514`）。
 *
 * 为什么必须翻译：触发器抛的错经 Drizzle 的 cause 链上抛时，**最外层 message 是
 * `Failed query: insert into ... values (...)`——带原始 SQL 与参数**。不映射就会把库结构与参数
 * 泄进 API 响应体（复核 #204 的提醒）。命令层已先判过一次，走到这里说明库与代码的假设不一致，
 * 属于该被发现的真异常，所以仍然报错——只是换成一句能读的话。
 */
export function translateGrantConstraintError(error: unknown): unknown {
  let cursor: unknown = error
  while (cursor instanceof Error) {
    if (/must be the task assignee/.test(cursor.message)) {
      // DomainError 的码表是领域状态冲突那一族，这里没有合适的码；用运行面的
      // VALIDATION_FAILED 更贴切（它会被 run 模块的映射表翻成 400）。
      return new RunCommandError(
        'VALIDATION_FAILED',
        'instruction grant must be issued by the task assignee',
      )
    }
    cursor = cursor.cause
  }
  return error
}
