/**
 * ADR-0027 §6（PC-05b-3）：resume 血缘的 blocked 传播。
 *
 * 共享 home 被非空上下文 Run 的终态清理删除时，同一血缘（根来源 + 全部 resume
 * 后代）的 session 都不再存在。只把当前 Run 标 blocked 会让来源仍显示 full 并被
 * 放行，随后 Node 无会话可装载。本用例直接驱动生产 `setRunStatus` 收敛点。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/index.js'
import { getRun, insertRun, setRunStatus } from '../src/index.js'
import { runProjectContexts } from '../src/schema/index.js'
import { createTestDatabase, resetDatabase, seedRunPrereqs, type SeedIds } from './helpers.js'

describe('resumeContext lineage', () => {
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

  function runInput(overrides: {
    id?: string
    status?: 'queued' | 'running' | 'completed'
    dshSessionId?: string | null
    resumeFromRunId?: string
  }) {
    const session = overrides.dshSessionId === undefined ? 'session' : overrides.dshSessionId
    return {
      id: overrides.id ?? randomUUID(),
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      profileDigest: 'b'.repeat(64),
      pluginPackDigest: 'a'.repeat(64),
      dshDistributionVersion: '0.1.0-rc.8',
      status: overrides.status ?? 'running',
      ...(session === null ? {} : { dshSessionId: session }),
      ...(overrides.resumeFromRunId !== undefined
        ? { resumeFromRunId: overrides.resumeFromRunId }
        : {}),
      createdAt: new Date(),
    }
  }

  async function contextRow(runId: string, entryCount: number): Promise<void> {
    await database.db.insert(runProjectContexts).values({
      id: randomUUID(),
      runId,
      projectId: ids.projectId,
      selectionRuleVersion: 'test',
      snapshotDigest: 'c'.repeat(64),
      headerText: '[project-context:0123456789abcdef]',
      headerDigest: 'd'.repeat(64),
      entryCount,
      totalBytes: 0,
    })
  }

  it('非空上下文 resume Run 终态 blocked → 根来源与同 home 的兄弟 Run 一并 blocked', async () => {
    const rootId = randomUUID()
    await insertRun(database.db, runInput({ id: rootId, status: 'completed' }))
    const siblingId = randomUUID()
    await insertRun(
      database.db,
      runInput({ id: siblingId, status: 'completed', resumeFromRunId: rootId }),
    )
    const childId = randomUUID()
    await insertRun(
      database.db,
      runInput({ id: childId, status: 'running', resumeFromRunId: rootId }),
    )
    await contextRow(childId, 1)

    await setRunStatus(database.db, childId, 'completed', { finishedAt: new Date() })

    expect((await getRun(database.db, childId))?.resumeContext).toBe('blocked')
    expect((await getRun(database.db, rootId))?.resumeContext).toBe('blocked')
    expect((await getRun(database.db, siblingId))?.resumeContext).toBe('blocked')
  })

  it('spawn 前失败（没有会话）的 blocked Run 不传播：来源仍 full', async () => {
    const rootId = randomUUID()
    await insertRun(database.db, runInput({ id: rootId, status: 'completed' }))
    const childId = randomUUID()
    await insertRun(
      database.db,
      runInput({
        id: childId,
        status: 'queued',
        dshSessionId: null,
        resumeFromRunId: rootId,
      }),
    )
    await contextRow(childId, 1)

    await setRunStatus(database.db, childId, 'failed', { finishedAt: new Date() })

    expect((await getRun(database.db, childId))?.resumeContext).toBe('blocked')
    expect((await getRun(database.db, rootId))?.resumeContext).toBe('full')
  })

  it('lost 且 Hub 尚无 session id：非空上下文仍按 fail-safe 传播血缘', async () => {
    const rootId = randomUUID()
    await insertRun(database.db, runInput({ id: rootId, status: 'completed' }))
    const childId = randomUUID()
    await insertRun(
      database.db,
      runInput({
        id: childId,
        status: 'running',
        dshSessionId: null,
        resumeFromRunId: rootId,
      }),
    )
    await contextRow(childId, 1)

    await setRunStatus(database.db, childId, 'lost', { finishedAt: new Date() })

    expect((await getRun(database.db, childId))?.resumeContext).toBe('blocked')
    expect((await getRun(database.db, rootId))?.resumeContext).toBe('blocked')
  })

  it('空快照 Run 终态保持 full，不做血缘传播', async () => {
    const rootId = randomUUID()
    await insertRun(database.db, runInput({ id: rootId, status: 'completed' }))
    const childId = randomUUID()
    await insertRun(
      database.db,
      runInput({ id: childId, status: 'running', resumeFromRunId: rootId }),
    )
    await contextRow(childId, 0)

    await setRunStatus(database.db, childId, 'completed', { finishedAt: new Date() })

    expect((await getRun(database.db, childId))?.resumeContext).toBe('full')
    expect((await getRun(database.db, rootId))?.resumeContext).toBe('full')
  })
})
