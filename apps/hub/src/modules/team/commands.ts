import { eq, sql } from 'drizzle-orm'
import { digestPluginPack } from '@whalepod/protocol/plugin-pack-digest'
import {
  consumeInvite,
  disableUser,
  findInviteByTokenHash,
  getMember,
  getTeam,
  insertMember,
  insertSession,
  insertTeam,
  insertUser,
  insertInvite,
  revokeSessionsForUser,
  schema,
  unwrapPgError,
} from '@whalepod/db'
import type { Database } from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { SESSION_TTL_MS } from '../auth/session.js'
import { hashToken, issueOpaqueToken } from '../auth/token.js'

export const CORE_EMPTY_PACK_NAME = 'core-empty'

/** invite.expires_at 默认 72 小时（03 §2.1）。 */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000

/**
 * core-empty Pack（02 Task 5 Step 3）：外部 installation 列表为空。
 * pack_digest 与 03 §2.5 同一算法——digestPluginPack（packages 排序后 canonical
 * JSON 的 SHA-256，与 plugin 模块组装 Pack 完全一致；空闭包为固定值）。
 * 旧算法 sha256('[]')（installation id 数组 digest）已废弃：pack_digest 是内容
 * digest，Node 侧 preflight 只能按内容算法复算。
 */
export const CORE_EMPTY_PACK_DIGEST = digestPluginPack({ schemaVersion: 1, packages: [] })

/**
 * core-empty digest 断代迁移的并发串行化锁键（#55，P1-17 review M10）。
 * 固定 int8 常量 = parseInt(sha256('whalepod:core-empty-pack-digest-migration')
 * 前 8 位 hex, 16)（与 plugin/commands.ts advisoryKey 同一推导风格，值在提交前
 * 现算后冻结于此，便于全文检索）。全仓库唯一：与 schema 迁移锁键 20260825
 * （packages/db/src/migrate.ts）及插件安装 (name@version) 派生键互不共用；
 * 即便与插件安装键偶合也只会多一次无碍串行，不破坏正确性。
 */
export const CORE_EMPTY_MIGRATION_LOCK_KEY = 2_874_284_989

/** 等锁上限：防病态持有者让 /setup 无限排队（#55 N2，超时 fail-fast 可归因可重试）。 */
const MIGRATION_LOCK_TIMEOUT_MS = 30_000

/** 等锁超时（PostgreSQL 55P03 lock_not_available）的归因包装：调用方按类型记告警并 500。 */
export class MigrationLockTimeoutError extends Error {
  override readonly name = 'MigrationLockTimeoutError'

  constructor(readonly lockTimeoutMs: number) {
    super(
      `core-empty digest migration advisory lock wait exceeded ${lockTimeoutMs}ms, failing fast`,
    )
  }
}

/**
 * core-empty pack digest 断代幂等迁移（P1-17 review M10）：旧代码按旧算法
 * sha256('[]')（4f53cd…）落库；算法换代后（digestPluginPack，空闭包固定值
 * 4d1be1bb…）Node preflight 只认新常量，旧 digest 行会让所有引用它的 Run 被
 * preflight 拒。在 POST /setup 处理入口触发（升级期最自然的可达入口，已初始化
 * 实例重试 setup 也会经过）：检测到 name=core-empty 行的 digest 非现算值
 * （含旧值与任何未知值）即原地 UPDATE 为现算值；无行或已是现算值 = no-op，
 * 重复触发安全。返回是否发生了迁移，供调用方记告警。
 *
 * 并发安全（#55）：read-modify-write 整体收进「事务 + 事务级 advisory lock」
 * 临界区——并发调用者被串行化，败者阻塞等胜者提交后重读即见现算值返回 false，
 * 「发生了迁移 = true」与迁移告警在并发下恰好一次、可计数；xact 锁随
 * COMMIT/ROLLBACK 自动释放，进程崩溃连接断开即失效，不残留。隔离级别显式钉
 * READ COMMITTED：「恰好一次」依赖其语句级快照语义——败者等锁后的 SELECT 是新
 * 快照，必见胜者已提交值；不随会话/数据库默认隔离级别漂移。等锁带 lock_timeout
 * 上限：超时抛 MigrationLockTimeoutError（fail-fast，报错可重试），不让 /setup
 * 被病态持锁者无限排队。与 setupInstance 的时序组合可证：setup 事务只会以现算
 * digest 建新行（对迁移恒为 no-op），且旧行存在 ⟹ team 已存在 ⟹ setup 必 409，
 * 不产生第二行。
 */
export async function migrateCoreEmptyPackDigest(
  database: Database,
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<boolean> {
  const lockTimeoutMs = options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS
  try {
    return await database.transaction(
      async (tx) => {
        // 先设本事务等锁上限，再取锁（SET LOCAL 语义，随事务结束失效）。
        await tx.execute(sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`)
        // 串行化点：pg_advisory_xact_lock 等待取锁（上限内非 fail-fast），事务结束自动释放。
        await tx.execute(sql`select pg_advisory_xact_lock(${CORE_EMPTY_MIGRATION_LOCK_KEY})`)
        const [row] = await tx
          .select()
          .from(schema.pluginPacks)
          .where(eq(schema.pluginPacks.name, CORE_EMPTY_PACK_NAME))
        if (row === undefined || row.packDigest === CORE_EMPTY_PACK_DIGEST) return false
        await tx
          .update(schema.pluginPacks)
          .set({ packDigest: CORE_EMPTY_PACK_DIGEST })
          .where(eq(schema.pluginPacks.id, row.id))
        return true
      },
      { isolationLevel: 'read committed' },
    )
  } catch (error) {
    if (unwrapPgError(error)?.code === '55P03') {
      throw new MigrationLockTimeoutError(lockTimeoutMs)
    }
    throw error
  }
}

export interface SetupResult {
  readonly teamId: string
  readonly userId: string
  readonly sessionToken: string
  readonly sessionExpiresAt: Date
}

/**
 * 首次 Setup（02 Task 5）：单事务创建 Team、Owner 用户、owner 成员关系、
 * 不可变 core-empty Plugin Pack 与首个 Session。
 * 并发竞争由 team_singleton 唯一约束兜底，败者整体回滚并映射 409（G1-02）。
 */
export async function setupInstance(
  database: Database,
  input: { teamName: string; username: string; displayName: string; passwordHash: string },
): Promise<SetupResult> {
  const teamId = uuidv7()
  const userId = uuidv7()
  const session = issueOpaqueToken()
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS)
  try {
    await database.transaction(async (tx) => {
      if ((await getTeam(tx)) !== undefined) {
        throw new ApiError(409, 'CONFLICT', 'instance already initialized')
      }
      await insertTeam(tx, { id: teamId, name: input.teamName })
      await insertUser(tx, {
        id: userId,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
      })
      await insertMember(tx, { teamId, userId, role: 'owner' })
      await tx.insert(schema.pluginPacks).values({
        id: uuidv7(),
        name: CORE_EMPTY_PACK_NAME,
        installations: [],
        packDigest: CORE_EMPTY_PACK_DIGEST,
        createdBy: userId,
      })
      await insertSession(tx, {
        id: uuidv7(),
        userId,
        tokenHash: session.hash,
        expiresAt: sessionExpiresAt,
      })
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    const pg = unwrapPgError(error)
    if (pg?.code === '23505') {
      throw new ApiError(409, 'CONFLICT', 'instance already initialized')
    }
    throw error
  }
  return { teamId, userId, sessionToken: session.token, sessionExpiresAt }
}

export interface CreatedInvite {
  readonly inviteId: string
  readonly token: string
  readonly role: 'admin' | 'member'
  readonly expiresAt: Date
}

/** 创建邀请（03 §2.1：不能邀请 Owner——role 枚举在 schema 层已挡住 owner）。 */
export async function createInvite(
  database: Database,
  input: { role: 'admin' | 'member'; createdBy: string },
): Promise<CreatedInvite> {
  const { token, hash } = issueOpaqueToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const row = await insertInvite(database.db, {
    id: uuidv7(),
    tokenHash: hash,
    role: input.role,
    createdBy: input.createdBy,
    expiresAt,
  })
  return { inviteId: row.id, token, role: row.role, expiresAt: row.expiresAt }
}

export interface AcceptedInvite {
  readonly userId: string
  readonly role: 'admin' | 'member'
  readonly sessionToken: string
  readonly sessionExpiresAt: Date
}

/**
 * 接受邀请（02 Task 5 Step 6）：consume 与创建用户/成员/会话同事务。
 * 已消费、过期、未知 Token 统一 409（G1-04，不可枚举）；username 冲突 409 且
 * 邀请随事务回滚不被消费。
 */
export async function acceptInvite(
  database: Database,
  input: { token: string; username: string; displayName: string; passwordHash: string },
): Promise<AcceptedInvite> {
  const tokenHash = hashToken(input.token)
  const userId = uuidv7()
  const session = issueOpaqueToken()
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS)
  try {
    return await database.transaction(async (tx) => {
      const invite = await findInviteByTokenHash(tx, tokenHash)
      if (invite === undefined) throw inviteConflict()
      // 先落用户行（consumed_by 有外键），再原子消费邀请挡并发重复接受。
      await insertUser(tx, {
        id: userId,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
      })
      const consumed = await consumeInvite(tx, invite.id, userId, new Date())
      if (consumed === undefined) throw inviteConflict()
      const team = await getTeam(tx)
      if (team === undefined) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'invite exists without a team')
      }
      await insertMember(tx, { teamId: team.id, userId, role: invite.role })
      await insertSession(tx, {
        id: uuidv7(),
        userId,
        tokenHash: session.hash,
        expiresAt: sessionExpiresAt,
      })
      return { userId, role: invite.role, sessionToken: session.token, sessionExpiresAt }
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    const pg = unwrapPgError(error)
    if (pg?.code === '23505' && pg.constraintName === 'user_account_username_key') {
      throw new ApiError(409, 'CONFLICT', 'username already taken')
    }
    if (pg?.code === '23505') throw inviteConflict()
    throw error
  }
}

function inviteConflict(): ApiError {
  return new ApiError(409, 'CONFLICT', 'invite token is invalid, expired or already consumed')
}

/**
 * 停用成员：被停用后所有 Session 失效（03 §2.1，同一事务写入）。
 * 最后 Owner 保护走 db 层既有策略（disableUser 抛 LastOwnerError），
 * 由 app.ts 错误处理器映射 409 CONFLICT（G1-06）。
 */
export async function disableMember(
  database: Database,
  input: { targetUserId: string },
): Promise<void> {
  await database.transaction(async (tx) => {
    const team = await getTeam(tx)
    if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
    const member = await getMember(tx, team.id, input.targetUserId)
    if (member === undefined) throw new ApiError(404, 'NOT_FOUND', 'member not found')
    const now = new Date()
    await disableUser(tx, input.targetUserId, now)
    await revokeSessionsForUser(tx, input.targetUserId, now)
  })
}
