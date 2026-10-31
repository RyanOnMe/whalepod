import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import {
  projectSources,
  sourceAuditEvents,
  sourceCollectionLeases,
  type NewProjectSourceRow,
  type ProjectSourceRow,
  type SourceAuditEventRow,
  type SourceCollectionLeaseRow,
} from '../schema/source.js'

export type {
  NewProjectSourceRow,
  ProjectSourceRow,
  SourceAuditEventRow,
  SourceCollectionLeaseRow,
} from '../schema/source.js'

// ADR-0024（PC-02a）：来源绑定的持久化原语。状态合法性由 Hub 命令决定；
// 这里只做读写，不解析平台资源身份，也不接触凭据。

export async function insertProjectSource(
  handle: DbHandle,
  values: NewProjectSourceRow,
): Promise<ProjectSourceRow> {
  const [row] = await handle.insert(projectSources).values(values).returning()
  if (row === undefined) throw new Error('insert project source returned no row')
  return row
}

export async function getProjectSource(
  handle: DbHandle,
  id: string,
): Promise<ProjectSourceRow | undefined> {
  const [row] = await handle.select().from(projectSources).where(eq(projectSources.id, id))
  return row
}

/** 生命周期命令用行锁串行化同一来源的暂停/恢复/撤销。 */
export async function getProjectSourceForUpdate(
  handle: DbHandle,
  id: string,
): Promise<ProjectSourceRow | undefined> {
  const [row] = await handle
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .for('update')
  return row
}

/** 活动绑定 = 非 revoked；供唯一资源身份与重复绑定判定。 */
export async function findActiveProjectSource(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  resourceKey: string,
): Promise<ProjectSourceRow | undefined> {
  const [row] = await handle
    .select()
    .from(projectSources)
    .where(
      and(
        eq(projectSources.platform, platform),
        eq(projectSources.resourceKey, resourceKey),
        ne(projectSources.status, 'revoked'),
      ),
    )
    .limit(1)
  return row
}

export async function listProjectSources(
  handle: DbHandle,
  projectId: string,
): Promise<ProjectSourceRow[]> {
  return handle
    .select()
    .from(projectSources)
    .where(eq(projectSources.projectId, projectId))
    .orderBy(asc(projectSources.createdAt), asc(projectSources.id))
}

export type ProjectSourcePatch = Partial<typeof projectSources.$inferInsert>

export async function updateProjectSource(
  handle: DbHandle,
  id: string,
  patch: ProjectSourcePatch,
): Promise<ProjectSourceRow | undefined> {
  const [row] = await handle
    .update(projectSources)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(projectSources.id, id))
    .returning()
  return row
}

/** 为租约释放审计挑一条未撤销来源（同 appKey）；来源行本身不受影响。 */
export async function findSourceByAppKey(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  appKey: string,
): Promise<ProjectSourceRow | undefined> {
  const [row] = await handle
    .select()
    .from(projectSources)
    .where(
      and(
        eq(projectSources.platform, platform),
        eq(projectSources.appKey, appKey),
        ne(projectSources.status, 'revoked'),
      ),
    )
    .orderBy(asc(projectSources.createdAt))
    .limit(1)
  return row
}

/** 活跃来源数（status=active）：租约只服务真正采集中的来源。 */
export async function countActiveSourcesByAppKey(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  appKey: string,
  excludeSourceId?: string,
): Promise<number> {
  const conditions = [
    eq(projectSources.platform, platform),
    eq(projectSources.appKey, appKey),
    eq(projectSources.status, 'active'),
  ]
  if (excludeSourceId !== undefined) conditions.push(ne(projectSources.id, excludeSourceId))
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(projectSources)
    .where(and(...conditions))
  return row?.count ?? 0
}

export async function listActiveSources(handle: DbHandle): Promise<ProjectSourceRow[]> {
  return handle
    .select()
    .from(projectSources)
    .where(eq(projectSources.status, 'active'))
    .orderBy(asc(projectSources.createdAt))
}

/** 未撤销来源（active + paused）：采集器被撤销/解绑时暂停来源也要墓碑化。 */
export async function listLiveSources(handle: DbHandle): Promise<ProjectSourceRow[]> {
  return handle
    .select()
    .from(projectSources)
    .where(inArray(projectSources.status, ['active', 'paused']))
    .orderBy(asc(projectSources.createdAt))
}

// ---------------- 采集租约 ----------------

export async function getSourceLease(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  appKey: string,
): Promise<SourceCollectionLeaseRow | undefined> {
  const [row] = await handle
    .select()
    .from(sourceCollectionLeases)
    .where(
      and(eq(sourceCollectionLeases.platform, platform), eq(sourceCollectionLeases.appKey, appKey)),
    )
  return row
}

export async function getSourceLeaseForUpdate(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  appKey: string,
): Promise<SourceCollectionLeaseRow | undefined> {
  const [row] = await handle
    .select()
    .from(sourceCollectionLeases)
    .where(
      and(eq(sourceCollectionLeases.platform, platform), eq(sourceCollectionLeases.appKey, appKey)),
    )
    .for('update')
  return row
}

export interface NewSourceLease {
  platform: ProjectSourceRow['platform']
  appKey: string
  deviceId: string
  generation: number
  leaseToken: string
  expiresAt: Date
}

export async function insertSourceLease(
  handle: DbHandle,
  values: NewSourceLease,
): Promise<SourceCollectionLeaseRow> {
  const [row] = await handle.insert(sourceCollectionLeases).values(values).returning()
  if (row === undefined) throw new Error('insert source lease returned no row')
  return row
}

export async function insertSourceLeaseIfAbsent(
  handle: DbHandle,
  values: NewSourceLease,
): Promise<SourceCollectionLeaseRow | undefined> {
  const [row] = await handle
    .insert(sourceCollectionLeases)
    .values(values)
    .onConflictDoNothing()
    .returning()
  return row
}

export async function listSourceLeases(handle: DbHandle): Promise<SourceCollectionLeaseRow[]> {
  return handle
    .select()
    .from(sourceCollectionLeases)
    .orderBy(asc(sourceCollectionLeases.acquiredAt))
}

export async function updateSourceLease(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  appKey: string,
  patch: Partial<typeof sourceCollectionLeases.$inferInsert>,
): Promise<SourceCollectionLeaseRow | undefined> {
  const [row] = await handle
    .update(sourceCollectionLeases)
    .set(patch)
    .where(
      and(eq(sourceCollectionLeases.platform, platform), eq(sourceCollectionLeases.appKey, appKey)),
    )
    .returning()
  return row
}

export async function deleteSourceLease(
  handle: DbHandle,
  platform: ProjectSourceRow['platform'],
  appKey: string,
): Promise<void> {
  await handle
    .delete(sourceCollectionLeases)
    .where(
      and(eq(sourceCollectionLeases.platform, platform), eq(sourceCollectionLeases.appKey, appKey)),
    )
}

// ---------------- 审计 ----------------

export interface NewSourceAuditEvent {
  sourceId: string
  action:
    | 'bound'
    | 'paused'
    | 'resumed'
    | 'revoked'
    | 'unavailable'
    | 'permission_changed'
    | 'lease_changed'
  actorMemberId?: string | null
  authorizationGeneration: number
  reason?: string | null
  payload?: Record<string, unknown>
}

export async function insertSourceAuditEvent(
  handle: DbHandle,
  values: NewSourceAuditEvent,
): Promise<SourceAuditEventRow> {
  const [row] = await handle
    .insert(sourceAuditEvents)
    .values({ ...values, payload: values.payload ?? {} })
    .returning()
  if (row === undefined) throw new Error('insert source audit event returned no row')
  return row
}

export async function listSourceAuditEvents(
  handle: DbHandle,
  sourceId: string,
  limit = 50,
): Promise<SourceAuditEventRow[]> {
  return handle
    .select()
    .from(sourceAuditEvents)
    .where(eq(sourceAuditEvents.sourceId, sourceId))
    .orderBy(asc(sourceAuditEvents.id))
    .limit(limit)
}

// ---------------- 权限过期 reconcile ----------------

/** verified 且已过期的未撤销来源（active + paused）；reconciler 重验或转 unknown。 */
export async function listSourcesWithExpiredPermission(
  handle: DbHandle,
  now: Date,
): Promise<ProjectSourceRow[]> {
  return handle
    .select()
    .from(projectSources)
    .where(
      and(
        inArray(projectSources.status, ['active', 'paused']),
        eq(projectSources.permissionState, 'verified'),
        lte(projectSources.permissionExpiresAt, now),
      ),
    )
    .orderBy(asc(projectSources.permissionExpiresAt))
}

/** unknown 已超过 cutoff 的未撤销来源（active + paused）；reconciler 转 unavailable。 */
export async function listSourcesUnknownSince(
  handle: DbHandle,
  cutoff: Date,
): Promise<ProjectSourceRow[]> {
  return handle
    .select()
    .from(projectSources)
    .where(
      and(
        inArray(projectSources.status, ['active', 'paused']),
        eq(projectSources.permissionState, 'unknown'),
        lte(projectSources.permissionUnknownSince, cutoff),
      ),
    )
    .orderBy(asc(projectSources.permissionUnknownSince))
}
