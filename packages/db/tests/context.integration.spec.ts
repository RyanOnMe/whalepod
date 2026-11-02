/**
 * ADR-0025（PC-03a）：事实账本的 DB 不变量。
 *
 * 只测 schema 与 migration 层的约束；生命周期语义由 Hub 集成用例覆盖。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, NewContextEntryRow } from '../src/index.js'
import {
  insertContextCitation,
  insertContextEntry,
  insertObservationIfAbsent,
  schema,
  type ContextEntryRow,
} from '../src/index.js'
import {
  catchPgError,
  createTestDatabase,
  resetDatabase,
  seedRunPrereqs,
  type SeedIds,
} from './helpers.js'

describe('project context ledger DB invariants', () => {
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

  function entry(overrides: Partial<NewContextEntryRow> = {}): NewContextEntryRow {
    return {
      id: randomUUID(),
      projectId: ids.projectId,
      kind: 'observation',
      status: 'active',
      title: 'Run completed',
      body: 'run terminal observation',
      payload: {},
      businessRef: `run:${randomUUID()}`,
      businessVersion: 'completed',
      actorKind: 'system',
      ...overrides,
    }
  }

  async function insertDecision(
    overrides: Partial<NewContextEntryRow> = {},
  ): Promise<ContextEntryRow> {
    return insertContextEntry(
      database.db,
      entry({
        kind: 'decision',
        businessRef: 'taskSpec:fixed',
        businessVersion: `revision:${randomUUID()}`,
        actorKind: 'member',
        createdBy: ids.userId,
        ...overrides,
      }),
    )
  }

  it('rejects an Observation without a business or source reference', async () => {
    const pg = await catchPgError(
      insertContextEntry(database.db, entry({ businessRef: null, businessVersion: null })),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('context_entry_observation_fields')
  })

  it('requires Decisions to be written by a member with a business reference', async () => {
    for (const overrides of [
      { actorKind: 'system' as const, createdBy: null },
      { businessRef: null },
      { businessVersion: null },
      { createdBy: null },
    ]) {
      const pg = await catchPgError(
        insertContextEntry(
          database.db,
          entry({
            kind: 'decision',
            businessRef: 'taskSpec:fixed',
            businessVersion: 'revision:1',
            actorKind: 'member',
            createdBy: ids.userId,
            ...overrides,
          }),
        ),
      )
      expect(pg.code).toBe('23514')
      // 半空业务坐标会同时触发成对 CHECK；两种拒绝都算不变量生效。
      expect(['context_entry_decision_fields', 'context_entry_business_pair']).toContain(
        pg.constraintName,
      )
    }
  })

  it('requires Inference to carry evaluation identity and a coordinator actor', async () => {
    const pg = await catchPgError(
      insertContextEntry(
        database.db,
        entry({
          kind: 'inference',
          businessRef: null,
          businessVersion: null,
          actorKind: 'coordinator',
          evaluationId: null,
          inputDigest: null,
        }),
      ),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('context_entry_inference_fields')
  })

  it('requires Correction to target another entry and stays member-only', async () => {
    const target = await insertDecision()
    const pg = await catchPgError(
      insertContextEntry(
        database.db,
        entry({
          kind: 'correction',
          businessRef: null,
          businessVersion: null,
          actorKind: 'member',
          createdBy: ids.userId,
          targetEntryId: null,
        }),
      ),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('context_entry_correction_fields')

    const correction = await insertContextEntry(database.db, {
      id: randomUUID(),
      projectId: ids.projectId,
      kind: 'correction',
      status: 'active',
      title: 'Member correction',
      body: 'this was only a suggestion',
      payload: { correctionKind: 'amend' },
      actorKind: 'member',
      createdBy: ids.userId,
      targetEntryId: target.id,
    })
    expect(correction.targetEntryId).toBe(target.id)

    const duplicate = await catchPgError(
      insertContextEntry(database.db, {
        id: randomUUID(),
        projectId: ids.projectId,
        kind: 'correction',
        status: 'active',
        title: 'Second correction',
        body: 'must not overwrite',
        payload: {},
        actorKind: 'member',
        createdBy: ids.userId,
        targetEntryId: target.id,
      }),
    )
    expect(duplicate.code).toBe('23505')
    expect(duplicate.constraintName).toBe('context_entry_correction_target_unique')
  })

  it('keeps one active uncorrected Decision per businessRef', async () => {
    const first = await insertDecision({ businessVersion: 'revision:1' })
    const conflict = await catchPgError(insertDecision({ businessVersion: 'revision:2' }))
    expect(conflict.code).toBe('23505')
    expect(conflict.constraintName).toBe('context_entry_decision_active_unique')

    // 被纠正的旧行退出当前有效集：新 active 行可以插入（不改写旧行）。
    await database.db
      .update(schema.contextEntries)
      .set({ correctedAt: new Date() })
      .where(eq(schema.contextEntries.id, first.id))
    const next = await insertDecision({ businessVersion: 'revision:2' })
    expect(next.status).toBe('active')
  })

  it('rejects a Correction that carries business coordinates and half-null business pairs', async () => {
    const target = await insertDecision()
    const correctionPg = await catchPgError(
      insertContextEntry(
        database.db,
        entry({
          kind: 'correction',
          businessRef: 'taskSpec:fixed',
          businessVersion: 'revision:1',
          actorKind: 'member',
          createdBy: ids.userId,
          targetEntryId: target.id,
        }),
      ),
    )
    expect(correctionPg.code).toBe('23514')
    expect(correctionPg.constraintName).toBe('context_entry_correction_fields')

    const pairPg = await catchPgError(
      insertContextEntry(database.db, entry({ businessRef: 'run:abc', businessVersion: null })),
    )
    expect(pairPg.code).toBe('23514')
    expect(pairPg.constraintName).toBe('context_entry_business_pair')
  })

  it('rejects source-only observations at the business idempotency helper', async () => {
    // 03b 之前 projectObservation 只处理业务事实；空 businessRef 不能靠空串回读
    // 掩盖冲突，必须在写入前显式失败。
    await expect(
      insertObservationIfAbsent(database.db, entry({ businessRef: null, businessVersion: null })),
    ).rejects.toThrow('business observations require businessRef and businessVersion')
  })

  it('enforces citation shapes and at least the business half', async () => {
    const decision = await insertDecision()
    await insertContextCitation(database.db, {
      entryId: decision.id,
      kind: 'business',
      businessRef: 'taskSpec:fixed',
      businessVersion: 'revision:1',
      occurredAt: new Date(),
    })
    const pg = await catchPgError(
      insertContextCitation(database.db, {
        entryId: decision.id,
        kind: 'business',
        businessRef: 'taskSpec:fixed',
      }),
    )
    expect(pg.code).toBe('23514')
    expect(pg.constraintName).toBe('context_citation_business_fields')
  })
})
