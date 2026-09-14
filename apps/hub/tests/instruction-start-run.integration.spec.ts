import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  insertAgent,
  insertDevice,
  insertTask,
  insertUser,
  listMessages,
  schema,
  setRunStatus,
} from '@whalepod/db'
import { sendInstruction } from '../src/modules/run/instruction.js'
import { resolveRunTarget } from '../src/modules/run/instruction-target.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  idemKey,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
  type TestApp,
} from './helpers.js'

/**
 * P1-196 切片③c-2b：执行区指令**起 Run**（无活跃 Run 时）+ 设备/工作区三段式解析。
 *
 * 两个产品决策在这里落地：
 *   1. 设备/工作区解析：**自动三段式**（上一个 Run → 责任人最近在线设备 → 明确拒绝）+ 可显式覆盖；
 *   2. 指令与 Run **双向锚定**：`runs.trigger_message_id`（migration 0005）指向指令，
 *      指令的 `instruction_state` 由该 Run 的 `run.start` ack 结算（ADR-0009 决策 3）。
 *
 * 同时验「接着说永远成立」的另一半：**有活跃 Run 时不建第二个 Run**，而是降级为追问。
 */
describe('instruction starts a run (P1-196)', () => {
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

  /** 把设备置为「已 hello」（= 在线）：这是 DEVICE_OFFLINE 判据的同一事实（queries.ts）。 */
  async function bringDeviceOnline(deviceId: string) {
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: '9.9.9-test', lastSeenAt: new Date() })
      .where(eq(schema.devices.id, deviceId))
  }

  function makeInstructionDeps(harness: ReturnType<typeof makeHarness>) {
    return {
      database,
      outbox: harness.outbox,
      orchestrator: harness.orchestrator,
      dshDistributionVersionFor: async () => '1.2.3-test',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    }
  }

  it('无活跃 Run + 显式设备/工作区 → 建 Run，且指令与 Run 双向锚定（trigger_message_id ↔ run_id）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringDeviceOnline(ids.deviceId)
    const harness = makeHarness(database)

    const outcome = await sendInstruction(
      makeInstructionDeps(harness),
      makeActor(ids.userId),
      ids.taskId,
      {
        text: '把 macOS 冒烟结果补进 README',
        idempotencyKey: 'i1',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
      },
    )

    expect(outcome.kind).toBe('started_run')
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, outcome.runId))
    expect(run).toMatchObject({
      taskId: ids.taskId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      status: 'queued',
      triggerMessageId: outcome.message.id,
    })
    // prompt 就是指令正文（这是"一次执行 = 这条指令"的语义）。
    const [message] = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.id, outcome.message.id))
    expect(message).toMatchObject({
      kind: 'instruction',
      origin: 'human',
      runId: outcome.runId,
      instructionState: 'pending',
      body: '把 macOS 冒烟结果补进 README',
    })
  })

  it('run.start ack accepted → 指令 accepted（确定性单分支：rejected 由下一条用例覆盖）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringDeviceOnline(ids.deviceId)
    const harness = makeHarness(database)
    const outcome = await sendInstruction(
      makeInstructionDeps(harness),
      makeActor(ids.userId),
      ids.taskId,
      {
        text: '跑一下',
        idempotencyKey: 'i2',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
      },
    )

    // 走真人路径：派发 → Node 回 ack（fake 默认 autoAck=true ⇒ 确定性 accepted）。
    await harness.worker.dispatchOnce()
    const upstream = harness.gateway.drainUpstream()
    // 明确断言 ack 形状：这条用例只验 accepted 分支，不能靠"分支里没走到 rejected"蒙过去
    //（评审应改 6a：原写法是 if/else 双分支，rejected 分支永不执行却写在标题里）。
    expect(
      upstream.some((frame) => frame.type === 'command.ack' && frame.payload.accepted === true),
    ).toBe(true)
    for (const frame of upstream) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    const [accepted] = await listMessages(database.db, ids.taskId)
    expect(accepted).toMatchObject({
      instructionState: 'accepted',
      instructionErrorCode: null,
      runId: outcome.runId,
    })
  })

  it('设备拒绝 run.start（离线）→ 指令被写成 rejected + 错误码（不是静默停在 pending）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringDeviceOnline(ids.deviceId)
    // gateway 拒绝所有命令，复刻「Node 收到 start 但拒收」的形态（③c-1 加的注入缝）。
    const harness = makeHarness(database, {
      refuseCommand: () => ({ code: 'DEVICE_OFFLINE', message: 'node is offline' }),
    })
    const outcome = await sendInstruction(
      makeInstructionDeps(harness),
      makeActor(ids.userId),
      ids.taskId,
      {
        text: '离线时发的指令',
        idempotencyKey: 'i3',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
      },
    )
    expect(outcome.kind).toBe('started_run')

    await harness.worker.dispatchOnce()
    for (const frame of harness.gateway.drainUpstream()) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    const [message] = await listMessages(database.db, ids.taskId)
    expect(message).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'DEVICE_OFFLINE',
      instructionErrorMessage: 'node is offline',
    })
    // Run 本身也进 failed（既有语义）。
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, outcome.runId))
    expect(run?.status).toBe('failed')
  })

  it('有活跃 Run → **不建新 Run**，降级为追问（活跃唯一约束不该被这条路径撞到）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const existing = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.outbox.claim()
    await setRunStatus(database.db, existing.id, 'running')
    // 让既有消息清空干扰：只看这次指令的结果。
    const before = (await listMessages(database.db, ids.taskId)).length

    const outcome = await sendInstruction(
      makeInstructionDeps(harness),
      makeActor(ids.userId),
      ids.taskId,
      {
        text: '接着说',
        idempotencyKey: 'i4',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
      },
    )

    expect(outcome.kind).toBe('followup')
    expect(outcome.runId).toBe(existing.id) // 落在**既有的** Run 上，没有第二个 Run
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, ids.taskId))
    expect(runs).toHaveLength(1)
    const messages = await listMessages(database.db, ids.taskId)
    expect(messages.length).toBe(before + 1)
    expect(messages.at(-1)).toMatchObject({ kind: 'followup', runId: existing.id })
  })

  it('没有上一轮 Run 可继承 Agent 时**不猜**：要求显式传 agentId（说清怎么修）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringDeviceOnline(ids.deviceId)
    const harness = makeHarness(database)
    await expect(
      sendInstruction(makeInstructionDeps(harness), makeActor(ids.userId), ids.taskId, {
        text: '还没跑过这个任务',
        idempotencyKey: 'i-agent',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
      }),
    ).rejects.toThrow(/pass agentId explicitly/)
    // 而且**没建 Run、没落指令**（失败不留半成品）。
    expect(await database.db.select().from(schema.runs)).toEqual([])
    expect(await listMessages(database.db, ids.taskId)).toEqual([])
  })

  it('三段式①：指令没显式指定设备时，沿用**上一个 Run** 的设备/工作区', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringDeviceOnline(ids.deviceId)
    const harness = makeHarness(database)
    // 先有一轮（用同一副设备/工作区），并推到终态，好让"活跃 Run"这条分支不生效。
    const prior = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.outbox.claim()
    await setRunStatus(database.db, prior.id, 'completed', { finishedAt: new Date() })

    const resolved = await resolveRunTarget(database.db, {
      taskId: ids.taskId,
      assigneeUserId: ids.userId,
    })
    expect(resolved).toEqual({
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      source: 'last_run',
    })
  })

  it('三段式②：没有上一个 Run 时，用责任人**最近在线的设备** + 它的可用工作区', async () => {
    const ids = await seedRunPrereqs(database.db)
    // `seedRunPrereqs` 造的设备默认**未 hello**（`dshDistributionVersion` 为 null），
    // 所以先显式置为在线——这正是三段式②要的「最近在线的设备」前提。
    await bringDeviceOnline(ids.deviceId)

    const resolved = await resolveRunTarget(database.db, {
      taskId: ids.taskId,
      assigneeUserId: ids.userId,
    })
    expect(resolved).toEqual({
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      source: 'assignee_device',
    })
  })

  it('三段式③：没有任何可用目标 → 返回 undefined（路由据此 409），且**不落指令、不建 Run**', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    // 把唯一设备置为未 hello（= 不在线），并撤销工作区可用性。
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: null })
      .where(eq(schema.devices.id, ids.deviceId))
    await database.db
      .update(schema.workspaces)
      .set({ available: false })
      .where(eq(schema.workspaces.id, ids.workspaceId))

    const resolved = await resolveRunTarget(database.db, {
      taskId: ids.taskId,
      assigneeUserId: ids.userId,
    })
    expect(resolved).toBeUndefined()

    await expect(
      sendInstruction(makeInstructionDeps(harness), makeActor(ids.userId), ids.taskId, {
        text: '没有设备也要发',
        idempotencyKey: 'i5',
      }),
    ).rejects.toThrow(/DEVICE_OFFLINE|no runnable device/)

    expect(await database.db.select().from(schema.runs)).toEqual([])
    expect(await listMessages(database.db, ids.taskId)).toEqual([])
  })

  it('显式覆盖要过校验：设备不属于责任人 → FORBIDDEN；工作区不可用 → VALIDATION_FAILED；已撤销 → DEVICE_OFFLINE', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringDeviceOnline(ids.deviceId)
    // 另一个责任人 + 他的设备（`seedRunPrereqs` 每用例只能调一次：team 是单例）。
    const strangerId = randomUUID()
    await insertUser(database.db, {
      id: strangerId,
      username: `stranger-${strangerId.slice(0, 8)}`,
      displayName: '别人',
      passwordHash: 'x',
    })
    const strangerDevice = await insertDevice(database.db, {
      id: randomUUID(),
      ownerUserId: strangerId,
      name: 'stranger-device',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.0.0',
      nodeAppVersion: '0.1.0',
      tokenHash: new Uint8Array([1, 2, 3]),
      capabilities: {},
    })

    await expect(
      resolveRunTarget(database.db, {
        taskId: ids.taskId,
        assigneeUserId: ids.userId,
        deviceId: strangerDevice.id, // 别人的设备
      }),
    ).rejects.toThrow(/does not belong/)

    await database.db
      .update(schema.workspaces)
      .set({ available: false })
      .where(eq(schema.workspaces.id, ids.workspaceId))
    await expect(
      resolveRunTarget(database.db, {
        taskId: ids.taskId,
        assigneeUserId: ids.userId,
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
      }),
    ).rejects.toThrow(/not available/)

    await database.db
      .update(schema.devices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.devices.id, ids.deviceId))
    await expect(
      resolveRunTarget(database.db, {
        taskId: ids.taskId,
        assigneeUserId: ids.userId,
        deviceId: ids.deviceId,
      }),
    ).rejects.toThrow(/revoked/)
  })

  it('migration 0005 的库级约束：触发消息必须与 Run 同 Task（跨 Task 锚点是坏账）', async () => {
    const ids = await seedRunPrereqs(database.db)
    // 同一个 project 里建第二个 Task，用它的一条指令当"外键"。
    const otherTask = await insertTask(database.db, {
      id: randomUUID(),
      projectId: ids.projectId,
      title: '另一个任务',
      assigneeUserId: ids.userId,
      createdBy: ids.userId,
    })
    const [foreign] = await database.db
      .insert(schema.taskMessages)
      .values({
        id: randomUUID(),
        taskId: otherTask.id,
        authorUserId: ids.userId,
        body: '别的任务的指令',
        kind: 'instruction',
        origin: 'human',
        targetAgentId: ids.agentId,
        instructionState: 'pending',
      })
      .returning()
    if (foreign === undefined) throw new Error('insert failed')

    // drizzle 会把 Postgres 错误包一层（`Failed query: insert into "run" …`），
    // 所以断言走 cause 链原文，而不是只看外层消息（外层恰好也含 trigger_message_id 字样，
    // 直接匹配会变成假绿）。
    const error = await database.db
      .insert(schema.runs)
      .values({
        id: randomUUID(),
        taskId: ids.taskId,
        ownerUserId: ids.userId,
        agentId: ids.agentId,
        profileRevisionId: randomUUID(),
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        prompt: 'x',
        profileDigest: 'a'.repeat(64),
        pluginPackDigest: 'b'.repeat(64),
        dshDistributionVersion: '1.0.0',
        triggerMessageId: foreign.id,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      )
    expect(error).toBeDefined()
    const chain: string[] = []
    let cursor: unknown = error
    while (cursor instanceof Error) {
      chain.push(cursor.message)
      cursor = cursor.cause
    }
    expect(chain.join('\n')).toMatch(/must reference a message of the same task/)
    // 行为面：坏账没有被写进去。
    const rows = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.triggerMessageId, foreign.id))
    expect(rows).toEqual([])
  })
})

describe('执行区指令的 HTTP 面（P1-196：路由 201 / 400 / 409）', () => {
  let database: Database
  let ctx: TestApp
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    // app **每个用例新建**：`resetDatabase` 会 truncate 全部表（含 setup token 表），
    // 一次 reset 之后旧 ctx 的 setupToken 就失效了（"invalid setup token" 的由来）。
    ctx = await createTestApp(database)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  /** 经 HTTP 建好 project/task，并把该 Task 的责任人设备置为在线、任务指派接受。 */
  async function seedViaHttp() {
    const alice = await driveSetup(ctx)
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'P' },
    })
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${project.json().data.id}/tasks`,
      payload: { title: 'T', assigneeUserId: alice.userId },
    })
    const taskId = task.json().data.id as string
    // 接受指派（建 Run 的前置之一）。
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
      idempotencyKey: idemKey(),
    })
    // 设备/工作区/Agent 直接种（HTTP 侧没有建它们的最小面）。
    // **不能**用 `seedRunPrereqs`：它会再建一个 Team，而 team 是单例（`team_singleton`），
    // 而 `driveSetup` 已经建过 Team 了——本用例第一版即此错。
    const agent = await insertAgent(database.db, {
      id: randomUUID(),
      name: 'agent-http',
      createdBy: alice.userId,
    })
    // Agent 必须有 Profile Revision 才能建 Run（`orchestrator.create` 会拒绝
    // 「agent has no profile revision」——本用例第一版即此错）。
    const revisionId = randomUUID()
    // Profile Revision 需要真实的 plugin_pack 行（FK）——`seedRunPrereqs` 也是这么种的。
    const pluginPackId = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id: pluginPackId,
      name: `pack-http-${pluginPackId.slice(0, 8)}`,
      installations: [],
      packDigest: 'a'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db.insert(schema.agentProfileRevisions).values({
      id: revisionId,
      agentId: agent.id,
      revision: 1,
      persona: 'You are a helpful agent.',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      credentialSlot: 'default',
      pluginPackId,
      profileDigest: 'b'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db
      .update(schema.agents)
      .set({ currentRevisionId: revisionId })
      .where(eq(schema.agents.id, agent.id))
    const device = await insertDevice(database.db, {
      id: randomUUID(),
      ownerUserId: alice.userId,
      name: 'device-http',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: new Uint8Array([7, 7, 7]),
      capabilities: {},
    })
    // 在线 = 已 node.hello（与 queries.ts 的 DEVICE_OFFLINE 判据同一事实）。
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: '9.9.9-test', lastSeenAt: new Date() })
      .where(eq(schema.devices.id, device.id))
    const workspaceId = randomUUID()
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId: device.id,
      ownerUserId: alice.userId,
      name: 'ws-http',
      kind: 'directory',
      capabilities: { read: true, write: true },
      available: true,
    })
    const ids = { deviceId: device.id, workspaceId, agentId: agent.id }
    return { alice, taskId, ids }
  }

  it('显式设备/工作区 → 201，outcome=started_run，且指令与 Run 都落库', async () => {
    const { alice, taskId, ids } = await seedViaHttp()
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instructions`,
      payload: {
        text: '跑一趟',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
      },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
    const data = res.json().data as {
      id: string
      outcome: string
      runId: string
      instructionState: string
    }
    expect(data.outcome).toBe('started_run')
    expect(data.instructionState).toBe('pending') // 受理与否由 run.start ack 决定
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, data.runId))
    expect(run?.triggerMessageId).toBe(data.id ?? run?.triggerMessageId)
    expect(run?.status).toBe('queued')
  })

  it('body 非法 → **400**（不是 500：③b 的 `.parse()` 教训）', async () => {
    const { alice, taskId } = await seedViaHttp()
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instructions`,
      payload: { text: '' },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('没有可用执行目标 → **409 DEVICE_OFFLINE**，且不建 Run、不落指令', async () => {
    const { alice, taskId, ids } = await seedViaHttp()
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: null })
      .where(eq(schema.devices.id, ids.deviceId))
    await database.db
      .update(schema.workspaces)
      .set({ available: false })
      .where(eq(schema.workspaces.id, ids.workspaceId))

    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instructions`,
      payload: { text: '没设备也要发', agentId: ids.agentId },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('DEVICE_OFFLINE')
    expect(await database.db.select().from(schema.runs)).toEqual([])
    expect(await listMessages(database.db, taskId)).toEqual([])
  })
})

describe('P1-196 评审整改的回归判据', () => {
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

  async function bringOnline(deviceId: string) {
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: '9.9.9-test', lastSeenAt: new Date() })
      .where(eq(schema.devices.id, deviceId))
  }

  function deps(harness: ReturnType<typeof makeHarness>) {
    return {
      database,
      outbox: harness.outbox,
      orchestrator: harness.orchestrator,
      dshDistributionVersionFor: async () => '1.2.3-test',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    }
  }

  it('幂等重放（评审 B1）：同 idempotencyKey 再发一次**不写第二条指令**、不覆盖锚点', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const harness = makeHarness(database)
    const input = {
      text: '同一句话发两次',
      idempotencyKey: 'same-key',
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
    }

    const first = await sendInstruction(deps(harness), makeActor(ids.userId), ids.taskId, input)
    const second = await sendInstruction(deps(harness), makeActor(ids.userId), ids.taskId, input)

    // 同 key → 同一条消息、同一个 Run（幂等），而不是插出第二条把锚点覆盖掉。
    expect(second.message.id).toBe(first.message.id)
    expect(second.runId).toBe(first.runId)
    const messages = await listMessages(database.db, ids.taskId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe('instruction')
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, first.runId))
    expect(run?.triggerMessageId).toBe(first.message.id)
  })

  it('只给 workspaceId（评审 B2）：设备由 workspace.device_id 确定性推导，不再静默丢弃', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)

    const resolved = await resolveRunTarget(database.db, {
      taskId: ids.taskId,
      assigneeUserId: ids.userId,
      workspaceId: ids.workspaceId,
    })
    expect(resolved).toEqual({
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      source: 'explicit',
    })

    // 不存在的 workspaceId → 明确的 VALIDATION_FAILED（而不是 409「把设备弄上线」这种误导）。
    await expect(
      resolveRunTarget(database.db, {
        taskId: ids.taskId,
        assigneeUserId: ids.userId,
        workspaceId: randomUUID(),
      }),
    ).rejects.toThrow(/does not exist/)
  })

  it('并发两条指令（评审应改 1）：不硬失败，**降级为追问**（ADR 语义：有活跃 Run 就接着说）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const harness = makeHarness(database)

    const [a, b] = await Promise.all([
      sendInstruction(deps(harness), makeActor(ids.userId), ids.taskId, {
        text: '并发第一条',
        idempotencyKey: 'race-a',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
      }),
      sendInstruction(deps(harness), makeActor(ids.userId), ids.taskId, {
        text: '并发第二条',
        idempotencyKey: 'race-b',
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
      }),
    ])

    // 两条都成功：一条起 Run，另一条降级为**追问**（不再向用户抛 RUN_ALREADY_ACTIVE）。
    // 第二条的 kind 是 `queued` 而不是 `followup`：它落在刚建出来、还处于 `queued` 的 Run 上，
    // 按 ③c-1 的语义"未 running 只排队"——这正是 ADR-0009 决策 5 要的行为。
    expect([a.kind, b.kind].sort()).toEqual(['queued', 'started_run'])
    expect(a.runId).toBe(b.runId) // 落在同一个 Run 上
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, ids.taskId))
    expect(runs).toHaveLength(1)
    const messages = await listMessages(database.db, ids.taskId)
    expect(messages.map((message) => message.kind).sort()).toEqual(['followup', 'instruction'])
  })

  it('触发指令不会被二次当 followup 下发（评审观察 2）：Run 进 running 时只放行**追问**', async () => {
    const ids = await seedRunPrereqs(database.db)
    await bringOnline(ids.deviceId)
    const harness = makeHarness(database)
    const outcome = await sendInstruction(deps(harness), makeActor(ids.userId), ids.taskId, {
      text: '只有这一条指令',
      idempotencyKey: 'single',
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
    })

    // 派发 + ack（accepted）→ Run 进 dispatching；再喂 runtime.ready → running（补发器会跑）。
    await harness.worker.dispatchOnce()
    for (const frame of harness.gateway.drainUpstream()) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(outcome.runId, 1, { type: 'runtime.ready', dshSessionId: 'dsh-single' }),
    )

    // 触发指令的 run_id 从出生就非空，但它的命运由 run.start ack 定的（accepted）；
    // 补发器取的是 `instruction_state='pending'` 的消息，所以它不该被再下发一次。
    const followups = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(followups).toEqual([])
    const [message] = await listMessages(database.db, ids.taskId)
    expect(message?.instructionState).toBe('accepted')
  })
})
