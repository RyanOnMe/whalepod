import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/index.js'
import {
  appendRunEvent,
  insertApproval,
  insertArtifact,
  insertRun,
  insertTeam,
  insertUser,
  listRunEvents,
  setRunStatus,
} from '../src/index.js'
import { agentProfileRevisions, runEvents } from '../src/schema/index.js'
import {
  catchPgError,
  createTestDatabase,
  makeApprovalInput,
  makeArtifactInput,
  makeRunEventInput,
  makeRunInput,
  resetDatabase,
  seedRunPrereqs,
} from './helpers.js'

// 02-第一阶段实施计划.md Task 4 Step 1/3：数据库层硬约束的机器证据。
// 23505 = unique_violation，23514 = check_violation（drizzle 包装的 PG 错误经 catchPgError 解出）。
describe('database constraints', () => {
  let database: Database
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  it('permits only one Team row', async () => {
    await insertTeam(database.db, { id: randomUUID(), name: 'One' })
    const error = await catchPgError(insertTeam(database.db, { id: randomUUID(), name: 'Two' }))
    expect(error).toMatchObject({ code: '23505', constraintName: 'team_singleton' })
  })

  it('rejects usernames outside the §2.1 regex', async () => {
    const error = await catchPgError(
      insertUser(database.db, {
        id: randomUUID(),
        username: 'Bad Name',
        displayName: 'Bad',
        passwordHash: '$argon2id$placeholder$placeholder',
      }),
    )
    expect(error).toMatchObject({ code: '23514', constraintName: 'user_account_username_format' })
  })

  it('deduplicates Run events by runId and seq', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    const event = makeRunEventInput(run.id, 1)
    expect((await appendRunEvent(database.db, event)).appended).toBe(true)
    expect((await appendRunEvent(database.db, { ...event, id: randomUUID() })).appended).toBe(false)
    expect(await listRunEvents(database.db, run.id)).toHaveLength(1)
  })

  it('enforces (run_id, seq) uniqueness at the database level', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    await database.db.insert(runEvents).values(makeRunEventInput(run.id, 7))
    const error = await catchPgError(
      database.db.insert(runEvents).values(makeRunEventInput(run.id, 7)),
    )
    expect(error).toMatchObject({ code: '23505', constraintName: 'run_event_run_seq_unique' })
  })

  it('enforces (run_id, call_id) uniqueness for approvals', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    await insertApproval(database.db, makeApprovalInput(run.id, 'call-1'))
    const error = await catchPgError(
      insertApproval(database.db, makeApprovalInput(run.id, 'call-1')),
    )
    expect(error).toMatchObject({ code: '23505', constraintName: 'approval_run_call_unique' })
  })

  it('rejects artifacts above the 50 MiB limit', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    await insertArtifact(database.db, { ...makeArtifactInput(ids, run.id), byteSize: 52_428_800 })
    const error = await catchPgError(
      insertArtifact(database.db, { ...makeArtifactInput(ids, run.id), byteSize: 52_428_801 }),
    )
    expect(error).toMatchObject({ code: '23514', constraintName: 'artifact_byte_size_range' })
  })

  it('enforces Profile revision uniqueness per Agent', async () => {
    const ids = await seedRunPrereqs(database.db)
    const error = await catchPgError(
      database.db.insert(agentProfileRevisions).values({
        id: randomUUID(),
        agentId: ids.agentId,
        revision: 1,
        persona: 'duplicate revision',
        provider: 'deepseek',
        model: 'deepseek-chat',
        credentialSlot: 'default',
        pluginPackId: ids.pluginPackId,
        profileDigest: 'd'.repeat(64),
        createdBy: ids.userId,
      }),
    )
    expect(error).toMatchObject({ code: '23505', constraintName: 'agent_profile_revision_unique' })
  })

  it('permits only one active Run per Task', async () => {
    const ids = await seedRunPrereqs(database.db)
    const first = await insertRun(database.db, makeRunInput(ids))
    const error = await catchPgError(insertRun(database.db, makeRunInput(ids)))
    expect(error).toMatchObject({ code: '23505', constraintName: 'run_one_active_per_task' })
    // 终态不占位：第一个 Run 结束后允许同 Task 新 Run（重跑链路）。
    await setRunStatus(database.db, first.id, 'completed', { finishedAt: new Date() })
    await insertRun(database.db, makeRunInput(ids))
  })

  it('rejects persistent Run Event payloads above 32 KiB', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    const oversized = { blob: 'x'.repeat(64 * 1024) }
    const error = await catchPgError(
      appendRunEvent(database.db, makeRunEventInput(run.id, 1, oversized)),
    )
    expect(error).toMatchObject({ code: '23514', constraintName: 'run_event_payload_size' })
    const within = { blob: 'x'.repeat(1024) }
    expect((await appendRunEvent(database.db, makeRunEventInput(run.id, 2, within))).appended).toBe(
      true,
    )
  })
})
