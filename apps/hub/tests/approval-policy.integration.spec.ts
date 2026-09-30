/**
 * 审批档位解析链与守卫（ADR-0009 决策 7，切片⑧；#241）。全部走真人 HTTP 路径。
 *
 * 判定基线：
 * - 解析链：Revision 默认（建 Revision 时可选，缺省 approval_required）→ Task 覆盖
 *   （nullable，NULL=继承）→ 建 Run 解析固化：`task.approvalPolicy ?? revision.approvalPolicy`
 *   写 `runs.approval_policy`，且 run.start payload 成对携带同值（Node 透传进 initialize）；
 * - 「跟不跟」有唯一答案：未覆盖的 Task 每次建 Run 跟 Revision 新默认；已覆盖的不跟；
 * - 守卫：PATCH approvalPolicy 仅 Task 责任人（403）；enum 外值 400；null 清除回继承；
 * - digest：approvalPolicy 进 canonical JSON（七键口径）——只差档位的两个 Revision
 *   digest 必不同；
 * - 口径（ADR-0010 决策 5）：不做自动触发降级——触发方式不影响档位，不在本 spec 范围。
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
  TEST_DSH_VERSION,
} from './helpers.js'

describe('approval policy resolution chain (ADR-0009 slice 8, #241)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let bobChain: Awaited<ReturnType<typeof seedRunChainForUser>>
  let bobUserId: string
  let projectId: string
  let taskId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterEach(async () => {
    if (ctx !== undefined) await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function seedWorld(): Promise<void> {
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    const bobInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = bobInvite.session
    bobUserId = bob.userId
    const project = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'policy-project' },
    })
    projectId = (project.json() as { data: { id: string } }).data.id
    bobChain = await seedRunChainForUser(database.db, bobUserId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
    const task = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'policy task', assigneeUserId: bobUserId },
      idempotencyKey: idemKey(),
    })
    taskId = (task.json() as { data: { id: string } }).data.id
    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accept.statusCode).toBe(200)
  }

  async function createRun(): Promise<{
    status: number
    data?: { id: string; approvalPolicy: string }
  }> {
    const res = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId: bobChain.agentId,
        deviceId: bobChain.deviceId,
        workspaceId: bobChain.workspaceId,
        prompt: 'go',
      },
      idempotencyKey: idemKey(),
    })
    const json = res.json() as { data: { id: string; approvalPolicy: string } }
    return { status: res.statusCode, data: res.statusCode === 201 ? json.data : undefined }
  }

  async function patchPolicy(
    as: Session,
    approvalPolicy: 'approval_required' | 'full_access' | null,
  ): Promise<number> {
    const res = await apiInject(ctx, as, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { approvalPolicy },
      idempotencyKey: idemKey(),
    })
    return res.statusCode
  }

  /** 建 Revision（Owner/Admin=alice）。返回 { status, revision, digest }。 */
  async function createRevision(
    approvalPolicy?: 'full_access' | 'approval_required',
  ): Promise<{ status: number; revision?: number; digest?: string }> {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/agents/${bobChain.agentId}/revisions`,
      payload: {
        persona: 'test persona',
        provider: 'dsh',
        model: 'test-model',
        credentialSlot: 'api_key',
        pluginPackId: bobChain.pluginPackId,
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      },
      idempotencyKey: idemKey(),
    })
    const json = res.json() as { data: { revision: number; profileDigest: string } }
    return {
      status: res.statusCode,
      revision: res.statusCode === 201 ? json.data.revision : undefined,
      digest: res.statusCode === 201 ? json.data.profileDigest : undefined,
    }
  }

  it('resolution chain: revision default (approval_required) → task override (full_access) → clear (null back to default)', async () => {
    await seedWorld()
    // ① Revision 默认（种链时未指定）= approval_required。
    const first = await createRun()
    expect(first.status).toBe(201)
    expect(first.data?.approvalPolicy).toBe('approval_required')

    // Task 覆盖 full_access（责任人 bob 自己）→ 新 Run 解析为 full_access。
    expect(await patchPolicy(bob, 'full_access')).toBe(200)
    const second = await createRun()
    expect(second.data?.approvalPolicy).toBe('full_access')
    // run.start payload 与 runs 行成对同值（Node 透传的依据）。
    const outboxRow = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(sql`${schema.dispatchOutbox.payload}->>'runId' = ${second.data!.id}`)
      .limit(1)
    expect((outboxRow[0]?.payload as { approvalPolicy?: string }).approvalPolicy).toBe(
      'full_access',
    )

    // ② 覆盖期间 Revision 改默认也不跟：新建 v2=full_access（与覆盖同值无区分度），
    //    改成显式 approval_required 也**不跟**（Task 覆盖优先）。
    const v2 = await createRevision('approval_required')
    expect(v2.status).toBe(201)
    const third = await createRun()
    expect(third.data?.approvalPolicy).toBe('full_access') // 覆盖优先，不跟 v2

    // ③ 清除覆盖（null）→ 回跟 Revision 默认（v2 = approval_required）。
    expect(await patchPolicy(bob, null)).toBe(200)
    const fourth = await createRun()
    expect(fourth.data?.approvalPolicy).toBe('approval_required')
  })

  it('uncovered task follows revision default: v-default required → v2 full_access → new run uses full_access', async () => {
    await seedWorld()
    const v2 = await createRevision('full_access')
    expect(v2.status).toBe(201)
    const run = await createRun()
    expect(run.data?.approvalPolicy).toBe('full_access')
    // 且用的是当前 Revision（v2）。
    const [row] = await database.db
      .select({ revisionId: schema.runs.profileRevisionId })
      .from(schema.runs)
      .where(eq(schema.runs.id, run.data!.id))
    const [v2row] = await database.db
      .select({
        id: schema.agentProfileRevisions.id,
        revision: schema.agentProfileRevisions.revision,
      })
      .from(schema.agentProfileRevisions)
      .where(eq(schema.agentProfileRevisions.agentId, bobChain.agentId))
    expect(v2row?.revision).toBe(2)
    expect(row?.revisionId).toBe(v2row?.id)
  })

  it('guards: PATCH by non-assignee → 403; invalid enum → 400; view carries override state', async () => {
    await seedWorld()
    // alice（owner，但不是该 Task 责任人）改档位 → 403（比 PATCH 其余字段的 Member 权限更严）。
    expect(await patchPolicy(alice, 'full_access')).toBe(403)
    // enum 外值 → 协议 400。
    const bad = await apiInject(ctx, bob, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { approvalPolicy: 'sometimes' },
      idempotencyKey: idemKey(),
    })
    expect(bad.statusCode).toBe(400)

    expect(await patchPolicy(bob, 'full_access')).toBe(200)
    const room = await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    const task = (room.json() as { data: { task: { approvalPolicy: string | null } } }).data.task
    expect(task.approvalPolicy).toBe('full_access')
  })

  it('digest: approvalPolicy enters canonical JSON — two revisions differing only in policy get different digests', async () => {
    await seedWorld()
    // 两个 Revision 除档位外逐字段相同（都走 HTTP 的 createProfileRevision，
    // digest 都由 computeProfileDigest 的七键口径算出）→ digest 必不同。
    const v2 = await createRevision('approval_required')
    const v3 = await createRevision('full_access')
    expect(v2.status).toBe(201)
    expect(v3.status).toBe(201)
    expect(v3.digest).not.toBe(v2.digest)
  })
})
