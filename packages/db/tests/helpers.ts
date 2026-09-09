import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Database, DbHandle, PgErrorInfo } from '../src/index.js'
import { applyMigrations } from '../src/index.js'
import {
  createDatabase,
  insertMember,
  insertProject,
  insertTask,
  insertTeam,
  insertUser,
  unwrapPgError,
} from '../src/index.js'
import type { NewRun } from '../src/index.js'
import {
  agentProfileRevisions,
  agents,
  devices,
  pluginPacks,
  workspaces,
} from '../src/schema/index.js'

const MIGRATION_TABLE = '_schema_migrations'
// advisory lock：串行化并发 spec 文件的迁移应用，内容任意但全仓库唯一。
const MIGRATION_LOCK_KEY = 20260825

// 迁移应用已收敛到包内（src/migrate.ts）；导入并再导出以维持既有导入路径。
export { applyMigrations }

/** 清空所有业务表（保留迁移台账），供 beforeEach 复位。 */
export async function resetDatabase(database: Database): Promise<void> {
  const rows = await database.sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> ${MIGRATION_TABLE}
  `
  if (rows.length === 0) return
  const list = rows.map(({ tablename }) => `"${tablename}"`).join(', ')
  await database.sql.unsafe(`truncate table ${list} restart identity cascade`)
}

/**
 * integration spec 的统一入口：要求 DATABASE_URL（由 scripts/with-test-postgres.mts 注入），
 * 建连并应用迁移。每个 spec 文件结束后必须 close()，保证连接不残留。
 */
export async function createTestDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL 未设置：integration 测试须经 scripts/with-test-postgres.mts 运行')
  }
  const database = createDatabase({ connectionString: url, max: 4 })
  await applyMigrations(database)
  return database
}

/**
 * 断言一个 promise 以 PostgreSQL 错误拒绝（drizzle 会把驱动错误包进
 * DrizzleQueryError，这里沿 cause 链解出 SQLSTATE 与约束名）。
 * 不拒绝、或拒绝原因不是 PG 错误时抛错，测试判负。
 */
export async function catchPgError(promise: Promise<unknown>): Promise<PgErrorInfo> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  const pg = unwrapPgError(error)
  if (pg === undefined) {
    throw new Error(`expected a PostgreSQL error rejection, got: ${String(error)}`)
  }
  return pg
}

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
  await handle.insert(pluginPacks).values({
    id: ids.pluginPackId,
    name: `pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy: ids.userId,
  })
  await handle.insert(agents).values({
    id: ids.agentId,
    name: `agent-${suffix}`,
    createdBy: ids.userId,
  })
  await handle.insert(agentProfileRevisions).values({
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
    .update(agents)
    .set({ currentRevisionId: ids.revisionId })
    .where(eq(agents.id, ids.agentId))
  await handle.insert(devices).values({
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
  await handle.insert(workspaces).values({
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

export function makeRunInput(ids: SeedIds, overrides: Partial<NewRun> = {}): NewRun {
  return {
    id: randomUUID(),
    createdAt: new Date(),
    taskId: ids.taskId,
    ownerUserId: ids.userId,
    agentId: ids.agentId,
    profileRevisionId: ids.revisionId,
    deviceId: ids.deviceId,
    workspaceId: ids.workspaceId,
    profileDigest: 'b'.repeat(64),
    pluginPackDigest: 'a'.repeat(64),
    dshDistributionVersion: '0.1.0-rc.6',
    ...overrides,
  }
}

export function makeRunEventInput(runId: string, seq: number, payload: unknown = {}) {
  return {
    id: randomUUID(),
    runId,
    seq,
    type: 'run.phase',
    audience: 'project' as const,
    payload,
    occurredAt: new Date(),
  }
}

export function makeApprovalInput(runId: string, callId: string) {
  return {
    id: randomUUID(),
    runId,
    callId,
    toolName: 'fs.write',
    reason: 'needs write access',
    preview: { path: 'src/index.ts' },
    expiresAt: new Date(Date.now() + 600_000),
  }
}

export function makeArtifactInput(ids: SeedIds, runId: string) {
  const sha256 = 'c'.repeat(64)
  return {
    id: randomUUID(),
    taskId: ids.taskId,
    runId,
    ownerUserId: ids.userId,
    title: 'Report',
    mediaType: 'text/markdown',
    byteSize: 1024,
    sha256,
    storageKey: `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
  }
}
