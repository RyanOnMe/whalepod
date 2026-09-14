/**
 * HTTP DTO（03-领域模型与运行协议.md §4，字段规则逐项对应 §2 的实体表）。
 *
 * 所有写命令的 JSON body 走 Zod 严格模式解析（§4）；Origin / Idempotency-Key /
 * Cookie 是 Hub 中间件职责（header 级约束，不属于 body DTO，见 §4 末两段）。
 */
import { z } from 'zod'
import { ErrorCodeSchema } from './errors.js'

export const ApiFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
    // §4 记为 unknown：错误细节，wire 上必须是 JSON 值。
    details: z.json().optional(),
  }),
})
export type ApiFailure = z.infer<typeof ApiFailureSchema>

/** 响应 envelope：`{ ok: true, data }`，data schema 由各路由给出（§4）。 */
export function apiSuccess<Data extends z.ZodType>(data: Data) {
  return z.strictObject({ ok: z.literal(true), data })
}

// §2.1 身份字段规则
export const UsernameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/)
/** §2.1 只规定存储用 Argon2id，未规定口令长度策略；wire 上仅拒绝空口令。 */
export const PasswordSchema = z.string().min(1)
export const DisplayNameSchema = z.string().min(1).max(80)

/** POST /setup：未初始化实例 + Setup Token，创建 Team 与 Owner。 */
export const SetupRequestSchema = z.strictObject({
  setupToken: z.string().min(1),
  // §2.1 team.name：去首尾空格后 1–80
  teamName: z.string().trim().min(1).max(80),
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
})

/** POST /auth/login。 */
export const LoginRequestSchema = z.strictObject({
  username: UsernameSchema,
  password: PasswordSchema,
})

/** POST /invites：§2.1 规定不能邀请 Owner。 */
export const CreateInviteRequestSchema = z.strictObject({
  role: z.enum(['admin', 'member']),
})

/** POST /invites/accept：匿名 + 一次性 Token。 */
export const AcceptInviteRequestSchema = z.strictObject({
  token: z.string().min(1),
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
})

/** POST /projects（§2.2：name 1–120，description ≤4000）。 */
export const CreateProjectRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
})

/** POST /projects/:projectId/tasks（§2.2：title 1–200，description ≤20000）。 */
export const CreateTaskRequestSchema = z.strictObject({
  title: z.string().min(1).max(200),
  description: z.string().max(20000).optional(),
  assigneeUserId: z.uuid(),
})

/** PATCH /tasks/:taskId：只允许非状态字段。 */
export const UpdateTaskRequestSchema = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
})

/**
 * POST /tasks/:taskId/reassign（03 §2.2/§3.1：assignee 变化后 assignment_status
 * 重置为 pending）。05 里程碑把「重新指派」列为 P1-06 交付；03 §4 路由表未单列，
 * 此处按 accept/reject 同形补一条限定命令。
 */
export const ReassignTaskRequestSchema = z.strictObject({
  assigneeUserId: z.uuid(),
})

/** POST /tasks/:taskId/comments（§2.2：body 1–10000）。 */
export const CreateCommentRequestSchema = z.strictObject({
  body: z.string().min(1).max(10000),
})

/**
 * POST /tasks/:taskId/instructions（#196；ADR-0010 决策 2 的执行区入口）。
 *
 * 与人际评论的区别：这条**驱动 Agent**——有活跃 Run 时降级为追问，没有时**建 Run**。
 * 执行目标（设备/工作区）缺省走三段式自动解析（上一个 Run → 责任人最近在线设备 → 拒绝），
 * 显式传入即覆盖；`agentId` 缺省取该 Task 上一个 Run 用过的 Agent。
 */
export const SendInstructionRequestSchema = z.strictObject({
  text: z.string().min(1).max(10000),
  deviceId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
  agentId: z.uuid().optional(),
})

/**
 * POST /tasks/:taskId/runs：Run 固化 Agent、Workspace 与 Profile Revision（§2.6）。
 * profileRevisionId 缺省时由 Hub 取 Agent 当前 Revision（§2.3）。
 * rerunOfRunId：显式重跑血缘（§2.6 rerun_of_run_id；P1-16 G7-04）——必须指向
 * 同 Task 的终态 Run，存在性/终态/同 Task 校验在 Hub 命令层（orchestrator）。
 */
export const CreateRunRequestSchema = z.strictObject({
  agentId: z.uuid(),
  profileRevisionId: z.uuid().optional(),
  deviceId: z.uuid(),
  workspaceId: z.uuid(),
  prompt: z.string().min(1).max(20_000),
  rerunOfRunId: z.uuid().optional(),
})

/**
 * POST /runs/:runId/followup（§6.3；ADR-0009 决策 3）：往活跃 Run 里继续说话。
 *
 * 载荷与 node-wire 的下行帧同源——`text` 就是塞进 Runtime stdin 的那段文字（上限同
 * `run.followup` 帧的 20 000）。受理规则按 Run **状态**判定（决策 5），理由见命令层。
 */
export const CreateFollowupRequestSchema = z.strictObject({
  text: z.string().min(1).max(20_000),
})

/** POST /approvals/:approvalId/decisions：一次性决定（§3.3）。 */
export const DecideApprovalRequestSchema = z.strictObject({
  decision: z.enum(['allowed_once', 'rejected']),
})

/**
 * POST /node/runs/:runId/artifacts（P1-15）的元数据（经 query 传输，body 为
 * 原始 octet-stream 字节）。sha256 是权威校验：Hub 复算实收字节比对，不匹配
 * 拒绝（G6-03）；byteSize 只是先行的上界声明，落库取实收长度。
 */
export const ArtifactUploadMetadataSchema = z.strictObject({
  title: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().min(0).max(52_428_800),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Node 采集侧产出的规范化相对路径；仅 owner 可见（03 §2.6），不下发其他成员。
  sourceRelativePath: z.string().min(1).max(1024),
})

/**
 * GET /node/runs/:runId/input-manifest（P1-15）的响应 data：Reviewer Run 的
 * 只读 Artifact 输入清单。只含内容寻址事实与展示元数据——绝不含 storageKey /
 * sourceRelativePath（不泄露本机路径，G6-07）。
 */
export const ArtifactManifestEntrySchema = z.strictObject({
  artifactId: z.uuid(),
  runId: z.uuid(),
  title: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().min(0).max(52_428_800),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.string().min(1),
})

/**
 * Reviewer 输入清单条目上限（P1-15 协议层 hard cap；03 §4/§7.1）。
 * #64：Hub 的 input-manifest 路由与本 schema 共用同一常量——已发布数超限时
 * Hub 显式拒绝（ARTIFACT_INPUT_MANIFEST_TOO_LARGE），绝不静默下发超限清单
 * （Node 侧 schema 校验会炸成不显式的 VALIDATION_FAILED）。
 */
export const ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES = 64

export const ArtifactInputManifestSchema = z.strictObject({
  taskId: z.uuid(),
  artifacts: z.array(ArtifactManifestEntrySchema).max(ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES),
})

// §2.3 Profile Revision 字段规则；创建 Agent 时必须同时给出首个 Revision
// （agent.current_revision_id 非空），新建 Revision 复用同一组字段。
const RevisionRequestShape = {
  persona: z.string().min(1).max(20_000),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  credentialSlot: z.string().min(1).max(80),
  maxTokens: z.number().int().positive().optional(),
  pluginPackId: z.uuid(),
} as const

/** POST /agents（Owner/Admin）。description 与 Project/Task 同形可选缺省。 */
export const CreateAgentRequestSchema = z.strictObject({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  ...RevisionRequestShape,
})

/** POST /agents/:agentId/revisions（Owner/Admin）。 */
export const CreateAgentRevisionRequestSchema = z.strictObject({ ...RevisionRequestShape })

/** POST /devices/pairing-codes：登录 Member 生成一次性配对码（03 §4）。 */
export const CreatePairingCodeRequestSchema = z.strictObject({})

/**
 * POST /devices/pairing-claims：匿名 Node 以未过期配对码换一次性 Device Token
 * （03 §4 末段：Node 路由不要 Browser Origin/Cookie，但要求 Idempotency-Key）。
 * 初始设备信息随 claim 落库；dsh 版本与 pack digests 由后续 node.hello 回填。
 */
export const PairingClaimRequestSchema = z.strictObject({
  code: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  platform: z.enum(['darwin', 'linux', 'win32']),
  architecture: z.string().min(1).max(32),
  nodeVersion: z.string().min(1).max(32),
  nodeAppVersion: z.string().min(1).max(32),
})

export type SetupRequest = z.infer<typeof SetupRequestSchema>
export type LoginRequest = z.infer<typeof LoginRequestSchema>
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>
export type ReassignTaskRequest = z.infer<typeof ReassignTaskRequestSchema>
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>
export type SendInstructionRequest = z.infer<typeof SendInstructionRequestSchema>
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>
export type CreateFollowupRequest = z.infer<typeof CreateFollowupRequestSchema>
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>
export type CreateAgentRevisionRequest = z.infer<typeof CreateAgentRevisionRequestSchema>
export type CreatePairingCodeRequest = z.infer<typeof CreatePairingCodeRequestSchema>
export type PairingClaimRequest = z.infer<typeof PairingClaimRequestSchema>
export type ArtifactUploadMetadata = z.infer<typeof ArtifactUploadMetadataSchema>
export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>
export type ArtifactInputManifest = z.infer<typeof ArtifactInputManifestSchema>

// ---------------------------------------------------------------------------
// 视图（响应 data）schema：本仓惯例是 Request 在 protocol、View 在 Web 手写
// interface。#136 起新增响应也纳入 zod——选择器契约（字段最小集）由 schema 钉死，
// Hub 出网前 parse，多一列少一列都是红。
// ---------------------------------------------------------------------------

/** GET /team/members 的单条成员视图（03 §2.1；无敏感列，enabled 收敛 disabledAt）。 */
export const TeamMemberViewSchema = z.strictObject({
  userId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  enabled: z.boolean(),
})
export const TeamMemberViewsSchema = z.array(TeamMemberViewSchema)
export type TeamMemberView = z.infer<typeof TeamMemberViewSchema>
export type TeamMemberViews = z.infer<typeof TeamMemberViewsSchema>

/**
 * GET /invites/:token 的预检视图（#141 接受页）。匿名可读，因此**严格对象**是
 * 结构性保证：多一列少一列都 parse 红，成员/Token/裸时间戳不可能随字段漂移漏出。
 * expired/consumed 在 200 分支恒为 false（无效邀请走 409 + error.details，同名字段
 * 便于 UI 用一份形状处理两条腿）；失败细节不进 200 响应。
 */
export const InvitePreflightSchema = z.strictObject({
  role: z.enum(['admin', 'member']),
  teamName: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
  consumed: z.boolean(),
})
export type InvitePreflight = z.infer<typeof InvitePreflightSchema>

/**
 * POST /invites/:token/accept 的结果视图（#141，已登录一键加入）。
 * joined=false 且 alreadyMember=true 是幂等重放（已是团队成员/本人重复提交），
 * 不是失败——所以用 200 + 两个布尔，而不是错误码。
 */
export const InviteAcceptResultSchema = z.strictObject({
  role: z.enum(['admin', 'member']),
  teamName: z.string(),
  joined: z.boolean(),
  alreadyMember: z.boolean(),
})
export type InviteAcceptResult = z.infer<typeof InviteAcceptResultSchema>
