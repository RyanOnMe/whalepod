import { DomainError, asUserId, authorize, type Role } from '@whalepod/domain'
import type {
  Database,
  DbHandle,
  DeviceRow,
  ProjectSourceRow,
  SourceCollectionLeaseRow,
} from '@whalepod/db'
import {
  appendTeamEvent,
  countActiveSourcesByAppKey,
  deleteSourceLease,
  findActiveProjectSource,
  findCommandReceipt,
  getDeviceById,
  getProject,
  getProjectSource,
  getProjectSourceForUpdate,
  getSourceLeaseForUpdate,
  insertProjectSource,
  insertSourceAuditEvent,
  insertSourceLeaseIfAbsent,
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

export type CollectorCheck =
  | { readonly readable: true; readonly appKey: string }
  | { readonly readable: false; readonly reason: 'denied' | 'not_found' | 'unsupported' }

type ResumeOutcome = { readonly view: ProjectSourceView } | { readonly denied: true }

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

function bindCommandKey(actor: SourceActor, projectId: string, key: string): string {
  // key 按 actor + project 收窄：不同成员/项目即使撞同一个 Idempotency-Key 也不共享回执。
  return `source.bind:${actor.userId}:${projectId}:${key}`
}

function manageCommandKey(
  action: 'pause' | 'resume' | 'revoke',
  actor: SourceActor,
  sourceId: string,
  key: string,
): string {
  return `source.${action}:${actor.userId}:${sourceId}:${key}`
}

async function readReceipt<T>(database: Database, key: string): Promise<T | undefined> {
  const row = await findCommandReceipt(database.db, key)
  return row?.result as T | undefined
}

/**
 * 绑定/恢复前的只读检查（ADR-0024 §5）：
 * - 绑定者必须拥有采集 Node（404 不暴露别人的设备）；
 * - Node 必须在线并声明平台能力；
 * - 结果必须来自当前连接；denied/not_found 不区分存在性，统一交调用方映射 403。
 * `enforceOwnerUserId` 只在绑定时传；恢复沿用已绑定的采集者，不要求当前成员拥有它。
 */
export async function checkCollector(
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
    // Zod schema 已要求 readable 必须带 appKey；这里是适配器/实现违约的最后一道闸。
    throw new ApiError(409, 'SOURCE_COLLECTOR_OFFLINE', 'collector returned no app identity')
  }
  return { readable: true, appKey: snapshot.appKey }
}

export function rejectUnreadable(check: Extract<CollectorCheck, { readable: false }>): never {
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

function assertBind(actor: SourceActor): void {
  if (!authorize({ userId: asUserId(actor.userId), role: actor.role }, 'bind_project_source')) {
    throw new ApiError(403, 'FORBIDDEN', 'cannot bind a project source')
  }
}

/**
 * 同一应用事件流一个采集者。换 Node 只在没有其他活跃来源、且旧租约已过期时接管；
 * 过期后同一 device 再取租约要轮换代次与 token，围栏 PC-03 的旧观察。
 */
async function applyLease(
  tx: DbHandle,
  lease: SourceCollectionLeaseRow,
  input: { platform: SourcePlatform; appKey: string; deviceId: string; now: Date },
): Promise<number> {
  const expiresAt = new Date(input.now.getTime() + SOURCE_LEASE_TTL_MS)
  if (lease.deviceId === input.deviceId) {
    if (lease.expiresAt.getTime() <= input.now.getTime()) {
      const generation = lease.generation + 1
      await updateSourceLease(tx, input.platform, input.appKey, {
        generation,
        leaseToken: uuidv7(),
        expiresAt,
        acquiredAt: input.now,
        renewedAt: input.now,
      })
      return generation
    }
    await updateSourceLease(tx, input.platform, input.appKey, {
      expiresAt,
      renewedAt: input.now,
    })
    return lease.generation
  }

  // 另一台 Node 持有该应用事件流：只要还有活跃来源，就不允许静默换采集者。
  const active = await countActiveSourcesByAppKey(tx, input.platform, input.appKey)
  if (active > 0) {
    throw new ApiError(409, 'SOURCE_LEASE_LOST', 'another source is actively using this app')
  }
  if (lease.expiresAt.getTime() > input.now.getTime()) {
    throw new ApiError(409, 'SOURCE_LEASE_LOST', 'another collector holds the collection lease')
  }
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

async function ensureLease(
  tx: DbHandle,
  input: { platform: SourcePlatform; appKey: string; deviceId: string; now: Date },
): Promise<number> {
  const lease = await getSourceLeaseForUpdate(tx, input.platform, input.appKey)
  if (lease !== undefined) return applyLease(tx, lease, input)

  const expiresAt = new Date(input.now.getTime() + SOURCE_LEASE_TTL_MS)
  const inserted = await insertSourceLeaseIfAbsent(tx, {
    platform: input.platform,
    appKey: input.appKey,
    deviceId: input.deviceId,
    generation: 1,
    leaseToken: uuidv7(),
    expiresAt,
  })
  if (inserted !== undefined) return 1

  // 并发首建：另一个事务先插入了同一 (platform, appKey)，等它提交后再按同一规则处理。
  const raced = await getSourceLeaseForUpdate(tx, input.platform, input.appKey)
  if (raced === undefined) {
    throw new ApiError(409, 'SOURCE_LEASE_LOST', 'lease acquisition raced')
  }
  return applyLease(tx, raced, input)
}

/** 一条来源暂停/撤销后，若同一应用没有其他活跃来源，释放租约。锁租约以串行化并发绑定。 */
async function releaseLeaseIfUnused(tx: DbHandle, row: ProjectSourceRow): Promise<boolean> {
  const lease = await getSourceLeaseForUpdate(tx, row.platform, row.appKey)
  if (lease === undefined) return false
  const remaining = await countActiveSourcesByAppKey(tx, row.platform, row.appKey, row.id)
  if (remaining > 0) return false
  await deleteSourceLease(tx, row.platform, row.appKey)
  return true
}

function sourceChanged(
  tx: DbHandle,
  row: Pick<ProjectSourceRow, 'id' | 'projectId'>,
  status: ProjectSourceRow['status'],
  permissionState: ProjectSourceRow['permissionState'] | undefined,
  changedAt: Date,
): Promise<unknown> {
  return appendTeamEvent(tx, {
    type: 'source.changed',
    payload: {
      sourceId: row.id,
      projectId: row.projectId,
      status,
      changedAt: changedAt.toISOString(),
      ...(permissionState !== undefined ? { permissionState } : {}),
    },
  })
}

async function auditLease(
  tx: DbHandle,
  row: Pick<ProjectSourceRow, 'id'>,
  actorMemberId: string,
  generation: number,
  event: 'acquired' | 'taken_over' | 'released',
): Promise<void> {
  await insertSourceAuditEvent(tx, {
    sourceId: row.id,
    action: 'lease_changed',
    actorMemberId,
    authorizationGeneration: generation,
    payload: { event },
  })
}

export async function bindProjectSource(
  database: Database,
  collector: SourceCollector,
  input: BindProjectSourceInput,
): Promise<ProjectSourceView> {
  assertBind(input.actor)
  if (input.request.autoExtraction) {
    // ADR-0026 未接受前不广告一个不能兑现的后台提取状态。
    throw new ApiError(
      400,
      'SOURCE_UNSUPPORTED',
      'automatic extraction is not enabled yet (ADR-0026)',
    )
  }

  const commandKey = bindCommandKey(input.actor, input.projectId, input.idempotencyKey)
  // 回执先于任何 RPC：同 key 重放不得因采集 Node 后来离线/改权而返回不同结果。
  const prior = await readReceipt<ProjectSourceView>(database, commandKey)
  if (prior !== undefined) return prior

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
    return await transactCommand<ProjectSourceView>(database, commandKey, async (tx) => {
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
        payload: { platform: row.platform, kind: row.kind, leaseGeneration },
      })
      await auditLease(
        tx,
        row,
        input.actor.userId,
        row.authorizationGeneration,
        leaseGeneration > 1 ? 'taken_over' : 'acquired',
      )
      await sourceChanged(tx, row, 'active', undefined, now)
      return toSourceView(row)
    })
  } catch (error) {
    const pg = unwrapPgError(error)
    if (
      pg?.code === '23505' &&
      (pg.constraintName ?? '').includes('project_source_active_resource')
    ) {
      const raced = await readReceipt<ProjectSourceView>(database, commandKey)
      if (raced !== undefined) return raced
      throw new ApiError(409, 'SOURCE_ALREADY_BOUND', 'source is already bound')
    }
    if (
      error instanceof ApiError &&
      (error.code === 'SOURCE_LEASE_LOST' || error.code === 'SOURCE_ALREADY_BOUND')
    ) {
      // 并发同 key：胜者可能已提交回执；此时重放语义优先于租约冲突。
      const raced = await readReceipt<ProjectSourceView>(database, commandKey)
      if (raced !== undefined) return raced
    }
    throw error
  }
}

export async function pauseProjectSource(
  database: Database,
  input: ManageProjectSourceInput,
): Promise<ProjectSourceView> {
  const current = await getProjectSource(database.db, input.sourceId)
  if (current === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
  assertManage(current, input.actor)
  const commandKey = manageCommandKey('pause', input.actor, input.sourceId, input.idempotencyKey)
  const prior = await readReceipt<ProjectSourceView>(database, commandKey)
  if (prior !== undefined) return prior

  return transactCommand<ProjectSourceView>(database, commandKey, async (tx) => {
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
    if (leaseReleased) {
      await auditLease(tx, row, input.actor.userId, generation, 'released')
    }
    await sourceChanged(tx, row, 'paused', undefined, now)
    return toSourceView(updated)
  })
}

export async function resumeProjectSource(
  database: Database,
  collector: SourceCollector,
  input: ManageProjectSourceInput,
): Promise<ProjectSourceView> {
  const current = await getProjectSource(database.db, input.sourceId)
  if (current === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
  assertManage(current, input.actor)
  const commandKey = manageCommandKey('resume', input.actor, input.sourceId, input.idempotencyKey)
  const prior = await readReceipt<ProjectSourceView>(database, commandKey)
  if (prior !== undefined) return prior
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
  if (check.readable && check.appKey !== current.appKey) {
    // 采集器的应用身份变了：旧正文/租约无法继续证明属于同一应用，要求显式重绑。
    throw new ApiError(409, 'SOURCE_LEASE_LOST', 'collector app identity changed; rebind required')
  }

  const now = new Date()
  const permissionExpiresAt = new Date(now.getTime() + SOURCE_PERMISSION_TTL_MS)
  const outcome = await transactCommand<ResumeOutcome>(database, commandKey, async (tx) => {
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
      await sourceChanged(tx, row, 'unavailable', 'denied', now)
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
      payload: { leaseGeneration },
    })
    await auditLease(
      tx,
      row,
      input.actor.userId,
      generation,
      leaseGeneration > 1 ? 'taken_over' : 'acquired',
    )
    await sourceChanged(tx, row, 'active', undefined, now)
    return { view: toSourceView(updated) }
  })
  if ('denied' in outcome) {
    throw new ApiError(403, 'SOURCE_NOT_READABLE', 'source is no longer readable')
  }
  return outcome.view
}

export async function revokeProjectSource(
  database: Database,
  input: ManageProjectSourceInput & { readonly reason: string },
): Promise<ProjectSourceView> {
  const current = await getProjectSource(database.db, input.sourceId)
  if (current === undefined) throw new ApiError(404, 'NOT_FOUND', 'source not found')
  assertManage(current, input.actor)
  const commandKey = manageCommandKey('revoke', input.actor, input.sourceId, input.idempotencyKey)
  const prior = await readReceipt<ProjectSourceView>(database, commandKey)
  if (prior !== undefined) return prior

  return transactCommand<ProjectSourceView>(database, commandKey, async (tx) => {
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
      permissionCheckedAt: row.permissionCheckedAt,
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
    if (leaseReleased) {
      await auditLease(tx, row, input.actor.userId, generation, 'released')
    }
    await sourceChanged(tx, row, 'revoked', 'denied', now)
    return toSourceView(updated)
  })
}
