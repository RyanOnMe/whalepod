import type { Actor } from '@whalepod/domain'
import { CreateRunRequestSchema } from '@whalepod/protocol'
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
   * device 列已由 migration 0002 补齐（#37）；P1-09 的 node.hello 负责回填，
   * 组合根经 queries.getDeviceDshDistributionVersion 提供真实查询，
   * WS 未落地前测试仍注入常量。
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
