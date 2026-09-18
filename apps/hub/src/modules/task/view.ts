/**
 * Task Room 聚合视图（02 Task 6 Step 1/5）：并行查询 Task、Comments、Run 投影与
 * 已发布 Artifact metadata，不暴露 runtime internals（Device Token、Workspace path、
 * 原始 Session event、dshSessionId、digest 等——03 §9 脱敏 + 02 Step 1 断言）。
 */
import type { ArtifactRow, RunRow } from '@whalepod/db'
import {
  getTask,
  listArtifactsByTask,
  listDiscussionMessages,
  listInstructionMessages,
  listRunsByTask,
  listRunPlacementNames,
} from '@whalepod/db'
import type { DbHandle } from '@whalepod/db'
import { toCommentView, toTaskView } from './queries.js'
import type { CommentView, TaskView } from './queries.js'

/**
 * Team 可见的 Run 投影（#211 B1 口径：02 Step 1 的剥离**收窄**了）。
 *
 * 仍剥离：dshSessionId / deviceId / workspaceId / digest——id 这类内部标识不出团队投影。
 * 新增：`deviceName` / `workspaceName`（**显示名，不是 id**）。"跑在哪台机器"是协作要回答
 * 的问题（执行总是用责任人的设备，③c-2b）；名不是凭据，看得到名干不了任何事
 * （配对/撤销都要走设备页权限）。
 *
 * 两个诚实点：
 *  1. null 含义：设备/工作区行不在了（外键 RESTRICT 下极少）→ null，前端画"未知设备"，
 *     不画 id、不编造；
 *  2. **当前名、不是快照**：设备改名后历史 Run 显示新名（JOIN 的语义）。Run 不是审计
 *     账本（审计链在 task_message + team_event），时间线读"现在叫什么"是对的。
 */
export interface TaskRoomRun {
  id: string
  status: RunRow['status']
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  rerunOfRunId: string | null
  deviceName: string | null
  workspaceName: string | null
}

function toTaskRoomRun(
  row: RunRow,
  names: Map<string, { deviceName: string | null; workspaceName: string | null }>,
): TaskRoomRun {
  const placement = names.get(row.id)
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    rerunOfRunId: row.rerunOfRunId,
    deviceName: placement?.deviceName ?? null,
    workspaceName: placement?.workspaceName ?? null,
  }
}

/** 已发布 Artifact metadata：剥离 storageKey / sourceRelativePath（本地路径，03 §2.6/§9）。 */
export interface TaskRoomArtifact {
  id: string
  runId: string
  ownerUserId: string
  title: string
  mediaType: string
  byteSize: number
  sha256: string
  status: ArtifactRow['status']
  createdAt: string
  publishedAt: string | null
}

function toTaskRoomArtifact(row: ArtifactRow): TaskRoomArtifact {
  return {
    id: row.id,
    runId: row.runId,
    ownerUserId: row.ownerUserId,
    title: row.title,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  }
}

export interface TaskRoomView {
  task: TaskView
  /** 讨论流（ADR-0010 决策 1）：**只含** `kind='discussion'` 的人际评论。 */
  comments: CommentView[]
  /**
   * 执行流（ADR-0010 决策 2）：`kind in ('instruction','followup')`，带 `instructionState`
   * 与拒绝理由，供执行区渲染「指令列表与状态」。与 `comments` **互斥不重叠**。
   */
  instructions: CommentView[]
  runs: TaskRoomRun[]
  artifacts: TaskRoomArtifact[]
}

/**
 * 并行查询四类数据。Artifacts 可见性（03 §2.6/§4）：
 * - published：全员可见（已发布进 Team）。
 * - candidate：仅 owner 本人可见（G6-01：candidate 只有 Bob 能打开）；
 *   viewerUserId 缺省（无会话语境）时只回 published。
 * 其余 rejected/他人 candidate 不出现在聚合里。Run 投影剥离 runtime internals，
 * 使 JSON 不含 workspacePath / dshSession / modelApiKey。
 */
export async function getTaskRoom(
  handle: DbHandle,
  taskId: string,
  viewerUserId?: string,
): Promise<TaskRoomView | undefined> {
  const task = await getTask(handle, taskId)
  if (task === undefined) return undefined
  // 讨论流与执行流分开取（ADR-0010 决策 1/2）：评论区只有人际评论，指令与追问进执行区。
  // 库里仍是同一张 `task_message`（审计链），隔离发生在读模型这一层。
  const [comments, instructions, runs, artifacts, placementNames] = await Promise.all([
    listDiscussionMessages(handle, taskId),
    listInstructionMessages(handle, taskId),
    listRunsByTask(handle, taskId),
    listArtifactsByTask(handle, taskId),
    // #211：一次查出本任务所有 Run 的设备名/工作区名（JOIN，不 N+1）。
    listRunPlacementNames(handle, taskId),
  ])
  return {
    task: toTaskView(task),
    comments: comments.map(toCommentView),
    instructions: instructions.map(toCommentView),
    runs: runs.map((row) => toTaskRoomRun(row, placementNames)),
    artifacts: artifacts
      .filter(
        (a) =>
          a.status === 'published' ||
          (a.status === 'candidate' &&
            viewerUserId !== undefined &&
            a.ownerUserId === viewerUserId),
      )
      .map(toTaskRoomArtifact),
  }
}
