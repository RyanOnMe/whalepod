/**
 * 错误码与 wire 错误（03-领域模型与运行协议.md §10）。
 *
 * 注意：02 Task 3 的接口草案写的是「Consumes: DomainErrorCode from domain」，
 * 但 P1-01 落地的边界规则（scripts/check-boundaries.ts）规定 packages/protocol
 * 不得 import 任何 @whalepod/* 包，且 §10 错误码本就定义在协议正典里，
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
  // #356：本机 DSH 版本在该 Run 存活期间被换过（升级/回滚都停下 Node 再换版，
  // 见 .agents/skills/dsh-upgrade）——Node 重启做孤儿归因时比对「spawn 时记录的
  // 版本」与「本次启动探针的版本」，不一致即用本码，与「进程丢了/节点断线」
  // （RUNTIME_LOST）区分开：用户据此知道是换版搞的、需要显式重跑。
  'RUNTIME_VERSION_CHANGED',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_DECIDED',
  // #378（ADR-0017 §2）：Task 启用了任务约定但（a）尚无已确认版本、或（b）本次请求
  // 未绑定/绑定了非已确认版本——业务 Run 创建被拒，UI 据此引导先确认/更换版本。
  'AGREEMENT_REQUIRED',
  // #378：任务约定版本的非法迁移（对非草稿确认等）。
  'INVALID_SPEC_REVISION_TRANSITION',
  'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_HASH_MISMATCH',
  // #64：Reviewer 输入清单超条目上限（协议 hard cap）时 Hub input-manifest 的
  // fail-closed 显式拒绝码；Node 透传为 run.start 拒绝（ack accepted=false）。
  'ARTIFACT_INPUT_MANIFEST_TOO_LARGE',
  // #429：审阅批注的定位/提交前置失败——客户端据此引导改用整件批注或先发表意见，
  // 不把「找不到位置」伪装成成功。
  'ANCHOR_UNSUPPORTED',
  'ANCHOR_NOT_FOUND',
  'NO_COMMENTS',
  // #431：原件可读但派生预览尚未就绪/转换失败——与「Artifact 不存在」区分，
  // 客户端据此显示「下载原件」回退，而不是整页 404。
  'PREVIEW_UNAVAILABLE',
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
