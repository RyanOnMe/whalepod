/**
 * ADR-0030 RD-04b：项目任务/成果目录快照。
 *
 * 目录只含项目内 Task 的可见元数据、当前 Work 状态与已发布成果的身份/摘要，
 * 不含标题正文、私有成果内容或成员会话。责任人核对的就是这个摘要；任何
 * 新建、改派、范围变更或发布都会改变摘要求和 slot generation。
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import type { Tx } from '@whalepod/db'
import { schema } from '@whalepod/db'
import type { DiscoverySlotCatalogEntry } from '@whalepod/db'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'

export const MAX_DISCOVERY_CATALOG = 64

export interface DiscoveryCatalog {
  readonly entries: DiscoverySlotCatalogEntry[]
  readonly digest: string
  readonly complete: boolean
}

export async function loadDiscoveryCatalog(tx: Tx, projectId: string): Promise<DiscoveryCatalog> {
  const tasks = await tx
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      assignmentStatus: schema.tasks.assignmentStatus,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(asc(schema.tasks.id))
    .limit(MAX_DISCOVERY_CATALOG + 1)
  const complete = tasks.length <= MAX_DISCOVERY_CATALOG
  const visible = tasks.slice(0, MAX_DISCOVERY_CATALOG)
  const ids = visible.map((task) => task.id)
  const works =
    ids.length === 0
      ? []
      : await tx
          .select({ taskId: schema.works.taskId, state: schema.works.state })
          .from(schema.works)
          .where(and(inArray(schema.works.taskId, ids), ne(schema.works.state, 'retired')))
  const artifacts =
    ids.length === 0
      ? []
      : await tx
          .select({
            taskId: schema.artifacts.taskId,
            id: schema.artifacts.id,
            sha256: schema.artifacts.sha256,
            publishedAt: schema.artifacts.publishedAt,
          })
          .from(schema.artifacts)
          .where(
            and(inArray(schema.artifacts.taskId, ids), eq(schema.artifacts.status, 'published')),
          )
          .orderBy(asc(schema.artifacts.id))
  const workByTask = new Map(works.map((work) => [work.taskId, work.state]))
  const artifactsByTask = new Map<string, { id: string; sha256: string; publishedAt: string }[]>()
  for (const artifact of artifacts) {
    if (artifact.publishedAt === null) continue
    const list = artifactsByTask.get(artifact.taskId) ?? []
    list.push({
      id: artifact.id,
      sha256: artifact.sha256,
      publishedAt: artifact.publishedAt.toISOString(),
    })
    artifactsByTask.set(artifact.taskId, list)
  }
  const entries = visible.map((task) => ({
    taskId: task.id,
    status: task.status,
    assignmentStatus: task.assignmentStatus,
    workState: workByTask.get(task.id) ?? null,
    publishedArtifacts: artifactsByTask.get(task.id) ?? [],
  }))
  return { entries, digest: sha256Hex(canonicalJson(entries)), complete }
}

/**
 * Hub 只填入已登记的活动、槽位与已验证来源引用；模型不生成或补填模板正文。
 * 模板可用 `{{activity}}` / `{{slot}}` / `{{sourceId}}` / `{{sourceVersion}}` 占位。
 */
export function renderDiscoveryTemplate(
  text: string,
  values: {
    readonly activity: string
    readonly slot: string
    readonly sourceId: string
    readonly sourceVersion: string
  },
): string {
  return text
    .replaceAll('{{activity}}', values.activity)
    .replaceAll('{{slot}}', values.slot)
    .replaceAll('{{sourceId}}', values.sourceId)
    .replaceAll('{{sourceVersion}}', values.sourceVersion)
}
