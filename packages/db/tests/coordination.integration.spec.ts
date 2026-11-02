/**
 * ADR-0026（PC-04a）：确定性协调的 DB 不变量。
 *
 * 只测约束；合并/求值语义由 Hub 集成用例覆盖。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, NewCoordinationEvaluationRow } from '../src/index.js'
import { insertContextEntry, insertEvaluation, schema } from '../src/index.js'
import {
  catchPgError,
  createTestDatabase,
  resetDatabase,
  seedRunPrereqs,
  type SeedIds,
} from './helpers.js'

describe('coordination DB invariants', () => {
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

  function queued(
    overrides: Partial<NewCoordinationEvaluationRow> = {},
  ): NewCoordinationEvaluationRow {
    return {
      id: randomUUID(),
      projectId: ids.projectId,
      status: 'queued',
      attempt: 1,
      inputDigest: `a${randomUUID().replaceAll('-', '').slice(0, 63)}`,
      inputManifest: {},
      manifestVersion: 1,
      rulesVersion: 'pc04a.v1',
      processorVersion: 'deterministic.v1',
      queuedAt: new Date(),
      queueExpiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    }
  }

  it('allows at most one queued evaluation per project', async () => {
    await insertEvaluation(database.db, queued())
    const pg = await catchPgError(insertEvaluation(database.db, queued()))
    expect(pg.code).toBe('23505')
    expect(pg.constraintName).toBe('coordination_evaluation_one_queued')
  })

  it('keeps one completed evaluation per input digest and one attempt per input', async () => {
    const completed = queued({
      status: 'completed',
      inputDigest: 'b'.repeat(64),
      finishedAt: new Date(),
      resultDigest: 'c'.repeat(64),
      inferenceEntryId: (
        await insertContextEntry(database.db, {
          id: randomUUID(),
          projectId: ids.projectId,
          kind: 'inference',
          status: 'active',
          title: 'summary',
          body: 'summary',
          payload: {},
          evaluationId: randomUUID(),
          inputDigest: 'd'.repeat(64),
          actorKind: 'coordinator',
          processorVersion: 'deterministic.v1',
        })
      ).id,
    })
    await insertEvaluation(database.db, completed)

    const duplicateCompleted = await catchPgError(
      insertEvaluation(
        database.db,
        queued({
          status: 'completed',
          inputDigest: 'b'.repeat(64),
          attempt: 2,
          finishedAt: new Date(),
          resultDigest: 'c'.repeat(64),
          inferenceEntryId: completed.inferenceEntryId,
        }),
      ),
    )
    expect(duplicateCompleted.code).toBe('23505')
    expect(duplicateCompleted.constraintName).toBe(
      'coordination_evaluation_one_completed_per_input',
    )

    const duplicateAttempt = await catchPgError(
      insertEvaluation(
        database.db,
        queued({
          status: 'skipped',
          inputDigest: 'b'.repeat(64),
          attempt: 1,
          finishedAt: new Date(),
        }),
      ),
    )
    expect(duplicateAttempt.code).toBe('23505')
    expect(duplicateAttempt.constraintName).toBe('coordination_evaluation_input_attempt_unique')
  })

  it('requires terminal and completed field groups', async () => {
    const terminal = await catchPgError(
      insertEvaluation(database.db, queued({ status: 'skipped', finishedAt: null })),
    )
    expect(terminal.code).toBe('23514')
    expect(terminal.constraintName).toBe('coordination_evaluation_terminal_fields')

    const completed = await catchPgError(
      insertEvaluation(
        database.db,
        queued({ status: 'completed', finishedAt: new Date(), resultDigest: null }),
      ),
    )
    expect(completed.code).toBe('23514')
    expect(completed.constraintName).toBe('coordination_evaluation_completed_fields')
  })

  it('allows only one Inference per evaluation id', async () => {
    const evaluationId = randomUUID()
    const base = {
      projectId: ids.projectId,
      kind: 'inference' as const,
      status: 'active' as const,
      title: 'summary',
      body: 'summary',
      payload: {},
      evaluationId,
      inputDigest: 'e'.repeat(64),
      actorKind: 'coordinator' as const,
      processorVersion: 'deterministic.v1',
    }
    await insertContextEntry(database.db, { id: randomUUID(), ...base })
    const pg = await catchPgError(insertContextEntry(database.db, { id: randomUUID(), ...base }))
    expect(pg.code).toBe('23505')
    expect(pg.constraintName).toBe('context_entry_inference_evaluation_unique')
  })
})
