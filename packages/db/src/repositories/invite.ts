import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { invites } from '../schema/identity.js'

// 一次性邀请（03 §2.1 invite）：数据库只存 token 的 SHA-256，不能邀请 Owner。
export type InviteRow = typeof invites.$inferSelect

export interface NewInvite {
  id: string
  /** 明文 Token 的 SHA-256（32 字节）；明文永不分库。 */
  tokenHash: Uint8Array
  role: 'admin' | 'member'
  createdBy: string
  /** 默认 72 小时由 Hub 计算。 */
  expiresAt: Date
}

export async function insertInvite(handle: DbHandle, invite: NewInvite): Promise<InviteRow> {
  const [row] = await handle.insert(invites).values(invite).returning()
  if (row === undefined) throw new Error('insert invite returned no row')
  return row
}

export async function findInviteByTokenHash(
  handle: DbHandle,
  tokenHash: Uint8Array,
): Promise<InviteRow | undefined> {
  const [row] = await handle.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1)
  return row
}

/**
 * 原子消费：仅当未消费且未过期才写入 consumed_by/consumed_at。
 * 返回 undefined 表示已消费 / 已过期 / 不存在，调用方统一映射为 409（G1-04）。
 */
export async function consumeInvite(
  handle: DbHandle,
  inviteId: string,
  consumedBy: string,
  consumedAt: Date,
): Promise<InviteRow | undefined> {
  const [row] = await handle
    .update(invites)
    .set({ consumedBy, consumedAt })
    .where(
      and(eq(invites.id, inviteId), isNull(invites.consumedAt), gt(invites.expiresAt, consumedAt)),
    )
    .returning()
  return row
}
