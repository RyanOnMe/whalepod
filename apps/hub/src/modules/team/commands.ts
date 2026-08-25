import { createHash } from 'node:crypto'
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
} from '@project311/db'
import type { Database } from '@project311/db'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { SESSION_TTL_MS } from '../auth/session.js'
import { hashToken, issueOpaqueToken } from '../auth/token.js'

export const CORE_EMPTY_PACK_NAME = 'core-empty'

/** invite.expires_at 默认 72 小时（03 §2.1）。 */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000

/**
 * 标准 pack 算法（03 §2.5：pack_digest 为规范化内容 SHA-256）：
 * 规范化形式 = 按字典序排序后的 installation id 数组的 JSON。
 * core-empty 的外部 installation 列表为空，digest = sha256('[]')。
 */
export function computePackDigest(installations: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...installations].sort()))
    .digest('hex')
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
        packDigest: computePackDigest([]),
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
