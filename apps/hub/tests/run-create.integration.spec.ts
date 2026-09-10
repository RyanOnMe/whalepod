import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '@whalepod/domain'
import type { Database } from '@whalepod/db'
import { listRunsByTask, listTeamEvents, schema } from '@whalepod/db'
import { RunCommandError } from '../src/modules/run/index.js'
import {
  createTestDatabase,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
  seedSecondUserDevice,
} from './helpers.js'

// G4-02（幂等重放）与 G4-03（活跃唯一）+ 创建守卫；判据以 04-验收矩阵与测试策略.md 为准。
describe('run create (G4-02/G4-03)', () => {
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

  it('commits Run, team event and dispatch command atomically', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)

    const run = await orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids))

    expect(run.status).toBe('queued')
    expect(run.ownerUserId).toBe(ids.userId)
    expect(run.profileDigest).toBe('b'.repeat(64))
    expect(run.pluginPackDigest).toBe('a'.repeat(64))
    expect(run.dshDistributionVersion).toBe('0.1.0-rc.8')
    const teamEvents = await listTeamEvents(database.db)
    expect(teamEvents.map((event) => event.type)).toContain('run.changed')
    const created = teamEvents.find((event) => event.type === 'run.changed')
    expect(created?.payload).toMatchObject({ runId: run.id, taskId: ids.taskId, status: 'queued' })
    const outboxRows = await database.db.select().from(schema.dispatchOutbox)
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0]).toMatchObject({ deviceId: ids.deviceId, type: 'run.start' })
    expect(outboxRows[0]?.payload).toMatchObject({ runId: run.id, taskId: ids.taskId })
    // 首个 Run 把 Task 从 open 推进到 in_progress（03 §3.1）。
    const [task] = await database.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ids.taskId))
    expect(task?.status).toBe('in_progress')
  })

  it('requires an accepted assignment', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.db
      .update(schema.tasks)
      .set({ assignmentStatus: 'pending', acceptedAt: null })
      .where(eq(schema.tasks.id, ids.taskId))
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_ACCEPTED' })
  })

  it('rejects a workspace owned by another user (FORBIDDEN)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const other = await seedSecondUserDevice(database.db, ids)
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(
        makeActor(ids.userId),
        ids.taskId,
        makeCreateInput(ids, { deviceId: other.deviceId, workspaceId: other.workspaceId }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects an actor who is not the task assignee', async () => {
    const ids = await seedRunPrereqs(database.db)
    const other = await seedSecondUserDevice(database.db, ids)
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(other.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects creating a run on a terminal task (TASK_TERMINAL)', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.db
      .update(schema.tasks)
      .set({ status: 'done', completedAt: new Date() })
      .where(eq(schema.tasks.id, ids.taskId))
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'TASK_TERMINAL' })
  })

  it('rejects an unavailable workspace (WORKSPACE_UNAVAILABLE)', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.db
      .update(schema.workspaces)
      .set({ available: false })
      .where(eq(schema.workspaces.id, ids.workspaceId))
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
  })

  it('rejects a revoked device (DEVICE_REVOKED)', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.db
      .update(schema.devices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.devices.id, ids.deviceId))
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'DEVICE_REVOKED' })
  })

  it('rejects an unknown agent (NOT_FOUND)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(
        makeActor(ids.userId),
        ids.taskId,
        makeCreateInput(ids, { agentId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('G4-02: replaying the same Idempotency-Key returns the same Run without side effects', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)
    const input = makeCreateInput(ids)

    const first = await orchestrator.create(makeActor(ids.userId), ids.taskId, input)
    const replayed = await orchestrator.create(makeActor(ids.userId), ids.taskId, input)

    expect(replayed).toEqual(first)
    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(1)
    expect(await database.db.select().from(schema.dispatchOutbox)).toHaveLength(1)
    expect(await database.db.select().from(schema.commandReceipts)).toHaveLength(1)
  })

  it('G4-02: concurrent replays of the same key commit exactly once', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)
    const input = makeCreateInput(ids)

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        orchestrator.create(makeActor(ids.userId), ids.taskId, input),
      ),
    )

    const runIds = new Set(results.map((run) => run.id))
    expect(runIds.size).toBe(1)
    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(1)
    expect(await database.db.select().from(schema.dispatchOutbox)).toHaveLength(1)
  })

  it('G4-03: a second active Run on the same Task is rejected with RUN_ALREADY_ACTIVE', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)
    await orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids))

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' })
    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(1)
  })

  it('G4-03: concurrent creates with distinct keys leave exactly one active Run (index backstop)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
      ),
    )

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(succeeded).toHaveLength(1)
    for (const result of rejected) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(RunCommandError)
        expect((result.reason as RunCommandError).code).toBe('RUN_ALREADY_ACTIVE')
      }
    }
    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(1)
    expect(await database.db.select().from(schema.dispatchOutbox)).toHaveLength(1)
  })

  it('allows a new Run after the previous one reaches a terminal status', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { orchestrator } = makeHarness(database)
    const first = await orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids))
    await orchestrator.cancel(makeActor(ids.userId), first.id)

    const second = await orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids, { rerunOfRunId: first.id }),
    )
    expect(second.rerunOfRunId).toBe(first.id)
    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(2)
  })

  it('guard failures write nothing: no Run, no Outbox row, no receipt', async () => {
    const ids = await seedRunPrereqs(database.db)
    const other = await seedSecondUserDevice(database.db, ids)
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(other.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(0)
    expect(await database.db.select().from(schema.dispatchOutbox)).toHaveLength(0)
    expect(await database.db.select().from(schema.commandReceipts)).toHaveLength(0)
    expect(await listTeamEvents(database.db)).toHaveLength(0)
  })

  it('guard failures surface DomainError codes unchanged where the domain owns the code', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.db
      .update(schema.tasks)
      .set({ assignmentStatus: 'pending', acceptedAt: null })
      .where(eq(schema.tasks.id, ids.taskId))
    const { orchestrator } = makeHarness(database)

    await expect(
      orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids)),
    ).rejects.toBeInstanceOf(DomainError)
  })
})
