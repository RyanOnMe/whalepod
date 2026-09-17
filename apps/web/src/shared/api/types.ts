/**
 * 响应 data 形状的镜像类型（P1-07）。
 *
 * 请求体 schema 的权威在 packages/protocol（wire SSoT），前端直接复用其类型；
 * 响应 data 形状没有单独的包承载——它们由 apps/hub 各模块的查询/视图层定义
 * （project/queries.ts、task/queries.ts、task/view.ts、agent/queries.ts、auth/routes.ts、
 * team/routes.ts）。apps/web 的边界规则只允许 import @whalepod/protocol，因此这里
 * 按 Hub 视图逐字段镜像，并注释各自来源；Hub 侧改动时需同步（P1-13 前后宜把
 * 响应 DTO 上收进 protocol，消除镜像）。
 */

// auth/routes.ts：GET /auth/session、POST /auth/login 的 data。
export type Role = 'owner' | 'admin' | 'member'
export interface Session {
  userId: string
  username: string
  displayName: string
  role: Role
}

// team/routes.ts：GET /setup/status、GET /team 的 data。
export interface SetupStatus {
  initialized: boolean
}
export interface TeamView {
  id: string
  name: string
  createdAt: string
}

// team/routes.ts：GET /team/members 的列表项（#141 成员页）。
// #136 起该响应面已纳入 protocol schema（TeamMemberView），类型从 @whalepod/protocol
// 引入，不再在此镜像——本文件原有的同名 interface（多一个 joinedAt）已删除。

// team/invite-routes.ts：GET /invites/:token（接受页预检）、POST /invites/:token/accept。
export interface InviteDetailsView {
  role: 'admin' | 'member'
  teamName: string
  expiresAt: string
  expired: boolean
  consumed: boolean
}

export interface AcceptInviteAsMemberView {
  role: 'admin' | 'member'
  teamName: string
  /** true = 本次真的加入了；false = 已是团队成员（重复点击/多标签页）。 */
  joined: boolean
  alreadyMember: boolean
}

// project/queries.ts：ProjectView。
export interface ProjectView {
  id: string
  name: string
  description: string
  createdBy: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

// domain/task.ts 的状态集（03 §3.1），task/queries.ts 的 TaskView 使用。
export type TaskStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled'
export type AssignmentStatus = 'pending' | 'accepted' | 'rejected'

export interface TaskView {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assigneeUserId: string
  assignmentStatus: AssignmentStatus
  createdBy: string
  acceptedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

// task/queries.ts：CommentView。authorUserId 是原始 user id，显示名需成员接口
// （P1-08 后）补齐；当前以短 id 呈现，不伪造姓名。
//
// #185：实体已升级为 task_message（讨论/指令/追问同表），服务端视图多出五个字段。
// 这里**跟着补上**而不是等 UI 用——`client.ts` 是 `as T` 不做运行期校验，副本漏字段
// 不会有任何门报错，只会静默漂移（评审观察项）。改名与 UI 消费属切片③c。
export interface CommentView {
  id: string
  taskId: string
  authorUserId: string
  body: string
  kind: 'discussion' | 'instruction' | 'followup'
  origin: 'human' | 'auto_assignment'
  targetAgentId: string | null
  runId: string | null
  instructionState: 'pending' | 'accepted' | 'rejected' | null
  instructionErrorCode: string | null
  instructionErrorMessage: string | null
  createdAt: string
  editedAt: string | null
}

// domain/run.ts 的状态集（03 §3.2）。
export type RunStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'waiting_approval'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lost'

// task/view.ts：TaskRoomRun（Hub 已剥离 runtime internals，03 §9）。
export interface TaskRoomRun {
  id: string
  status: RunStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  rerunOfRunId: string | null
}

// packages/db schema/artifact.ts 的状态集（03 §3.4）。
export type ArtifactStatus = 'candidate' | 'published' | 'rejected'

// task/view.ts：TaskRoomArtifact（只返回已发布，剥离 storageKey/sourceRelativePath）。
export interface TaskRoomArtifact {
  id: string
  runId: string
  ownerUserId: string
  title: string
  mediaType: string
  byteSize: number
  sha256: string
  status: ArtifactStatus
  createdAt: string
  publishedAt: string | null
}

// task/view.ts：GET /tasks/:taskId 的聚合视图。
/**
 * 执行区的一条指令（③c-2a 的读模型：`GET /tasks/:id` 的 `instructions`）。
 *
 * 与 `CommentView`（讨论）是**两条流**（ADR-0010 决策 1）：指令会驱动 Agent，评论不会。
 * `instructionState` 的四种取值就是执行区要画出来的四种状态；被拒时理由与状态**同列落库**
 * （团队事件只有 24 小时窗口，而"我的指令为什么没被受理"是长期问题）。
 */
export interface InstructionView {
  id: string
  taskId: string
  authorUserId: string
  body: string
  createdAt: string
  /** `instruction` = 起 Run 的那句话；`followup` = 追问既有 Run。 */
  kind: 'instruction' | 'followup'
  targetAgentId: string | null
  /** 起 Run 的指令在 `run.start` ack 之前可能还没有 Run。 */
  runId: string | null
  instructionState: 'pending' | 'accepted' | 'rejected'
  instructionErrorCode: string | null
  instructionErrorMessage: string | null
}

export interface TaskRoomView {
  task: TaskView
  /** 讨论流：**只有人**说的话，永不触发运行（ADR-0010）。 */
  comments: CommentView[]
  /** 执行流：驱动 Agent 的指令（③c-2a 起与 `comments` 分离）。 */
  instructions: InstructionView[]
  runs: TaskRoomRun[]
  artifacts: TaskRoomArtifact[]
}

// agent/queries.ts：AgentView / AgentDetailView / ProfileRevisionView。
export interface AgentView {
  id: string
  name: string
  description: string
  createdBy: string
  archivedAt: string | null
  currentRevisionId: string | null
}
export interface ProfileRevisionView {
  id: string
  agentId: string
  revision: number
  persona: string
  provider: string
  model: string
  credentialSlot: string
  maxTokens: number | null
  pluginPackId: string
  profileDigest: string
  createdBy: string
  createdAt: string
}
export interface AgentDetailView extends AgentView {
  currentRevision: ProfileRevisionView | null
  revisions: ProfileRevisionView[]
}

// ---- P1-13 Run 运行面 ----

// device/pairing.ts：GET /devices 的列表项。
export interface DeviceView {
  id: string
  name: string
  platform: string
  status: 'online' | 'offline' | 'revoked'
  dshDistributionVersion: string | null
  lastSeenAt: string | null
}

// device/pairing.ts：POST /devices/pairing-codes 的 data(#142)。code 明文只在
// 本响应出现一次（Hub 只存 SHA-256），Web 侧不持久化、不写日志。
export interface PairingCodeView {
  pairingCodeId: string
  code: string
  expiresAt: string
}

// device/workspace-routes.ts：GET /workspaces 的列表项（不含本地路径，03 §2.4）。
export interface WorkspaceView {
  workspaceId: string
  deviceId: string
  name: string
  kind: 'directory' | 'git'
  available: boolean
}

// run/queries.ts：GET /runs/:runId 的 RunView。
export interface RunView {
  id: string
  taskId: string
  ownerUserId: string
  agentId: string
  profileRevisionId: string
  deviceId: string
  workspaceId: string
  status: RunStatus
  dshSessionId: string | null
  failureCode: string | null
  failureSummary: string | null
  // P1-16 G7-04：显式重跑血缘（03 §2.6 rerun_of_run_id）。
  rerunOfRunId: string | null
  profileDigest: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

// run/routes.ts：GET /runs/:runId/events 的事件项（受众由 Hub 按请求者裁剪）。
export interface RunEventItem {
  runId: string
  seq: number
  type: string
  audience: 'owner' | 'project' | 'admin'
  /** ProjectedRunEvent 的 event 载荷；具体形状按 type 解释，UI 不猜未知类型。 */
  event: Record<string, unknown>
  occurredAt: string
  receivedAt: string
}
