/**
 * 错误码与 wire 错误（03-领域模型与运行协议.md §10）。
 *
 * 注意：02 Task 3 的接口草案写的是「Consumes: DomainErrorCode from domain」，
 * 但 P1-01 落地的边界规则（scripts/check-boundaries.ts）规定 packages/protocol
 * 不得 import 任何 @project311/* 包，且 §10 错误码本就定义在协议正典里，
 * 因此 ErrorCode 由本包持有；domain 侧持其子集 DomainErrorCode，子集关系由
 * apps/hub/tests/error-code-alignment.spec.ts 对齐门强制（Issue #30）。
 */
import { z } from 'zod'

export const ErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'AUTH_REQUIRED',
  'INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'ORIGIN_REJECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'ASSIGNMENT_NOT_ACCEPTED',
  'INVALID_RUN_TRANSITION',
  'INVALID_TASK_TRANSITION',
  'INVALID_ASSIGNMENT_TRANSITION',
  'INVALID_ARTIFACT_TRANSITION',
  'TASK_TERMINAL',
  'RUN_ALREADY_ACTIVE',
  'DEVICE_OFFLINE',
  'DEVICE_REVOKED',
  'NODE_CAPACITY_REACHED',
  'WORKSPACE_UNAVAILABLE',
  'PROFILE_MISMATCH',
  'PLUGIN_PACK_MISMATCH',
  'PROTOCOL_MISMATCH',
  'RUNTIME_START_FAILED',
  'MODEL_CREDENTIAL_UNAVAILABLE',
  'RUNTIME_LOST',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_DECIDED',
  'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_HASH_MISMATCH',
  'PLUGIN_UNREVIEWED',
  'INTERNAL_ERROR',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

/** Node command.ack 里上行的错误（03 §6.2 WireError）。message 必须已脱敏（§9/§10）。 */
export const WireErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(1000),
})
export type WireError = z.infer<typeof WireErrorSchema>

/** parse* 系列抛出的协议错误：code 即 wire ErrorCode，可被对端直接回传。 */
export type ProtocolErrorCode = 'PROTOCOL_MISMATCH' | 'VALIDATION_FAILED'

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProtocolError'
    this.code = code
  }
}
