import type { FastifyReply, FastifyRequest } from 'fastify'
import { findSessionActor, insertSession, revokeSession, touchSessionLastSeen } from '@whalepod/db'
import type { Database } from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { hashToken, issueOpaqueToken } from './token.js'

// Cookie 名 whalepod_session（#133 定名；历史暂定名 tabtin_session / project311_session 已废弃）。
export const SESSION_COOKIE = 'whalepod_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 03 §2.1：默认 30 天
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000 // 03 §2.1：每 5 分钟最多更新一次

export interface IssuedSession {
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: Date
}

/** 建立新 Session：明文 Token 只进 Cookie，数据库只存 SHA-256。 */
export async function issueSession(database: Database, userId: string): Promise<IssuedSession> {
  const { token, hash } = issueOpaqueToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const row = await insertSession(database.db, { id: uuidv7(), userId, tokenHash: hash, expiresAt })
  return { token, sessionId: row.id, expiresAt }
}

export interface SessionActor {
  readonly sessionId: string
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly role: 'owner' | 'admin' | 'member'
}

/** 解析 Cookie Token 为当前 Member；撤销/停用/过期/伪造分别映射到 401（04 §6.1）。 */
export async function resolveSession(database: Database, token: string): Promise<SessionActor> {
  const row = await findSessionActor(database.db, hashToken(token))
  if (row === undefined || row.revokedAt !== null) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'session is missing or revoked')
  }
  // 被停用用户的旧 Cookie：401（停用动作会撤销全部 Session，这里是直连 DB 改库时的兜底）。
  if (row.userDisabledAt !== null) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'member is disabled')
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, 'SESSION_EXPIRED', 'session expired')
  }
  const now = new Date()
  await touchSessionLastSeen(
    database.db,
    row.sessionId,
    now,
    new Date(now.getTime() - LAST_SEEN_THROTTLE_MS),
  )
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
  }
}

export type RequireActor = (request: FastifyRequest) => Promise<SessionActor>

/** 02 Task 5 Interfaces：requireActor(request): Promise<Actor>。 */
export function makeRequireActor(database: Database): RequireActor {
  return async (request) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token === undefined || token === '') {
      throw new ApiError(401, 'AUTH_REQUIRED', 'missing session cookie')
    }
    return resolveSession(database, token)
  }
}

export async function revokeCurrentSession(database: Database, sessionId: string): Promise<void> {
  await revokeSession(database.db, sessionId, new Date())
}

/** Cookie 属性固定 HttpOnly + SameSite=Lax + Path=/；Secure 由 public origin 决定。 */
export function setSessionCookie(
  reply: FastifyReply,
  session: { token: string; expiresAt: Date },
  secure: boolean,
): void {
  void reply.setCookie(SESSION_COOKIE, session.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: session.expiresAt,
  })
}
