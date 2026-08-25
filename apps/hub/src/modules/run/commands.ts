import type { Actor } from '@project311/domain'
import { CreateRunRequestSchema } from '@project311/protocol'
import { RunCommandError } from './errors.js'

/** 命令层入口的调用者身份：即 domain policy 的 Actor。 */
export type ActorContext = Actor

/**
 * 创建 Run 的命令输入（02-第一阶段实施计划.md Task 10 Step 3）。
 * idempotencyKey 来自 HTTP Idempotency-Key header；body 字段对齐
 * protocol CreateRunRequestSchema（§4 POST /tasks/:taskId/runs）。
 */
export interface CreateRunInput {
  idempotencyKey: string
  agentId: string
  /** 缺省时取 Agent 当前 Revision（§2.3）。 */
  profileRevisionId?: string
  deviceId: string
  workspaceId: string
  prompt: string
  /**
   * 目标 Device 的 DSH 发行版版本（固化进 Run 行，§2.6）。
   * 注意：device 表目前没有 dsh_distribution_version 列（schema 洞，见 P1-10 总结），
   * 现由调用方（组合根/P1-09 连接投影）提供。
   */
  dshDistributionVersion: string
  /** 重跑血缘：同 Task 的终态 Run（G7-04）。 */
  rerunOfRunId?: string
}

/**
 * 命令入口的最低限度校验；HTTP 层的完整 body 校验复用 protocol 的
 * CreateRunRequestSchema，这里只挡绕过 HTTP 直接调用 orchestrator 的坏输入。
 */
export function assertCreateRunInput(input: CreateRunInput): void {
  if (input.idempotencyKey.trim().length === 0) {
    throw new RunCommandError('VALIDATION_FAILED', 'idempotency key is required')
  }
  const body = CreateRunRequestSchema.safeParse({
    agentId: input.agentId,
    ...(input.profileRevisionId !== undefined
      ? { profileRevisionId: input.profileRevisionId }
      : {}),
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
  })
  if (!body.success) {
    throw new RunCommandError('VALIDATION_FAILED', body.error.issues[0]?.message ?? 'bad input')
  }
}
