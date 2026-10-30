/**
 * ADR-0024 / PC-02a：来源绑定的 DB 不变量。
 *
 * 只测 schema 与 migration 层的约束（活动绑定唯一、撤销字段一致性、权限字段、
 * 租约主键与审计载荷上限）；生命周期语义由 apps/hub/tests/source.integration.spec.ts
 * 走真人 HTTP/WS 路径覆盖。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, NewProjectSourceRow } from '../src/index.js'
import {
  insertProjectSource,
  insertSourceAuditEvent,
  insertSourceLease,
  updateProjectSource,
} from '../src/index.js'
import {
  catchPgError,
  createTestDatabase,
  resetDatabase,
  seedRunPrereqs,
  type SeedIds,
} from './helpers.js'

describe('project source DB invariants', () => {
  let database: Database
  let ids: SeedIds

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ids = await seedRunPrereqs(database.db)
  })

  afterAll(async () => {
    await database.close()
  })

  function source(overrides: Partial<NewProjectSourceRow> = {}): NewProjectSourceRow {
    const now = new Date('2026-10-31T00:00:00.000Z')
    return {
      id: randomUUID(),
      projectId: ids.projectId,
      platform: 'feishu',
      kind: 'group',
      resourceKey: `oc_${randomUUID()}`,
      displayLabel: '活动筹备群',
      collectorNodeId: ids.deviceId,
      credentialSlot: 'feishu-app',
      appKey: 'fixture-app-key',
      shareScope: 'team',
      autoExtraction: false,
      status: 'active',
      permissionState: 'verified',
      permissionCheckedAt: now,
      permissionExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      permissionUnknownSince: null,
      authorizationGeneration: 1,
      boundBy: ids.userId,
      boundAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  it('allows one active binding per resource and permits a new row after revocation', async () => {
    const first = await insertProjectSource(database.db, source({ resourceKey: 'oc_reuse' }))
    const duplicate = await catchPgError(
      insertProjectSource(database.db, source({ resourceKey: 'oc_reuse' })),
    )
    expect(duplicate.code).toBe('23505')
    expect(duplicate.constraintName).toBe('project_source_active_resource')

    const revoked = await updateProjectSource(database.db, first.id, {
      status: 'revoked',
      revokedAt: new Date(),
      revokedBy: ids.userId,
      revokeReason: '活动结束',
      permissionState: 'denied',
      permissionCheckedAt: new Date(),
      permissionExpiresAt: null,
      permissionUnknownSince: null,
    })
    expect(revoked?.status).toBe('revoked')

    const second = await insertProjectSource(database.db, source({ resourceKey: 'oc_reuse' }))
    expect(second.id).not.toBe(first.id)
  })

  it('rejects a non-team share scope', async () => {
    const pg = await catchPgError(
      insertProjectSource(database.db, source({ shareScope: 'private' })),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('project_source_share_scope')
  })

  it('requires revoked fields to move together', async () => {
    const pg = await catchPgError(insertProjectSource(database.db, source({ status: 'revoked' })))
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('project_source_revoked_fields')
  })

  it('requires a verified permission to carry checked/expiry timestamps', async () => {
    const pg = await catchPgError(
      insertProjectSource(database.db, source({ permissionExpiresAt: null })),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('project_source_permission_fields')
  })

  it('keeps one lease per application event stream', async () => {
    const lease = {
      platform: 'feishu' as const,
      appKey: 'one-app-key',
      deviceId: ids.deviceId,
      generation: 1,
      leaseToken: randomUUID(),
      expiresAt: new Date(Date.now() + 90_000),
    }
    await insertSourceLease(database.db, lease)
    const pg = await catchPgError(
      insertSourceLease(database.db, { ...lease, leaseToken: randomUUID() }),
    )
    expect(pg.code).toBe('23505')
    expect(pg.constraintName).toBe('source_collection_lease_pkey')
  })

  it('caps audit payloads and forbids unknown actions', async () => {
    const row = await insertProjectSource(database.db, source())
    expect(
      (
        await insertSourceAuditEvent(database.db, {
          sourceId: row.id,
          action: 'bound',
          authorizationGeneration: 1,
        })
      ).action,
    ).toBe('bound')

    const tooLarge = await catchPgError(
      insertSourceAuditEvent(database.db, {
        sourceId: row.id,
        action: 'permission_changed',
        authorizationGeneration: 2,
        payload: { blob: 'x'.repeat(5000) },
      }),
    )
    expect(tooLarge.code).toBe('23514')
    expect(tooLarge.constraintName).toBe('source_audit_payload_size')

    const unknownAction = await catchPgError(
      insertSourceAuditEvent(database.db, {
        sourceId: row.id,
        // @ts-expect-error 故意越过类型：migration 的 CHECK 是最后一道闸。
        action: 'deleted',
        authorizationGeneration: 3,
      }),
    )
    expect(unknownAction.code).toBe('23514')
    expect(unknownAction.constraintName).toBe('source_audit_action')
  })
})
