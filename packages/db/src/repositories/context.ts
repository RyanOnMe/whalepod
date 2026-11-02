import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import {
  contextCitations,
  contextEntries,
  type ContextCitationRow,
  type ContextEntryRow,
  type NewContextCitationRow,
  type NewContextEntryRow,
} from '../schema/context.js'

export type {
  ContextCitationRow,
  ContextEntryRow,
  NewContextCitationRow,
  NewContextEntryRow,
} from '../schema/context.js'

// ADR-0025（PC-03a）：事实账本的持久化原语。状态机与权限由 Hub 命令层裁决；
// 「当前有效集」只在这里与读面统一过滤，禁止调用方另写条件。

export async function insertContextEntry(
  handle: DbHandle,
  values: NewContextEntryRow,
): Promise<ContextEntryRow> {
  const [row] = await handle.insert(contextEntries).values(values).returning()
  if (row === undefined) throw new Error('insert context entry returned no row')
  return row
}

/** 确定性 Observation 的幂等投影：撞已有 businessRef+version 时回读既有行。 */
export async function insertObservationIfAbsent(
  handle: DbHandle,
  values: NewContextEntryRow,
): Promise<{ readonly row: ContextEntryRow; readonly inserted: boolean }> {
  // 本切片的 Observation 都是业务事实；source-only 行（businessRef=null）由 03b
  // 走带 targetWhere 的冲突目标，不能在这里用空串回读掩盖冲突。
  if (values.businessRef == null || values.businessVersion == null) {
    throw new Error('business observations require businessRef and businessVersion')
  }
  const [row] = await handle.insert(contextEntries).values(values).onConflictDoNothing().returning()
  if (row !== undefined) return { row, inserted: true }
  const existing = await findContextEntryByBusinessVersion(
    handle,
    'observation',
    values.businessRef,
    values.businessVersion,
  )
  if (existing === undefined) throw new Error('observation conflict without an existing row')
  return { row: existing, inserted: false }
}

export async function insertContextCitation(
  handle: DbHandle,
  values: NewContextCitationRow,
): Promise<ContextCitationRow> {
  const [row] = await handle.insert(contextCitations).values(values).returning()
  if (row === undefined) throw new Error('insert context citation returned no row')
  return row
}

export async function getContextEntry(
  handle: DbHandle,
  id: string,
): Promise<ContextEntryRow | undefined> {
  const [row] = await handle.select().from(contextEntries).where(eq(contextEntries.id, id))
  return row
}

export async function getContextEntryForUpdate(
  handle: DbHandle,
  id: string,
): Promise<ContextEntryRow | undefined> {
  const [row] = await handle
    .select()
    .from(contextEntries)
    .where(eq(contextEntries.id, id))
    .for('update')
  return row
}

/** 投影 Decision 时锁同一 businessRef 的当前有效行，串行化版本推进。 */
export async function findActiveDecisionForUpdate(
  handle: DbHandle,
  businessRef: string,
): Promise<ContextEntryRow | undefined> {
  const [row] = await handle
    .select()
    .from(contextEntries)
    .where(
      and(
        eq(contextEntries.kind, 'decision'),
        eq(contextEntries.businessRef, businessRef),
        eq(contextEntries.status, 'active'),
        isNull(contextEntries.correctedAt),
      ),
    )
    .for('update')
  return row
}

export async function findContextEntryByBusinessVersion(
  handle: DbHandle,
  kind: ContextEntryRow['kind'],
  businessRef: string,
  businessVersion: string,
): Promise<ContextEntryRow | undefined> {
  const [row] = await handle
    .select()
    .from(contextEntries)
    .where(
      and(
        eq(contextEntries.kind, kind),
        eq(contextEntries.businessRef, businessRef),
        eq(contextEntries.businessVersion, businessVersion),
      ),
    )
  return row
}

export async function findCorrectionForTarget(
  handle: DbHandle,
  targetEntryId: string,
): Promise<ContextEntryRow | undefined> {
  const [row] = await handle
    .select()
    .from(contextEntries)
    .where(
      and(eq(contextEntries.kind, 'correction'), eq(contextEntries.targetEntryId, targetEntryId)),
    )
  return row
}

export type ContextEntryPatch = Partial<typeof contextEntries.$inferInsert>

export async function updateContextEntry(
  handle: DbHandle,
  id: string,
  patch: ContextEntryPatch,
): Promise<ContextEntryRow | undefined> {
  const [row] = await handle
    .update(contextEntries)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(contextEntries.id, id))
    .returning()
  return row
}

/** 当前有效集：status='active' AND correctedAt IS NULL；不接受第二套条件。 */
export interface ContextEntryPage {
  readonly rows: readonly ContextEntryRow[]
  /** 还有下一段（调用方据此给出显式截断信号，绝不静默丢条目）。 */
  readonly hasMore: boolean
}

export interface ContextPageQuery {
  readonly limit: number
  /** 上一页最后一条的 id；由 SQL 子查询还原其 DB 精度 created_at（JS Date 只有毫秒）。 */
  readonly beforeId?: string
}

/**
 * 按 (created_at, id) 键集分页；排序与游标同源，避免 offset 漂移。
 *
 * 游标只携带 entry id：边界行的 created_at 由子查询在 DB 内以微秒精度参与元组比较。
 * 若把 JS Date 塞进游标，同一毫秒内的行会被 `(created_at, id) < (ms, id)` 整组跳过
 * （评审复现：60 条同毫秒行只能翻到 33 条）——这是静默截断，违反 ADR 读面要求。
 */
export async function listCurrentContextEntries(
  handle: DbHandle,
  projectId: string,
  options: ContextPageQuery,
): Promise<ContextEntryPage> {
  const beforeId = options.beforeId
  const rows = await handle
    .select()
    .from(contextEntries)
    .where(
      and(
        eq(contextEntries.projectId, projectId),
        eq(contextEntries.status, 'active'),
        isNull(contextEntries.correctedAt),
        beforeId !== undefined
          ? sql`(${contextEntries.createdAt}, ${contextEntries.id}) < (
              select cursor.created_at, cursor.id
              from context_entry cursor
              where cursor.id = ${beforeId} and cursor.project_id = ${projectId}
            )`
          : undefined,
      ),
    )
    .orderBy(desc(contextEntries.createdAt), desc(contextEntries.id))
    .limit(options.limit + 1)
  return { rows: rows.slice(0, options.limit), hasMore: rows.length > options.limit }
}

/** 协调输入：当前有效集但排除协调自己的 Inference，避免结果反过来触发下一次评估。 */
export async function listCoordinationInputEntries(
  handle: DbHandle,
  projectId: string,
  limit: number,
): Promise<ContextEntryRow[]> {
  return handle
    .select()
    .from(contextEntries)
    .where(
      and(
        eq(contextEntries.projectId, projectId),
        eq(contextEntries.status, 'active'),
        isNull(contextEntries.correctedAt),
        sql`${contextEntries.kind} <> 'inference'`,
      ),
    )
    .orderBy(desc(contextEntries.createdAt), desc(contextEntries.id))
    .limit(limit)
}

export async function countCoordinationInputEntries(
  handle: DbHandle,
  projectId: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: count() })
    .from(contextEntries)
    .where(
      and(
        eq(contextEntries.projectId, projectId),
        eq(contextEntries.status, 'active'),
        isNull(contextEntries.correctedAt),
        sql`${contextEntries.kind} <> 'inference'`,
      ),
    )
  return Number(row?.value ?? 0)
}

/** Run 快照选择用的有界查询：按 businessRef 前缀取当前有效条目。 */
export async function listCurrentContextEntriesByBusinessRefs(
  handle: DbHandle,
  projectId: string,
  businessRefs: readonly string[],
): Promise<ContextEntryRow[]> {
  if (businessRefs.length === 0) return []
  return handle
    .select()
    .from(contextEntries)
    .where(
      and(
        eq(contextEntries.projectId, projectId),
        eq(contextEntries.status, 'active'),
        isNull(contextEntries.correctedAt),
        inArray(contextEntries.businessRef, [...businessRefs]),
      ),
    )
    .orderBy(asc(contextEntries.createdAt), asc(contextEntries.id))
}

export async function listContextCitations(
  handle: DbHandle,
  entryIds: readonly string[],
): Promise<ContextCitationRow[]> {
  if (entryIds.length === 0) return []
  return handle
    .select()
    .from(contextCitations)
    .where(inArray(contextCitations.entryId, [...entryIds]))
    .orderBy(asc(contextCitations.entryId), asc(contextCitations.id))
}
