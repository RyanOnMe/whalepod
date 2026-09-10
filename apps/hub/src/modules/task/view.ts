/**
 * Task Room 聚合视图（02 Task 6 Step 1/5）：并行查询 Task、Comments、Run 投影与
 * 已发布 Artifact metadata，不暴露 runtime internals（Device Token、Workspace path、
 * 原始 Session event、dshSessionId、digest 等——03 §9 脱敏 + 02 Step 1 断言）。
 */
import type { ArtifactRow, RunRow } from '@whalepod/db'
import { getTask, listArtifactsByTask, listComments, listRunsByTask } from '@whalepod/db'
import type { DbHandle } from '@whalepod/db'
import { toCommentView, toTaskView } from './queries.js'
import type { CommentView, TaskView } from './queries.js'

/** Team 可见的 Run 投影：剥离 dshSessionId / deviceId / workspaceId / digest（02 Step 1）。 */
export interface TaskRoomRun {
  id: string
  status: RunRow['status']
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  rerunOfRunId: string | null
}

function toTaskRoomRun(row: RunRow): TaskRoomRun {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    rerunOfRunId: row.rerunOfRunId,
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
  comments: CommentView[]
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
  const [comments, runs, artifacts] = await Promise.all([
    listComments(handle, taskId),
    listRunsByTask(handle, taskId),
    listArtifactsByTask(handle, taskId),
  ])
  return {
    task: toTaskView(task),
    comments: comments.map(toCommentView),
    runs: runs.map(toTaskRoomRun),
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
