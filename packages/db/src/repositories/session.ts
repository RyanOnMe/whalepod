import { and, eq, isNull, lt } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { authSessions, teamMembers, userAccounts } from '../schema/identity.js'

// opaque Session 持久化（03 §2.1 auth_session）：数据库只存 token 的 SHA-256。
export type AuthSessionRow = typeof authSessions.$inferSelect

export interface NewSession {
  id: string
  userId: string
  /** 明文 Token 的 SHA-256（32 字节）；明文永不分库。 */
  tokenHash: Uint8Array
  expiresAt: Date
}

export async function insertSession(
  handle: DbHandle,
  session: NewSession,
): Promise<AuthSessionRow> {
  const [row] = await handle.insert(authSessions).values(session).returning()
  if (row === undefined) throw new Error('insert session returned no row')
  return row
}

/** 登出或成员停用时写入 revoked_at（03 §2.1）。 */
export async function revokeSession(
  handle: DbHandle,
  sessionId: string,
  revokedAt: Date,
): Promise<void> {
  await handle
    .update(authSessions)
    .set({ revokedAt })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
}

/** 成员停用时撤销其全部活跃 Session；返回撤销条数。 */
export async function revokeSessionsForUser(
  handle: DbHandle,
  userId: string,
  revokedAt: Date,
): Promise<number> {
  const rows = await handle
    .update(authSessions)
    .set({ revokedAt })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id })
  return rows.length
}

export interface SessionActorRow {
  sessionId: string
  userId: string
  username: string
  displayName: string
  role: 'owner' | 'admin' | 'member'
  expiresAt: Date
  revokedAt: Date | null
  lastSeenAt: Date
  userDisabledAt: Date | null
}

/**
 * 按 token hash 解析当前会话对应的 Member（一次 join 取齐 actor 判定所需字段）。
 * revoked / 过期 / 用户停用 的判定留给 Hub 层，这里只取数。
 */
export async function findSessionActor(
  handle: DbHandle,
  tokenHash: Uint8Array,
): Promise<SessionActorRow | undefined> {
  const [row] = await handle
    .select({
      sessionId: authSessions.id,
      userId: userAccounts.id,
      username: userAccounts.username,
      displayName: userAccounts.displayName,
      role: teamMembers.role,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
      lastSeenAt: authSessions.lastSeenAt,
      userDisabledAt: userAccounts.disabledAt,
    })
    .from(authSessions)
    .innerJoin(userAccounts, eq(userAccounts.id, authSessions.userId))
    .innerJoin(teamMembers, eq(teamMembers.userId, userAccounts.id))
    .where(eq(authSessions.tokenHash, tokenHash))
    .limit(1)
  return row
}

/** last_seen_at 每 5 分钟最多更新一次（03 §2.1）：仅当早于 threshold 才写。 */
export async function touchSessionLastSeen(
  handle: DbHandle,
  sessionId: string,
  seenAt: Date,
  threshold: Date,
): Promise<void> {
  await handle
    .update(authSessions)
    .set({ lastSeenAt: seenAt })
    .where(and(eq(authSessions.id, sessionId), lt(authSessions.lastSeenAt, threshold)))
}

/** 测试与运维排查用：按 id 取会话行。 */
export async function findSessionById(
  handle: DbHandle,
  sessionId: string,
): Promise<AuthSessionRow | undefined> {
  const [row] = await handle
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1)
  return row
}
