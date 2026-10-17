import type { ArtifactInputManifest } from '@whalepod/protocol'
/**
 * Hub integration spec 的统一入口与驱动助手（#183 拆耦合后成了**聚合层**）。
 *
 * 两类驱动共存：
 * - HTTP 路径（P1-05 setup/auth/invite）：全部走 Fastify inject（真人同一条 HTTP 路径）；
 *   DB 断言走 raw SQL。
 * - Run Orchestrator 路径（P1-10）：直驱 RunOrchestrator + OutboxWorker + FakeDeviceGateway，
 *   不经过 HTTP（routes 留给组合根接线，P1-13）。
 *
 * 脚手架的三处归属（#183：不许再让别的应用 relative-import 本文件）：
 * - 与 hub app 无关的 DB/polling 助手 → `@whalepod/testkit`（`createTestDatabase`/
 *   `resetDatabase`/`waitForValue`），本文件 re-export；
 * - 起真 Hub 应用与 HTTP 驱动的助手 → `apps/hub/src/testing`（`@whalepod/hub/testing`
 *   子路径导出），本文件 re-export；
 * - 需要 hub 深模块 + testkit 的本地 harness（`makeHarness`/`seedRunPrereqs`/帧构造）
 *   留在本文件——它们只服务 hub 自己的 integration spec。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Actor } from '@whalepod/domain'
import { asUserId } from '@whalepod/domain'
import {
  insertMember,
  insertProject,
  insertTask,
  insertTeam,
  insertUser,
  Outbox,
  schema,
} from '@whalepod/db'
import type { Database, DbHandle } from '@whalepod/db'
import type { FakeDeviceGatewayOptions } from '@whalepod/testkit'
import { FakeClock, FakeDeviceGateway } from '@whalepod/testkit'
import type { CreateRunInput, RunOrchestrator } from '../src/modules/run/index.js'
import { RunOrchestrator as Orchestrator } from '../src/modules/run/index.js'
import { OutboxWorker } from '../src/modules/run/index.js'

// #183：脚手架已按归属拆走（testkit / hub 的 src/testing），这里只做聚合 re-export，
// 既有 spec 的 `from './helpers.js'` 导入面不变。
export * from '../src/testing/index.js'
export { createTestDatabase, resetDatabase, waitForValue } from '@whalepod/testkit'

// ---------------------------------------------------------------------------
// Run Orchestrator 驱动助手（P1-10）：直驱深模块，不经过 HTTP。
// 与 packages/db/tests/helpers.ts 同源约定：seedRunPrereqs 本地实现，只用 @whalepod/db
// 的公开导出（insertTeam/insertUser/insertMember/insertProject/insertTask + schema），
// 不跨包引用测试内部文件。
// ---------------------------------------------------------------------------

/** 与仓库 DSH 基线一致（dsh.lock.json；07-资料与版本基线.md）。 */
export const TEST_DSH_VERSION = '0.1.0-rc.8'

export interface SeedIds {
  teamId: string
  userId: string
  projectId: string
  taskId: string
  pluginPackId: string
  agentId: string
  revisionId: string
  deviceId: string
  workspaceId: string
}

/** 插齐 Run 的 FK 依赖链（team→user→project→task、pack→agent→revision、device→workspace）。 */
export async function seedRunPrereqs(handle: DbHandle): Promise<SeedIds> {
  const suffix = randomUUID().slice(0, 8)
  const ids: SeedIds = {
    teamId: randomUUID(),
    userId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    pluginPackId: randomUUID(),
    agentId: randomUUID(),
    revisionId: randomUUID(),
    deviceId: randomUUID(),
    workspaceId: randomUUID(),
  }
  await insertTeam(handle, { id: ids.teamId, name: `team-${suffix}` })
  await insertUser(handle, {
    id: ids.userId,
    username: `user-${suffix}`,
    displayName: 'Seed User',
    passwordHash: '$argon2id$placeholder$placeholder',
  })
  await insertMember(handle, { teamId: ids.teamId, userId: ids.userId, role: 'owner' })
  await insertProject(handle, { id: ids.projectId, name: `proj-${suffix}`, createdBy: ids.userId })
  await insertTask(handle, {
    id: ids.taskId,
    projectId: ids.projectId,
    title: 'Seed task',
    assigneeUserId: ids.userId,
    assignmentStatus: 'accepted',
    acceptedAt: new Date(),
    createdBy: ids.userId,
  })
  await handle.insert(schema.pluginPacks).values({
    id: ids.pluginPackId,
    name: `pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy: ids.userId,
  })
  await handle.insert(schema.agents).values({
    id: ids.agentId,
    name: `agent-${suffix}`,
    createdBy: ids.userId,
  })
  await handle.insert(schema.agentProfileRevisions).values({
    id: ids.revisionId,
    agentId: ids.agentId,
    revision: 1,
    persona: 'You are a helpful agent.',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    credentialSlot: 'default',
    pluginPackId: ids.pluginPackId,
    profileDigest: 'b'.repeat(64),
    createdBy: ids.userId,
  })
  await handle
    .update(schema.agents)
    .set({ currentRevisionId: ids.revisionId })
    .where(eq(schema.agents.id, ids.agentId))
  await handle.insert(schema.devices).values({
    id: ids.deviceId,
    ownerUserId: ids.userId,
    name: `dev-${suffix}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: randomBytes(32),
    capabilities: {},
  })
  await handle.insert(schema.workspaces).values({
    id: ids.workspaceId,
    deviceId: ids.deviceId,
    ownerUserId: ids.userId,
    name: `ws-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return ids
}

export function makeActor(userId: string, role: Actor['role'] = 'owner'): Actor {
  return { userId: asUserId(userId), role }
}

/** 第二个用户 + 其 Device/Workspace，用于越权守卫用例（bobWorkspaceInput → FORBIDDEN）。 */
export async function seedSecondUserDevice(handle: DbHandle, ids: SeedIds) {
  const userId = randomUUID()
  const deviceId = randomUUID()
  const workspaceId = randomUUID()
  const suffix = randomUUID().slice(0, 8)
  await insertUser(handle, {
    id: userId,
    username: `user2-${suffix}`,
    displayName: 'Second User',
    passwordHash: '$argon2id$placeholder$placeholder',
  })
  await insertMember(handle, { teamId: ids.teamId, userId, role: 'member' })
  await handle.insert(schema.devices).values({
    id: deviceId,
    ownerUserId: userId,
    name: `dev2-${suffix}`,
    platform: 'linux',
    architecture: 'x64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: randomBytes(32),
    capabilities: {},
  })
  await handle.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId: userId,
    name: `ws2-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { userId, deviceId, workspaceId }
}

export function makeCreateInput(ids: SeedIds, overrides: Partial<CreateRunInput> = {}) {
  return {
    idempotencyKey: randomUUID(),
    agentId: ids.agentId,
    deviceId: ids.deviceId,
    workspaceId: ids.workspaceId,
    prompt: 'implement the task',
    dshDistributionVersion: TEST_DSH_VERSION,
    ...overrides,
  } satisfies CreateRunInput
}

/**
 * 为「已存在用户」（如 driveSetup 的 owner）补齐 Run 的 FK 依赖链：
 * plugin pack → agent → revision（回填 currentRevisionId）、device → workspace。
 * 不创建 team/user/project/task（那些由 HTTP 或 seedRunPrereqs 负责）。
 */
export async function seedRunChainForUser(
  handle: DbHandle,
  userId: string,
): Promise<{
  pluginPackId: string
  agentId: string
  profileRevisionId: string
  deviceId: string
  workspaceId: string
}> {
  const suffix = randomUUID().slice(0, 8)
  const pluginPackId = randomUUID()
  const agentId = randomUUID()
  const profileRevisionId = randomUUID()
  const deviceId = randomUUID()
  const workspaceId = randomUUID()
  await handle.insert(schema.pluginPacks).values({
    id: pluginPackId,
    name: `pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy: userId,
  })
  await handle
    .insert(schema.agents)
    .values({ id: agentId, name: `agent-${suffix}`, createdBy: userId })
  await handle.insert(schema.agentProfileRevisions).values({
    id: profileRevisionId,
    agentId,
    revision: 1,
    persona: 'You are a helpful agent.',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    credentialSlot: 'default',
    pluginPackId,
    profileDigest: 'b'.repeat(64),
    createdBy: userId,
  })
  await handle
    .update(schema.agents)
    .set({ currentRevisionId: profileRevisionId })
    .where(eq(schema.agents.id, agentId))
  await handle.insert(schema.devices).values({
    id: deviceId,
    ownerUserId: userId,
    name: `dev-${suffix}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: randomBytes(32),
    capabilities: {},
  })
  await handle.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId: userId,
    name: `ws-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { pluginPackId, agentId, profileRevisionId, deviceId, workspaceId }
}

/** 直接插入一条 Run 行（不经 orchestrator），用于守卫类用例（G2-05、Task Room 脱敏）。 */
export async function insertRunRow(
  handle: DbHandle,
  input: {
    taskId: string
    ownerUserId: string
    agentId: string
    profileRevisionId: string
    deviceId: string
    workspaceId: string
    status?:
      | 'queued'
      | 'dispatching'
      | 'running'
      | 'waiting_approval'
      | 'cancel_requested'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'lost'
    /** 可空列：显式 null 是「无会话」的语义（run-resume 的 legacy 形态）。 */
    dshSessionId?: string | null
    artifactInputManifest?: ArtifactInputManifest | null
  },
): Promise<string> {
  const runId = randomUUID()
  await handle.insert(schema.runs).values({
    id: runId,
    taskId: input.taskId,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    profileRevisionId: input.profileRevisionId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    status: input.status ?? 'running',
    profileDigest: 'b'.repeat(64),
    pluginPackDigest: 'a'.repeat(64),
    dshDistributionVersion: TEST_DSH_VERSION,
    ...(input.dshSessionId !== undefined ? { dshSessionId: input.dshSessionId } : {}),
    ...(input.artifactInputManifest === undefined
      ? {}
      : { artifactInputManifest: input.artifactInputManifest }),
  })
  return runId
}

/** 直接插入一条 published Artifact（用于 Task Room / submit-review 守卫用例）。 */
export async function insertPublishedArtifact(
  handle: DbHandle,
  input: { taskId: string; runId: string; ownerUserId: string; title?: string },
): Promise<string> {
  const artifactId = randomUUID()
  await handle.insert(schema.artifacts).values({
    id: artifactId,
    taskId: input.taskId,
    runId: input.runId,
    ownerUserId: input.ownerUserId,
    title: input.title ?? 'artifact',
    mediaType: 'text/plain',
    byteSize: 42,
    sha256: 'c'.repeat(64),
    storageKey: 'sha256/cc/' + 'c'.repeat(60),
    status: 'published',
    publishedAt: new Date(),
  })
  return artifactId
}

export interface Harness {
  clock: FakeClock
  outbox: Outbox
  gateway: FakeDeviceGateway
  orchestrator: RunOrchestrator
  worker: OutboxWorker
  /** run.start 的合法设备身份（ingest 的 device 参数）。 */
  deviceFor(ids: SeedIds): { deviceId: string; ownerUserId: string }
  /** worker 派发一轮，并把 Fake Node 的上行帧喂回 orchestrator（模拟一次完整往返）。 */
  pump(ids: SeedIds): Promise<void>
}

export interface HarnessOrchestratorOptions {
  /**
   * orchestrator 的结构化告警通道（#52/评审建议 1）：越边降级是撤销连接级安全网
   * 后的补偿控制，其 warn 是补偿控制生效的唯一机器证据，测试需能注入 spy 断言。
   */
  warn?: (message: string, context: Record<string, unknown>) => void
}

export function makeHarness(
  database: Database,
  gatewayOptions: FakeDeviceGatewayOptions = {},
  orchestratorOptions: HarnessOrchestratorOptions = {},
): Harness {
  const clock = new FakeClock(new Date('2026-08-25T00:00:00.000Z'))
  const now = () => clock.now()
  const outbox = new Outbox(database, { now, random: () => 0 })
  const gateway = new FakeDeviceGateway({ now, ...gatewayOptions })
  // exactOptionalPropertyTypes：warn 未注入时条件展开，不显式传 undefined。
  const orchestrator = new Orchestrator({
    database,
    outbox,
    now,
    ...(orchestratorOptions.warn === undefined ? {} : { warn: orchestratorOptions.warn }),
  })
  const worker = new OutboxWorker({ outbox, gateway, now })
  return {
    clock,
    outbox,
    gateway,
    orchestrator,
    worker,
    deviceFor: (ids) => ({ deviceId: ids.deviceId, ownerUserId: ids.userId }),
    pump: async (ids) => {
      await worker.dispatchOnce()
      for (const frame of gateway.drainUpstream()) {
        await orchestrator.ingestNodeEvent(
          { deviceId: ids.deviceId, ownerUserId: ids.userId },
          frame,
        )
      }
    },
  }
}

let messageSeq = 0

/** 构造 Node 上行 run.event 帧（unknown：ingest 侧走 fail-closed 解析，与真实 WS 一致）。 */
export function runEventFrame(
  runId: string,
  seq: number,
  event: Record<string, unknown>,
  // P1-13 起状态迁移只由 owner 行驱动（project 行是同一事实的收缩镜像）；
  // 驱动状态边事件的测试帧默认 owner，与真实 projector 的输出一致。
  audience: 'owner' | 'project' | 'admin' = 'owner',
): unknown {
  messageSeq += 1
  return {
    protocolVersion: 1,
    messageId: `10000000-0000-4000-8000-${String(messageSeq).padStart(12, '0')}`,
    sentAt: new Date().toISOString(),
    type: 'run.event',
    payload: { runId, seq, occurredAt: new Date().toISOString(), audience, event },
  }
}

export function heartbeatFrame(deviceId: string, activeRunIds: string[] = []): unknown {
  messageSeq += 1
  return {
    protocolVersion: 1,
    messageId: `10000000-0000-4000-8000-${String(messageSeq).padStart(12, '0')}`,
    sentAt: new Date().toISOString(),
    type: 'node.heartbeat',
    payload: { deviceId, activeRunIds, lastEventSeqByRun: {} },
  }
}
