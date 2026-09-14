import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  insertAgent,
  insertDevice,
  insertProject,
  insertProfileRevision,
  insertRun,
  insertTask,
  getTeam,
  setRunStatus,
  schema,
} from '@whalepod/db'
import { createTestApp, createTestDatabase, driveSetup, idemKey, resetDatabase } from './helpers.js'
import type { Session, TestApp } from './helpers.js'

/**
 * `POST /runs/:runId/followup` 的 HTTP 契约（#187 评审：路由层必须有冒烟）。
 *
 * 命令层的语义由 followup.integration.spec 覆盖；这里专验**路由这一层**的事：
 * body 校验失败必须是 400 VALIDATION_FAILED（不是 500——`.parse()` 抛 ZodError 会被本
 * 函数的 catch 误映射成 INTERNAL_ERROR，这正是评审抓到的阻断 1），以及「被 Hub 拒仍回
 * 201 + 一条 rejected 消息」这个契约选择在 HTTP 面上真的成立。
 */
describe('POST /runs/:runId/followup 路由契约（P1-186）', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let runId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx)

    // 直接按真实外键关系铺一个「责任人是 alice、状态 running」的 Run：
    // 路由要验的是 HTTP 面，device/workspace 不必真配对（配对链另有 spec 覆盖）。
    const team = await getTeam(database.db)
    if (team === undefined) throw new Error('setup 未建 Team')
    const projectId = randomUUID()
    const taskId = randomUUID()
    const agentId = randomUUID()
    const revisionId = randomUUID()
    const deviceId = randomUUID()
    const workspaceId = randomUUID()
    await insertProject(database.db, { id: projectId, name: 'p', createdBy: alice.userId })
    await insertTask(database.db, {
      id: taskId,
      projectId,
      title: 't',
      assigneeUserId: alice.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: alice.userId,
    })
    await insertAgent(database.db, {
      id: agentId,
      name: `agent-${agentId.slice(0, 8)}`,
      createdBy: alice.userId,
    })
    await insertProfileRevision(database.db, {
      id: revisionId,
      agentId,
      revision: 1,
      persona: 'You are a helpful agent.',
      provider: 'deepseek',
      model: 'deepseek-chat',
      credentialSlot: 'default',
      pluginPackId: await seedPluginPack(database, alice.userId),
      profileDigest: 'b'.repeat(64),
      createdBy: alice.userId,
    })
    await insertDevice(database.db, {
      id: deviceId,
      ownerUserId: alice.userId,
      name: 'd',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: Buffer.from(randomUUID()),
      capabilities: {},
    })
    // workspace 没有仓储函数（仓库里只有 schema 直插的先例，见 packages/db/tests/helpers.ts）。
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId,
      ownerUserId: alice.userId,
      name: 'w',
      kind: 'directory',
      capabilities: { read: true, write: true },
      available: true,
    })
    const run = await insertRun(database.db, {
      id: randomUUID(),
      taskId,
      ownerUserId: alice.userId,
      agentId,
      profileRevisionId: revisionId,
      deviceId,
      workspaceId,
      profileDigest: 'b'.repeat(64),
      pluginPackDigest: 'a'.repeat(64),
      dshDistributionVersion: '0.1.0-rc.6',
    })
    await setRunStatus(database.db, run.id, 'running')
    runId = run.id
    void team
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function seedPluginPack(database: Database, userId: string): Promise<string> {
    const id = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id,
      name: `pack-${id.slice(0, 8)}`,
      installations: [],
      packDigest: 'a'.repeat(64),
      createdBy: userId,
    })
    return id
  }

  async function post(payload: unknown, idempotencyKey?: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/followup`,
      headers: {
        origin: ctx.origin,
        cookie: alice.cookie,
        ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
      },
      payload: payload as object,
    })
  }

  it('缺 Idempotency-Key → 400 VALIDATION_FAILED', async () => {
    const res = await post({ text: 'hi' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('空文本 → 400 VALIDATION_FAILED（**不是 500**：阻断 1 的回归判据）', async () => {
    const res = await post({ text: '' }, idemKey())
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('超长文本（>20000）→ 400 VALIDATION_FAILED（**不是 500**）', async () => {
    const res = await post({ text: 'x'.repeat(20_001) }, idemKey())
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('未知 Run → 404 NOT_FOUND', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/runs/${randomUUID()}/followup`,
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: { text: 'hi' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  it('running 受理 → 201 + pending 消息（HTTP 面确认契约）', async () => {
    const res = await post({ text: '继续把 macOS 冒烟补上' }, idemKey())
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toMatchObject({
      kind: 'followup',
      instructionState: 'pending',
      runId,
    })
  })

  it('被 Hub 拒仍回 201（带 rejected 消息）——「被拒」是消息的命运，不是请求的失败', async () => {
    await setRunStatus(database.db, runId, 'completed')
    const res = await post({ text: '已经结束了' }, idemKey())
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'RUN_TERMINAL',
    })
  })
})
