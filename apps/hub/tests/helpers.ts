/**
 * Hub integration spec 的统一入口与驱动助手。
 *
 * 两类驱动共存：
 * - HTTP 路径（P1-05 setup/auth/invite）：全部走 Fastify inject（真人同一条 HTTP 路径）；
 *   DB 断言走 raw SQL。
 * - Run Orchestrator 路径（P1-10）：直驱 RunOrchestrator + OutboxWorker + FakeDeviceGateway，
 *   不经过 HTTP（routes 留给组合根接线，P1-13）。
 *
 * 迁移应用 / 复位 / DATABASE_URL 检查与 packages/db/tests/helpers.ts 同源，但只依赖
 * @project311/db 的公开导出，不跨包引用测试内部文件（跨包 re-export 在干净 checkout 下
 * 无法被 Vite module graph 解析）。seedRunPrereqs 在此本地实现，沿用同源约定。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { Actor } from '@project311/domain'
import { asUserId } from '@project311/domain'
import {
  applyMigrations,
  createDatabase,
  insertMember,
  insertProject,
  insertTask,
  insertTeam,
  insertUser,
  Outbox,
  schema,
} from '@project311/db'
import type { Database, DbHandle } from '@project311/db'
import type { FakeDeviceGatewayOptions } from '@project311/testkit'
import { FakeClock, FakeDeviceGateway } from '@project311/testkit'
import type { CreateRunInput, RunOrchestrator } from '../src/modules/run/index.js'
import { RunOrchestrator as Orchestrator } from '../src/modules/run/index.js'
import { OutboxWorker } from '../src/modules/run/index.js'
import { buildApp } from '../src/app.js'
import type { HubConfig } from '../src/config.js'

// 迁移应用已收敛到 @project311/db 公开导出（src/migrate.ts）；applyMigrations 经上方 import 提供。
const MIGRATION_TABLE = '_schema_migrations' as const

export async function resetDatabase(database: Database): Promise<void> {
  const rows = await database.sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> ${MIGRATION_TABLE}
  `
  if (rows.length === 0) return
  const list = rows.map(({ tablename }) => `"${tablename}"`).join(', ')
  await database.sql.unsafe(`truncate table ${list} restart identity cascade`)
}

export async function createTestDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL 未设置：integration 测试须经 scripts/with-test-postgres.mts 运行')
  }
  const database = createDatabase({ connectionString: url, max: 4 })
  await applyMigrations(database)
  return database
}

/** 捕获 hub 审计事件（component=hub.audit 的结构化日志行）。 */
export interface AuditEvent {
  component: string
  action: string
  actor: string
  outcome: string
  requestId: string
}

class AuditStream extends Writable {
  readonly events: AuditEvent[] = []

  override _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const entry = JSON.parse(trimmed) as { component?: string } & AuditEvent
        if (entry.component === 'hub.audit') this.events.push(entry)
      } catch {
        // 非 JSON 行（启动横幅等）忽略
      }
    }
    callback()
  }
}

export interface TestApp {
  readonly app: FastifyInstance
  readonly database: Database
  readonly origin: string
  readonly setupToken: string
  readonly setupTokenPath: string
  readonly auditEvents: AuditEvent[]
  readonly config: HubConfig
  close(): Promise<void>
}

export interface TestAppOptions {
  /** 默认 http://localhost:4242（Secure=false 分支）；换 https origin 走 Secure=true 分支。 */
  readonly origin?: string
  readonly rateLimit?: HubConfig['rateLimit']
}

export async function createTestApp(
  database: Database,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const origin = options.origin ?? 'http://localhost:4242'
  const dir = await mkdtemp(join(tmpdir(), 'p311-hub-test-'))
  const setupTokenPath = join(dir, 'setup-token')
  const setupToken = randomBytes(32).toString('base64url')
  await writeFile(setupTokenPath, setupToken, { mode: 0o600 })
  const audit = new AuditStream()
  const config: HubConfig = {
    publicOrigin: origin,
    databaseUrl: '',
    setupTokenPath,
    host: '127.0.0.1',
    port: 0,
    // P1-15：Artifact Store 与 setup token 同一个一次性临时目录。
    artifactStoreDir: join(dir, 'artifact-store'),
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
  }
  const app = await buildApp({
    config,
    database,
    logger: { level: 'info', stream: audit },
  })
  return {
    app,
    database,
    origin,
    setupToken,
    setupTokenPath,
    auditEvents: audit.events,
    config,
    close: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 驱动助手：全部走 HTTP inject，不抄近道。
// ---------------------------------------------------------------------------

export interface Session {
  readonly cookie: string
  readonly userId: string
}

export function idemKey(): string {
  return randomBytes(16).toString('hex')
}

/** 已认证的 HTTP inject：带 Origin、Cookie 与 Idempotency-Key（GET 也会带上，无害）。 */
export async function apiInject(
  ctx: TestApp,
  session: Session,
  opts: { method: string; url: string; payload?: object; idempotencyKey?: string },
) {
  return ctx.app.inject({
    method: opts.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: opts.url,
    headers: {
      origin: ctx.origin,
      cookie: session.cookie,
      'idempotency-key': opts.idempotencyKey ?? idemKey(),
    },
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  })
}

/** 从 set-cookie 头提取 project311_session 的 Cookie 请求头值。 */
export function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (header === undefined) throw new Error('response 缺少 set-cookie')
  const pair = header.split(';')[0]
  if (pair === undefined || !pair.startsWith('project311_session=')) {
    throw new Error(`set-cookie 不含 project311_session：${header}`)
  }
  return pair
}

/** G1-01 驱动：完成首次 Setup，返回 Owner 会话。 */
export async function driveSetup(ctx: TestApp, username = 'alice'): Promise<Session> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      setupToken: ctx.setupToken,
      teamName: 'Acme',
      username,
      displayName: 'Alice',
      password: 'correct horse battery staple',
    },
  })
  if (response.statusCode !== 201) {
    throw new Error(`setup 失败：${response.statusCode} ${response.body}`)
  }
  const body = response.json() as { ok: true; data: { userId: string } }
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: body.data.userId }
}

/** 登录驱动。 */
export async function driveLogin(
  ctx: TestApp,
  username: string,
  password: string,
): Promise<Session> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: { username, password },
  })
  if (response.statusCode !== 200) {
    throw new Error(`login 失败：${response.statusCode} ${response.body}`)
  }
  const body = response.json() as { ok: true; data: { userId: string } }
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: body.data.userId }
}

/** G1-03 驱动：actor 创建邀请，新用户接受邀请，返回新会话与邀请 Token。 */
export async function driveInviteAndAccept(
  ctx: TestApp,
  actor: Session,
  invitee: { username: string; displayName: string; password: string },
  role: 'admin' | 'member' = 'member',
): Promise<{ session: Session; inviteToken: string; inviteId: string }> {
  const createResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/invites',
    headers: {
      origin: ctx.origin,
      'idempotency-key': idemKey(),
      cookie: actor.cookie,
    },
    payload: { role },
  })
  if (createResponse.statusCode !== 201) {
    throw new Error(`create invite 失败：${createResponse.statusCode} ${createResponse.body}`)
  }
  const created = createResponse.json() as {
    ok: true
    data: { inviteId: string; token: string }
  }
  const acceptResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/invites/accept',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      token: created.data.token,
      username: invitee.username,
      displayName: invitee.displayName,
      password: invitee.password,
    },
  })
  if (acceptResponse.statusCode !== 201) {
    throw new Error(`accept invite 失败：${acceptResponse.statusCode} ${acceptResponse.body}`)
  }
  const accepted = acceptResponse.json() as { ok: true; data: { userId: string } }
  return {
    session: {
      cookie: extractSessionCookie(acceptResponse.headers['set-cookie']),
      userId: accepted.data.userId,
    },
    inviteToken: created.data.token,
    inviteId: created.data.inviteId,
  }
}

// ---------------------------------------------------------------------------
// Run Orchestrator 驱动助手（P1-10）：直驱深模块，不经过 HTTP。
// 与 packages/db/tests/helpers.ts 同源约定：seedRunPrereqs 本地实现，只用 @project311/db
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
    provider: 'deepseek',
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
    provider: 'deepseek',
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
    dshSessionId?: string
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

export function makeHarness(
  database: Database,
  gatewayOptions: FakeDeviceGatewayOptions = {},
): Harness {
  const clock = new FakeClock(new Date('2026-08-25T00:00:00.000Z'))
  const now = () => clock.now()
  const outbox = new Outbox(database, { now, random: () => 0 })
  const gateway = new FakeDeviceGateway({ now, ...gatewayOptions })
  const orchestrator = new Orchestrator({ database, outbox, now })
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
