import type { Database, DbHandle, ProjectSourceRow } from '@whalepod/db'
import {
  appendTeamEvent,
  countActiveSourcesByAppKey,
  deleteSourceLease,
  getDeviceById,
  getProjectSourceForUpdate,
  getSourceLease,
  getSourceLeaseForUpdate,
  insertSourceAuditEvent,
  listActiveSources,
  listSourceLeases,
  listSourcesUnknownSince,
  listSourcesWithExpiredPermission,
  updateProjectSource,
  updateSourceLease,
} from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'
import {
  checkCollector,
  SOURCE_LEASE_TTL_MS,
  SOURCE_PERMISSION_TTL_MS,
  SOURCE_PERMISSION_UNKNOWN_GRACE_MS,
} from './commands.js'
import type { SourceCollector } from './collector.js'

export interface SourceReconcileResult {
  /** 到期 verified 重验成功、刷新水位的条数。 */
  readonly revalidated: number
  /** 重验无法完成、转 unknown 的条数。 */
  readonly unknown: number
  /** 转 unavailable 的条数（权限拒绝、采集器撤销/离线、unknown 超期、应用身份变化）。 */
  readonly unavailable: number
  /** 在线采集器的租约续租次数。 */
  readonly leasesRenewed: number
  /** 没有活跃来源而释放的租约数。 */
  readonly leasesReleased: number
}

export interface SourceReconcileInput {
  readonly database: Database
  readonly collector: SourceCollector
  readonly now: Date
  /** 结构化观测回调（server 注入 app.log.info）；只传不透明 id/状态/代次。 */
  readonly log?: (event: Record<string, unknown>) => void
}

type ProbeResult =
  | { readonly kind: 'readable' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'identity_changed' }
  | { readonly kind: 'unverifiable' }

type RevalidateOutcome =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'revalidated' | 'unknown' | 'denied' | 'identity_changed'
      readonly generation: number
    }

interface SourceEventFields {
  readonly sourceId: string
  readonly projectId: string
  readonly status: ProjectSourceRow['status']
  readonly permissionState?: ProjectSourceRow['permissionState']
  readonly authorizationGeneration: number
}

function logEvent(input: SourceReconcileInput, action: string, row: SourceEventFields): void {
  input.log?.({
    component: 'hub.context',
    action,
    sourceId: row.sourceId,
    projectId: row.projectId,
    status: row.status,
    ...(row.permissionState !== undefined ? { permissionState: row.permissionState } : {}),
    authorizationGeneration: row.authorizationGeneration,
  })
}

function appendSourceChanged(
  tx: DbHandle,
  row: Pick<ProjectSourceRow, 'id' | 'projectId'>,
  status: ProjectSourceRow['status'],
  permissionState: ProjectSourceRow['permissionState'] | undefined,
  now: Date,
): Promise<unknown> {
  return appendTeamEvent(tx, {
    type: 'source.changed',
    payload: {
      sourceId: row.id,
      projectId: row.projectId,
      status,
      changedAt: now.toISOString(),
      ...(permissionState !== undefined ? { permissionState } : {}),
    },
  })
}

async function auditPermissionChange(
  tx: DbHandle,
  sourceId: string,
  generation: number,
  to: 'verified' | 'unknown' | 'denied' | 'unavailable',
  reason: string,
): Promise<void> {
  await insertSourceAuditEvent(tx, {
    sourceId,
    action: 'permission_changed',
    authorizationGeneration: generation,
    payload: { to, reason },
  })
}

/** 在线采集器续租；没有活跃来源的租约释放。并发绑定/撤销通过租约行锁串行化。 */
async function reconcileLeases(
  input: SourceReconcileInput,
): Promise<{ renewed: number; released: number }> {
  let renewed = 0
  let released = 0
  for (const lease of await listSourceLeases(input.database.db)) {
    const outcome = await input.database.transaction(async (tx) => {
      const locked = await getSourceLeaseForUpdate(tx, lease.platform, lease.appKey)
      if (locked === undefined) return undefined
      const active = await countActiveSourcesByAppKey(tx, locked.platform, locked.appKey)
      if (active === 0) {
        await deleteSourceLease(tx, locked.platform, locked.appKey)
        return 'released' as const
      }
      if (!input.collector.isOnline(locked.deviceId)) return undefined
      await updateSourceLease(tx, locked.platform, locked.appKey, {
        expiresAt: new Date(input.now.getTime() + SOURCE_LEASE_TTL_MS),
        renewedAt: input.now,
      })
      return 'renewed' as const
    })
    if (outcome === 'renewed') renewed += 1
    if (outcome === 'released') released += 1
  }
  return { renewed, released }
}

/** 采集 Node 被撤销/解绑，或超过租约期仍离线 → 来源 unavailable（ADR-0024 §2）。 */
async function reconcileCollectors(input: SourceReconcileInput): Promise<number> {
  let unavailable = 0
  for (const source of await listActiveSources(input.database.db)) {
    const device = await getDeviceById(input.database.db, source.collectorNodeId)
    let reason: string | undefined
    if (device === undefined || device.revokedAt !== null) {
      reason = 'collector_revoked'
    } else if (!input.collector.isOnline(device.id)) {
      const lease = await getSourceLease(input.database.db, source.platform, source.appKey)
      if (lease === undefined || lease.expiresAt.getTime() <= input.now.getTime()) {
        reason = 'collector_offline'
      }
    }
    if (reason === undefined) continue

    const changed = await input.database.transaction(async (tx) => {
      const row = await getProjectSourceForUpdate(tx, source.id)
      if (row === undefined || row.status !== 'active') return false
      const generation = row.authorizationGeneration + 1
      const updated = await updateProjectSource(tx, row.id, {
        status: 'unavailable',
        unavailableAt: input.now,
        pausedAt: null,
        authorizationGeneration: generation,
        updatedAt: input.now,
      })
      if (updated === undefined) return false
      await insertSourceAuditEvent(tx, {
        sourceId: row.id,
        action: 'unavailable',
        authorizationGeneration: generation,
        payload: { reason },
      })
      await appendSourceChanged(tx, row, 'unavailable', row.permissionState, input.now)
      logEvent(input, 'source.unavailable', {
        sourceId: row.id,
        projectId: row.projectId,
        status: 'unavailable',
        permissionState: row.permissionState,
        authorizationGeneration: generation,
      })
      return true
    })
    if (changed) unavailable += 1
  }
  return unavailable
}

async function probeSource(
  input: SourceReconcileInput,
  row: ProjectSourceRow,
): Promise<ProbeResult> {
  const device = await getDeviceById(input.database.db, row.collectorNodeId)
  if (device === undefined || device.revokedAt !== null) return { kind: 'unverifiable' }
  if (!input.collector.isOnline(device.id)) return { kind: 'unverifiable' }
  try {
    const check = await checkCollector(input.collector, device, {
      platform: row.platform,
      kind: row.kind,
      resourceKey: row.resourceKey,
      credentialSlot: row.credentialSlot,
    })
    if (!check.readable) {
      return { kind: check.reason === 'unsupported' ? 'unverifiable' : 'denied' }
    }
    if (check.appKey !== row.appKey) return { kind: 'identity_changed' }
    return { kind: 'readable' }
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === 'SOURCE_COLLECTOR_OFFLINE' || error.code === 'SOURCE_UNSUPPORTED')
    ) {
      return { kind: 'unverifiable' }
    }
    throw error
  }
}

async function markRevalidated(
  tx: DbHandle,
  row: ProjectSourceRow,
  now: Date,
): Promise<RevalidateOutcome> {
  const generation = row.authorizationGeneration + 1
  const updated = await updateProjectSource(tx, row.id, {
    permissionCheckedAt: now,
    permissionExpiresAt: new Date(now.getTime() + SOURCE_PERMISSION_TTL_MS),
    permissionUnknownSince: null,
    authorizationGeneration: generation,
    updatedAt: now,
  })
  if (updated === undefined) return { kind: 'skipped' }
  await auditPermissionChange(tx, row.id, generation, 'verified', 'revalidated')
  await appendSourceChanged(tx, row, 'active', undefined, now)
  return { kind: 'revalidated', generation }
}

async function markDenied(
  tx: DbHandle,
  row: ProjectSourceRow,
  now: Date,
): Promise<RevalidateOutcome> {
  const generation = row.authorizationGeneration + 1
  const updated = await updateProjectSource(tx, row.id, {
    status: 'unavailable',
    unavailableAt: now,
    pausedAt: null,
    permissionState: 'denied',
    permissionCheckedAt: now,
    permissionExpiresAt: null,
    permissionUnknownSince: null,
    authorizationGeneration: generation,
    updatedAt: now,
  })
  if (updated === undefined) return { kind: 'skipped' }
  await auditPermissionChange(tx, row.id, generation, 'denied', 'revalidation_denied')
  await appendSourceChanged(tx, row, 'unavailable', 'denied', now)
  return { kind: 'denied', generation }
}

async function markIdentityChanged(
  tx: DbHandle,
  row: ProjectSourceRow,
  now: Date,
): Promise<RevalidateOutcome> {
  const generation = row.authorizationGeneration + 1
  const updated = await updateProjectSource(tx, row.id, {
    status: 'unavailable',
    unavailableAt: now,
    pausedAt: null,
    permissionState: 'unknown',
    permissionCheckedAt: now,
    permissionExpiresAt: null,
    permissionUnknownSince: now,
    authorizationGeneration: generation,
    updatedAt: now,
  })
  if (updated === undefined) return { kind: 'skipped' }
  await auditPermissionChange(tx, row.id, generation, 'unavailable', 'app_key_changed')
  await appendSourceChanged(tx, row, 'unavailable', 'unknown', now)
  return { kind: 'identity_changed', generation }
}

async function markUnknown(
  tx: DbHandle,
  row: ProjectSourceRow,
  now: Date,
): Promise<RevalidateOutcome> {
  const generation = row.authorizationGeneration + 1
  const updated = await updateProjectSource(tx, row.id, {
    permissionState: 'unknown',
    permissionUnknownSince: now,
    authorizationGeneration: generation,
    updatedAt: now,
  })
  if (updated === undefined) return { kind: 'skipped' }
  await auditPermissionChange(tx, row.id, generation, 'unknown', 'verification_failed')
  await appendSourceChanged(tx, row, 'active', 'unknown', now)
  return { kind: 'unknown', generation }
}

/** 到期 verified 来源的真实重验；只有验过且失败才转 unknown（ADR-0024 §5）。 */
async function revalidatePermissions(
  input: SourceReconcileInput,
): Promise<{ revalidated: number; unknown: number; unavailable: number }> {
  let revalidated = 0
  let unknown = 0
  let unavailable = 0
  // 有界扫描：一次最多处理 16 条，剩余留给下一轮 10s tick，避免阻塞后台循环。
  for (const source of (await listSourcesWithExpiredPermission(input.database.db, input.now)).slice(
    0,
    16,
  )) {
    const probe = await probeSource(input, source)
    const outcome = await input.database.transaction(async (tx) => {
      const row = await getProjectSourceForUpdate(tx, source.id)
      if (
        row === undefined ||
        row.status !== 'active' ||
        row.permissionState !== 'verified' ||
        row.permissionExpiresAt === null ||
        row.permissionExpiresAt.getTime() > input.now.getTime()
      ) {
        return { kind: 'skipped' as const }
      }
      if (probe.kind === 'readable') return markRevalidated(tx, row, input.now)
      if (probe.kind === 'denied') return markDenied(tx, row, input.now)
      if (probe.kind === 'identity_changed') return markIdentityChanged(tx, row, input.now)
      return markUnknown(tx, row, input.now)
    })

    if (outcome.kind === 'skipped') continue
    if (outcome.kind === 'revalidated') revalidated += 1
    if (outcome.kind === 'unknown') unknown += 1
    if (outcome.kind === 'denied' || outcome.kind === 'identity_changed') unavailable += 1
    logEvent(input, `source.permission_${outcome.kind}`, {
      sourceId: source.id,
      projectId: source.projectId,
      status:
        outcome.kind === 'denied' || outcome.kind === 'identity_changed' ? 'unavailable' : 'active',
      permissionState:
        outcome.kind === 'revalidated'
          ? 'verified'
          : outcome.kind === 'denied'
            ? 'denied'
            : 'unknown',
      authorizationGeneration: outcome.generation,
    })
  }
  return { revalidated, unknown, unavailable }
}

/** unknown 连续 7 天（含已暂停来源，防止暂停绕过正文清除）→ unavailable。 */
async function expireUnknownSources(input: SourceReconcileInput): Promise<number> {
  let unavailable = 0
  const cutoff = new Date(input.now.getTime() - SOURCE_PERMISSION_UNKNOWN_GRACE_MS)
  for (const source of await listSourcesUnknownSince(input.database.db, cutoff)) {
    const changed = await input.database.transaction(async (tx) => {
      const row = await getProjectSourceForUpdate(tx, source.id)
      if (
        row === undefined ||
        (row.status !== 'active' && row.status !== 'paused') ||
        row.permissionState !== 'unknown' ||
        row.permissionUnknownSince === null ||
        row.permissionUnknownSince.getTime() > cutoff.getTime()
      ) {
        return false
      }
      const generation = row.authorizationGeneration + 1
      const updated = await updateProjectSource(tx, row.id, {
        status: 'unavailable',
        unavailableAt: input.now,
        pausedAt: null,
        authorizationGeneration: generation,
        updatedAt: input.now,
      })
      if (updated === undefined) return false
      await auditPermissionChange(
        tx,
        row.id,
        generation,
        'unavailable',
        'permission_unknown_too_long',
      )
      await appendSourceChanged(tx, row, 'unavailable', 'unknown', input.now)
      logEvent(input, 'source.permission_unavailable', {
        sourceId: row.id,
        projectId: row.projectId,
        status: 'unavailable',
        permissionState: 'unknown',
        authorizationGeneration: generation,
      })
      return true
    })
    if (changed) unavailable += 1
  }
  return unavailable
}

/**
 * ADR-0024 §4/§5/§8 的单一后台收敛：
 * 1. 在线采集器续租；无活跃来源的租约释放；
 * 2. 采集器撤销或离线超过租约期 → unavailable；
 * 3. verified 到期后真实重验；成功刷新，失败才 unknown，明确拒绝转 denied/unavailable；
 * 4. unknown 连续 7 天（含暂停）→ unavailable。
 */
export async function reconcileSourcePermissions(
  input: SourceReconcileInput,
): Promise<SourceReconcileResult> {
  const leases = await reconcileLeases(input)
  const collectorUnavailable = await reconcileCollectors(input)
  const permission = await revalidatePermissions(input)
  const staleUnavailable = await expireUnknownSources(input)
  return {
    revalidated: permission.revalidated,
    unknown: permission.unknown,
    unavailable: collectorUnavailable + permission.unavailable + staleUnavailable,
    leasesRenewed: leases.renewed,
    leasesReleased: leases.released,
  }
}
