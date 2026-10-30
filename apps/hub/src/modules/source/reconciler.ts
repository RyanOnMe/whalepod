import type { Database } from '@whalepod/db'
import {
  appendTeamEvent,
  getProjectSourceForUpdate,
  insertSourceAuditEvent,
  listSourcesUnknownSince,
  listSourcesWithExpiredPermission,
  updateProjectSource,
} from '@whalepod/db'
import { SOURCE_PERMISSION_UNKNOWN_GRACE_MS } from './commands.js'

export interface SourceReconcileResult {
  /** verified 过期 → unknown 的条数。 */
  readonly expired: number
  /** unknown 超过 7 天 → unavailable 的条数。 */
  readonly unavailable: number
}

/**
 * ADR-0024 §5/§8：权限水位不由读面临时推断，而是单一后台收敛：
 * - verified 超过 permissionExpiresAt → unknown（停止正文使用，增加代次）；
 * - unknown 连续 7 天未恢复 → unavailable。
 * 每个状态变化与审计、Team Event 同事务；重复执行幂等。
 */
export async function reconcileSourcePermissions(input: {
  database: Database
  now: Date
  /** 结构化观测回调（server 注入 app.log.info）；只传不透明 id/状态/代次。 */
  log?: (event: Record<string, unknown>) => void
}): Promise<SourceReconcileResult> {
  const { database, now } = input
  let expired = 0
  let unavailable = 0

  for (const due of await listSourcesWithExpiredPermission(database.db, now)) {
    const changed = await database.transaction(async (tx) => {
      const row = await getProjectSourceForUpdate(tx, due.id)
      if (
        row === undefined ||
        row.status !== 'active' ||
        row.permissionState !== 'verified' ||
        row.permissionExpiresAt === null ||
        row.permissionExpiresAt.getTime() > now.getTime()
      ) {
        return false
      }
      const generation = row.authorizationGeneration + 1
      const updated = await updateProjectSource(tx, row.id, {
        permissionState: 'unknown',
        permissionUnknownSince: now,
        authorizationGeneration: generation,
        updatedAt: now,
      })
      if (updated === undefined) return false
      await insertSourceAuditEvent(tx, {
        sourceId: row.id,
        action: 'permission_changed',
        authorizationGeneration: generation,
        payload: { to: 'unknown', previousExpiresAt: row.permissionExpiresAt.toISOString() },
      })
      input.log?.({
        component: 'hub.context',
        action: 'source.permission_changed',
        sourceId: row.id,
        projectId: row.projectId,
        status: 'active',
        permissionState: 'unknown',
        authorizationGeneration: generation,
      })
      await appendTeamEvent(tx, {
        type: 'source.changed',
        payload: {
          sourceId: row.id,
          projectId: row.projectId,
          status: 'active',
          permissionState: 'unknown',
        },
      })
      return true
    })
    if (changed) expired += 1
  }

  const cutoff = new Date(now.getTime() - SOURCE_PERMISSION_UNKNOWN_GRACE_MS)
  for (const stale of await listSourcesUnknownSince(database.db, cutoff)) {
    const changed = await database.transaction(async (tx) => {
      const row = await getProjectSourceForUpdate(tx, stale.id)
      if (
        row === undefined ||
        row.status !== 'active' ||
        row.permissionState !== 'unknown' ||
        row.permissionUnknownSince === null ||
        row.permissionUnknownSince.getTime() > cutoff.getTime()
      ) {
        return false
      }
      const generation = row.authorizationGeneration + 1
      const updated = await updateProjectSource(tx, row.id, {
        status: 'unavailable',
        unavailableAt: now,
        authorizationGeneration: generation,
        updatedAt: now,
      })
      if (updated === undefined) return false
      await insertSourceAuditEvent(tx, {
        sourceId: row.id,
        action: 'permission_changed',
        authorizationGeneration: generation,
        payload: { to: 'unavailable', reason: 'permission_unknown_too_long' },
      })
      input.log?.({
        component: 'hub.context',
        action: 'source.permission_changed',
        sourceId: row.id,
        projectId: row.projectId,
        status: 'unavailable',
        permissionState: 'unknown',
        authorizationGeneration: generation,
      })
      await appendTeamEvent(tx, {
        type: 'source.changed',
        payload: {
          sourceId: row.id,
          projectId: row.projectId,
          status: 'unavailable',
          permissionState: 'unknown',
        },
      })
      return true
    })
    if (changed) unavailable += 1
  }

  return { expired, unavailable }
}
