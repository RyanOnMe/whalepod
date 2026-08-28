/**
 * 响应 data 形状的镜像类型（P1-07）。
 *
 * 请求体 schema 的权威在 packages/protocol（wire SSoT），前端直接复用其类型；
 * 响应 data 形状没有单独的包承载——它们由 apps/hub 各模块的查询/视图层定义
 * （project/queries.ts、task/queries.ts、task/view.ts、agent/queries.ts、auth/routes.ts、
 * team/routes.ts）。apps/web 的边界规则只允许 import @project311/protocol，因此这里
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
export interface CommentView {
  id: string
  taskId: string
  authorUserId: string
  body: string
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
export interface TaskRoomView {
  task: TaskView
  comments: CommentView[]
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
