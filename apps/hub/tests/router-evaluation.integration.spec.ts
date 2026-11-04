/** #519: HTTP 驱动既有工作的模型评估；运行状态只由生产入口/协议帧产生。 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

describe('RD-03r1 restricted Router evaluation', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let projectId: string
  let workKey: string
  let sourceId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: `router-${randomUUID()}` },
    })
    expect(project.statusCode).toBe(201)
    projectId = project.json().data.id as string
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '预算变化', assigneeUserId: alice.userId },
    })
    expect(task.statusCode).toBe(201)
    const taskId = task.json().data.id as string
    expect(
      (await apiInject(ctx, alice, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` }))
        .statusCode,
    ).toBe(200)
    const work = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: '依据已确认预算研究场地' },
    })
    expect(work.statusCode).toBe(201)
    workKey = work.json().data.workKey as string
    const mandate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        allowedActionClasses: ['analysis'],
        allowedSourceTypes: ['task_message'],
        allowedToolNames: ['read'],
        maxTokens: 100000,
        maxCostMicros: 1000000,
      },
    })
    expect(mandate.statusCode).toBe(201)
    const message = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '已确认预算降为八万元，请核对现有方案依据。' },
    })
    expect(message.statusCode).toBe(201)
    sourceId = message.json().data.id as string
  })
  afterEach(async () => {
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('rejects incomplete explicit model configuration instead of enabling defaults', async () => {
    const response = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/router/config`,
      payload: {},
    })
    expect(response.statusCode).toBe(400)
  })

  it('does not evaluate without explicit model, billing and credential configuration', async () => {
    const response = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/router/evaluate`,
      payload: { sourceType: 'task_message', sourceId },
    })
    expect(response.statusCode).toBe(409)
    const rows =
      await database.sql`select count(*)::int as n from coordination_evaluation where purpose = 'router'`
    expect(rows[0]?.n).toBe(0)
  })

  it('exposes an empty owner-only evaluation history before a model is configured', async () => {
    const response = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/router/evaluations`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([])
  })
})
