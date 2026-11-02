import type { DbHandle } from '@whalepod/db'
import {
  listContextCitations,
  listCurrentContextEntries,
  type ContextCitationRow,
  type ContextEntryRow,
} from '@whalepod/db'
import { z } from 'zod'
import type {
  ContextCitationView,
  ProjectContextEntryView,
  ProjectContextView,
} from '@whalepod/protocol'

function toCitationView(row: ContextCitationRow): ContextCitationView | undefined {
  if (row.kind === 'business') {
    if (row.businessRef === null || row.businessVersion === null || row.occurredAt === null) {
      return undefined
    }
    return {
      kind: 'business',
      businessRef: row.businessRef,
      businessVersion: row.businessVersion,
      occurredAt: row.occurredAt.toISOString(),
    }
  }
  if (
    row.sourceId === null ||
    row.revisionId === null ||
    row.resourceKey === null ||
    row.locator === null ||
    row.authorizationGeneration === null ||
    row.observedAt === null ||
    row.digest === null
  ) {
    return undefined
  }
  return {
    kind: 'source',
    sourceId: row.sourceId,
    revisionId: row.revisionId,
    resourceKey: row.resourceKey,
    ...(row.threadKey !== null ? { threadKey: row.threadKey } : {}),
    locator: row.locator,
    authorizationGeneration: row.authorizationGeneration,
    observedAt: row.observedAt.toISOString(),
    digest: row.digest,
  }
}

export function toContextEntryView(
  row: ContextEntryRow,
  citations: readonly ContextCitationRow[],
): ProjectContextEntryView {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    correctedAt: row.correctedAt?.toISOString() ?? null,
    title: row.title,
    body: row.body,
    payload: row.payload,
    businessRef: row.businessRef,
    businessVersion: row.businessVersion,
    targetEntryId: row.targetEntryId,
    evaluationId: row.evaluationId,
    inputDigest: row.inputDigest,
    actorKind: row.actorKind,
    createdBy: row.createdBy,
    processorVersion: row.processorVersion,
    createdAt: row.createdAt.toISOString(),
    citations: citations
      .map(toCitationView)
      .filter((citation): citation is ContextCitationView => citation !== undefined),
  }
}

/**
 * 游标只编码 entry id（身份分页，不编码正文/时间）。边界时间戳由 DB 子查询按
 * 微秒精度还原，避免 JS Date 毫秒截断导致同毫秒行整组丢失。
 */
export function encodeContextCursor(entry: ContextEntryRow): string {
  return Buffer.from(entry.id, 'utf8').toString('base64url')
}

export interface ContextCursor {
  readonly id: string
}

export function parseContextCursor(raw: string): ContextCursor | undefined {
  // Buffer 的 base64url 解码不会抛错：坏输入要么解出非 UUID，要么解出空串。
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  const parsed = z.uuid().safeParse(decoded)
  return parsed.success ? { id: parsed.data } : undefined
}

export interface ProjectContextPage {
  readonly view: ProjectContextView
  /** 缺引用的条目被挡在读面外（ADR-0025：缺引用不落读面）；调用方据此告警。 */
  readonly omittedEntryIds: readonly string[]
}

export interface ProjectContextQuery {
  readonly limit: number
  readonly beforeId?: string
}

export async function loadProjectContext(
  handle: DbHandle,
  projectId: string,
  options: ProjectContextQuery,
): Promise<ProjectContextPage> {
  const page = await listCurrentContextEntries(handle, projectId, options)
  const citations = await listContextCitations(
    handle,
    page.rows.map((entry) => entry.id),
  )
  const byEntry = new Map<string, ContextCitationRow[]>()
  for (const citation of citations) {
    const list = byEntry.get(citation.entryId) ?? []
    list.push(citation)
    byEntry.set(citation.entryId, list)
  }
  const entries: ProjectContextEntryView[] = []
  const omittedEntryIds: string[] = []
  for (const entry of page.rows) {
    const view = toContextEntryView(entry, byEntry.get(entry.id) ?? [])
    // fail-closed：Observation/Decision/Inference 没有可用引用时不进读面，
    // 也不靠「客户端忽略空数组」碰运气。
    if (entry.kind !== 'correction' && view.citations.length === 0) {
      omittedEntryIds.push(entry.id)
      continue
    }
    entries.push(view)
  }
  const last = page.rows.at(-1)
  return {
    view: {
      projectId,
      entries,
      nextCursor: page.hasMore && last !== undefined ? encodeContextCursor(last) : null,
    },
    omittedEntryIds,
  }
}
