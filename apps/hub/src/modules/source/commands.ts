import { DomainError, asUserId, authorize, type Role } from '@whalepod/domain'
import type { Database, DbHandle, DeviceRow, ProjectSourceRow } from '@whalepod/db'
import {
  appendTeamEvent,
  countSourcesByAppKey,
  deleteSourceLease,
  findActiveProjectSource,
  getDeviceById,
  getProject,
  getProjectSource,
  getProjectSourceForUpdate,
  getSourceLeaseForUpdate,
  insertProjectSource,
  insertSourceAuditEvent,
  insertSourceLease,
  transactCommand,
  updateProjectSource,
  updateSourceLease,
  unwrapPgError,
} from '@whalepod/db'
import type {
  CreateProjectSourceRequest,
  ProjectSourceView,
  SourceKind,
  SourcePlatform,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { NodeOfflineError, type SourceCollector } from './collector.js'
import { capabilityForPlatform, sourceCapabilitiesOf } from './device-capabilities.js'
import { toSourceView } from './queries.js'

// ADR-0024 §5/§8：绑定前权限检查 24 小时有效；采集租约 90 秒、每 30 秒续租；
// unknown 连续 7 天转 unavailable。
export const SOURCE_PERMISSION_TTL_MS = 24 * 60 * 60 * 1000
export const SOURCE_LEASE_TTL_MS = 90 * 1000
export const SOURCE_PERMISSION_UNKNOWN_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export interface SourceActor {
  readonly userId: string
  readonly role: Role
}

type ResumeOutcome = { readonly view: ProjectSourceView } | { readonly denied: true }

type CollectorCheck =
  | { readonly readable: true; readonly appKey: string; readonly upstreamVersion?: string }
  | { readonly readable: false; readonly reason: 'denied' | 'not_found' | 'unsupported' }

export interface BindProjectSourceInput {
  readonly projectId: string
  readonly actor: SourceActor
  readonly request: CreateProjectSourceRequest
  readonly idempotencyKey: string
}

export interface ManageProjectSourceInput {
  readonly sourceId: string
  readonly actor: SourceActor
  readonly idempotencyKey: string
}

/**
 * 绑定前只读检查（ADR-0024 §5）：
 * - 绑定者必须拥有采集 Node（404 不暴露别人的设备）；
 * - Node 必须在线并声明平台能力；
 * - 结果必须来自当前连接；denied/not_found 不区分存在性，统一交调用方映射 403。
 */
async function checkCollector(
  collector: SourceCollector,
  device: DeviceRow,
  input: {
    platform: SourcePlatform
    kind: SourceKind
    resourceKey: string
    credentialSlot: string
  },
  options: { readonly enforceOwnerUserId?: string } = {},
): Promise<CollectorCheck> {
  if (
    options.enforceOwnerUserId !== undefined &&
    device.ownerUserId !== options.enforceOwnerUserId
  ) {
    throw new ApiError(404, 'NOT_FOUND', 'collector node not found')
  }
  if (device.revokedAt !== null) {
    throw new ApiError(409, 'SOURCE_COLLECTOR_OFFLINE', 'collector node is revoked')
  }
  if (!sourceCapabilitiesOf(device).includes(capabilityForPlatform(input.platform))) {
    throw new ApiError(
      400,
      'SOURCE_UNSUPPORTED',
      'collector node does not advertise this source capability',
    )
  }
  if (!collector.isOnline(device.id)) {
    throw new ApiError(409, 'SOURCE_COLLECTOR_OFFLINE', 'collector node is offline')
  }
  let snapshot
  try {
    snapshot = await collector.requestSourcePermission(
      device.id,
      {
        platform: input.platform,
        kind: input.kind,
        resourceKey: input.resourceKey,
        credentialSlot: input.credentialSlot,
      },
      5_000,
    )
  } catch (error) {
    if (error instanceof NodeOfflineError) {
      throw new ApiError(409, 'SOURCE_COLLECTOR_OFFLINE', 'collector node did not answer')
    }
    throw error
  }
  if (!snapshot.isCurrent()) {
    throw new ApiError(409, 'SOURCE_COLLECTOR_OFFLINE', 'collector connection changed')
  }
  if (snapshot.result !== 'readable') {
    return { readable: false, reason: snapshot.result }
  }
  if (snapshot.appKey === undefined) {
    throw new ApiError(400, 'SOURCE_UNSUPPORTED', 'collector did not return an appKey')
  }
  return {
    readable: true,
    appKey: snapshot.appKey,
    ...(snapshot.upstreamVersion !== undefined
      ? { upstreamVersion: snapshot.upstreamVersion }
      : {}),
  }
}

function rejectUnreadable(check: Extract<CollectorCheck, { readable: false }>): never {
  if (check.reason === 'unsupported') {
    throw new ApiError(400, 'SOURCE_UNSUPPORTED', 'collector does not support this source')
  }
  // denied 与 not_found 同一形态：不暴露外部资源是否存在。
  throw new ApiError(403, 'SOURCE_NOT_READABLE', 'source is not readable by the collector')
}

function assertManage(row: ProjectSourceRow, actor: SourceActor): void {
  const allowed = authorize(
    { userId: asUserId(actor.userId), role: actor.role },
    'manage_project_source',
    { ownerUserId: asUserId(row.boundBy) },
  )
  if (!allowed) {
    throw new ApiError(403, 'FORBIDDEN', 'only the binder or an admin can manage this source')
  }
}

/** 同一应用事件流一个采集者；换 Node 只在旧租约已过期时接管并提升代次。 */
async function ensureLease(
  tx: DbHandle,
  input: { platform: SourcePlatform; appKey: string; deviceId: string; now: Date },
): Promise<number> {
  const lease = await getSourceLeaseForUpdate(tx, input.platform, input.appKey)
  const expiresAt = new Date(input.now.getTime() + SOURCE_LEASE_TTL_MS)
  if (lease === undefined) {
    await insertSourceLease(tx, {
      platform: input.platform,
      appKey: input.appKey,
      deviceId: input.deviceId,
      generation: 1,
      leaseToken: uuidv7(),
      expiresAt,
    })
    return 1
  }
  if (lease.deviceId === input.deviceId) {
    await updateSourceLease(tx, input.platform, input.appKey, {
      expiresAt,
      renewedAt: input.now,
    })
    return lease.generation
  }
  if (lease.expiresAt.getTime() <= input.now.getTime()) {
    const generation = lease.generation + 1
    await updateSourceLease(tx, input.platform, input.appKey, {
      deviceId: input.deviceId,
      generation,
      leaseToken: uuidv7(),
      expiresAt,
      acquiredAt: input.now,
      renewedAt: input.now,
    })
    return generation
  }
  throw new ApiError(409, 'SOURCE_LEASE_LOST', 'another collector holds the collection lease')
}

/** 一条来源暂停/撤销后，若同一应用没有其他来源，释放租约。 */
async function releaseLeaseIfUnused(tx: DbHandle, row: ProjectSourceRow): Promise<boolean> {
  const remaining = await countSourcesByAppKey(tx, row.platform, row.appKey, row.id)
  if (remaining > 0) return false
  await deleteSourceLease(tx, row.platform, row.appKey)
  return true
}

function sourceChanged(
  tx: DbHandle,
  row: Pick<ProjectSourceRow, 'id' | 'projectId'>,
  status: ProjectSourceRow['status'],
  permissionState?: ProjectSourceRow['permissionState'],
): Promise<unknown> {
  return appendTeamEvent(tx, {
    type: 'source.changed',
    payload: {
      sourceId: row.id,
      projectId: row.projectId,
      status,
      ...(permissionState !== undefined ? { permissionState } : {}),
    },
  })
}

export async function bindProjectSource(
  database: Database,
  collector: SourceCollector,
  input: BindProjectSourceInput,
): Promise<ProjectSourceView> {
  const project = await getProject(database.db, input.projectId)
  if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
  const device = await getDeviceById(database.db, input.request.collectorNodeId)
  if (device === undefined || device.revokedAt !== null) {
    throw new ApiError(404, 'NOT_FOUND', 'collector node not found')
  }
  const check = await checkCollector(collector, device, input.request, {
    enforceOwnerUserId: input.actor.userId,
  })
  if (!check.readable) rejectUnreadable(check)

  const now = new Date()
  const permissionExpiresAt = new Date(now.getTime() + SOURCE_PERMISSION_TTL_MS)
  try {
    return await transactCommand<ProjectSourceView>(
      database,
      `source.bind:${input.idempotencyKey}`,
      async (tx) => {
        const existing = await findActiveProjectSource(
          tx,
          input.request.platform,
          input.request.resourceKey,
        )
        if (existing !== undefined) {
          throw new ApiError(409, 'SOURCE_ALREADY_BOUND', 'source is already bound')
        }
        const leaseGeneration = await ensureLease(tx, {
          platform: input.request.platform,
          appKey: check.appKey,
          deviceId: device.id,
          now,
        })
        const row = await insertProjectSource(tx, {
          id: uuidv7(),
          projectId: input.projectId,
          platform: input.request.platform,
          kind: input.request.kind,
          resourceKey: input.request.resourceKey,
          displayLabel: input.request.displayLabel,
          collectorNodeId: device.id,
          credentialSlot: input.request.credentialSlot,
          appKey: check.appKey,
          shareScope: 'team',
          autoExtraction: input.request.autoExtraction,
          status: 'active',
          permissionState: 'verified',
          permissionCheckedAt: now,
          permissionExpiresAt,
          permissionUnknownSince: null,
          authorizationGeneration: 1,
          boundBy: input.actor.userId,
          boundAt: now,
          createdAt: now,
          updatedAt: now,
        })
        await insertSourceAuditEvent(tx, {
          sourceId: row.id,
          action: 'bound',
          actorMemberId: input.actor.userId,
          authorizationGeneration: row.authorizationGeneration,
          payload: {
            platform: row.platform,
            kind: row.kind,
            leaseGeneration,
            ...(check.upstreamVersion !== undefined
              ? { upstreamVersion: check.upstreamVersion }
              : {}),
          },
        })
        await sourceChanged(tx, row, 'active')
        return toSourceView(row)
      },
    )
  } catch (error) {
    const pg = unwrapPgError(error)
    if (
      pg?.code === '23505' &&
      (pg.constraintName ?? '').includes('project_source_active_resource')
    ) {
      throw new ApiError(409, 'SOURCE_ALREADY_BOUND', 'source is already bound')
    }
    throw error
  }
}

export async function pauseProjectSource(
  database: Database,
  input: ManageProjectSourceInput,
): Promise<ProjectSourceView> {
  return transactCommand<ProjectSourceView>(
    database,
    `source.pause:${input.sourceId}:${input.idempotencyKey}`,
    async (tx) => {
      const row = await getProjectSourceForUpdate(tx, input.sourceId)
      if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
      assertManage(row, input.actor)
      if (row.status === 'paused') return toSourceView(row)
      if (row.status !== 'active') {
        throw new DomainError('INVALID_SOURCE_TRANSITION', `cannot pause a ${row.status} source`)
      }
      const now = new Date()
      const generation = row.authorizationGeneration + 1
      const updated = await updateProjectSource(tx, row.id, {
        status: 'paused',
        pausedAt: now,
        authorizationGeneration: generation,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
      const leaseReleased = await releaseLeaseIfUnused(tx, row)
      await insertSourceAuditEvent(tx, {
        sourceId: row.id,
        action: 'paused',
        actorMemberId: input.actor.userId,
        authorizationGeneration: generation,
        payload: { leaseReleased },
      })
      await sourceChanged(tx, row, 'paused')
      return toSourceView(updated)
    },
  )
}

export async function resumeProjectSource(
  database: Database,
  collector: SourceCollector,
  input: ManageProjectSourceInput,
): Promise<ProjectSourceView> {
  const current = await getProjectSource(database.db, input.sourceId)
  if (current === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
  assertManage(current, input.actor)
  if (current.status === 'active') return toSourceView(current)
  if (current.status !== 'paused') {
    throw new DomainError('INVALID_SOURCE_TRANSITION', `cannot resume a ${current.status} source`)
  }
  const device = await getDeviceById(database.db, current.collectorNodeId)
  if (device === undefined) {
    throw new ApiError(409, 'SOURCE_COLLECTOR_OFFLINE', 'collector node no longer exists')
  }
  const check = await checkCollector(collector, device, {
    platform: current.platform,
    kind: current.kind,
    resourceKey: current.resourceKey,
    credentialSlot: current.credentialSlot,
  })
  if (!check.readable && check.reason === 'unsupported') rejectUnreadable(check)

  const now = new Date()
  const permissionExpiresAt = new Date(now.getTime() + SOURCE_PERMISSION_TTL_MS)
  const outcome = await transactCommand<ResumeOutcome>(
    database,
    `source.resume:${input.sourceId}:${input.idempotencyKey}`,
    async (tx) => {
      const row = await getProjectSourceForUpdate(tx, input.sourceId)
      if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
      assertManage(row, input.actor)
      if (row.status === 'active') return { view: toSourceView(row) }
      if (row.status !== 'paused') {
        throw new DomainError('INVALID_SOURCE_TRANSITION', `cannot resume a ${row.status} source`)
      }
      const generation = row.authorizationGeneration + 1
      if (!check.readable) {
        // 权限已明确失效：暂停不能冒充恢复；转 unavailable 并保留理由。
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
        if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
        await insertSourceAuditEvent(tx, {
          sourceId: row.id,
          action: 'permission_changed',
          actorMemberId: input.actor.userId,
          authorizationGeneration: generation,
          payload: { to: 'denied', reason: check.reason },
        })
        await sourceChanged(tx, row, 'unavailable', 'denied')
        return { denied: true }
      }
      const leaseGeneration = await ensureLease(tx, {
        platform: row.platform,
        appKey: check.appKey,
        deviceId: row.collectorNodeId,
        now,
      })
      const updated = await updateProjectSource(tx, row.id, {
        status: 'active',
        pausedAt: null,
        unavailableAt: null,
        permissionState: 'verified',
        permissionCheckedAt: now,
        permissionExpiresAt,
        permissionUnknownSince: null,
        authorizationGeneration: generation,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
      await insertSourceAuditEvent(tx, {
        sourceId: row.id,
        action: 'resumed',
        actorMemberId: input.actor.userId,
        authorizationGeneration: generation,
        payload: {
          leaseGeneration,
          ...(check.upstreamVersion !== undefined
            ? { upstreamVersion: check.upstreamVersion }
            : {}),
        },
      })
      await sourceChanged(tx, row, 'active')
      return { view: toSourceView(updated) }
    },
  )
  if ('denied' in outcome) {
    throw new ApiError(403, 'SOURCE_NOT_READABLE', 'source is no longer readable')
  }
  return outcome.view
}

export async function revokeProjectSource(
  database: Database,
  input: ManageProjectSourceInput & { readonly reason: string },
): Promise<ProjectSourceView> {
  return transactCommand<ProjectSourceView>(
    database,
    `source.revoke:${input.sourceId}:${input.idempotencyKey}`,
    async (tx) => {
      const row = await getProjectSourceForUpdate(tx, input.sourceId)
      if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
      assertManage(row, input.actor)
      if (row.status === 'revoked') return toSourceView(row)
      const now = new Date()
      const generation = row.authorizationGeneration + 1
      const updated = await updateProjectSource(tx, row.id, {
        status: 'revoked',
        revokedAt: now,
        revokedBy: input.actor.userId,
        revokeReason: input.reason,
        pausedAt: null,
        unavailableAt: null,
        permissionState: 'denied',
        // 撤销不是一次权限检查：保留最后一次真实检查时刻，避免伪造核验时间。
        permissionCheckedAt: row.permissionCheckedAt ?? now,
        permissionExpiresAt: null,
        permissionUnknownSince: null,
        authorizationGeneration: generation,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
      const leaseReleased = await releaseLeaseIfUnused(tx, row)
      await insertSourceAuditEvent(tx, {
        sourceId: row.id,
        action: 'revoked',
        actorMemberId: input.actor.userId,
        authorizationGeneration: generation,
        reason: input.reason,
        payload: { leaseReleased },
      })
      await sourceChanged(tx, row, 'revoked', 'denied')
      return toSourceView(updated)
    },
  )
}
