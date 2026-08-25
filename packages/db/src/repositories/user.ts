import { eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { userAccounts } from '../schema/identity.js'
import type { UserRow } from './team.js'

/** 登录路径按 username 查用户；username 有唯一约束（03 §2.1）。 */
export async function findUserByUsername(
  handle: DbHandle,
  username: string,
): Promise<UserRow | undefined> {
  const [row] = await handle
    .select()
    .from(userAccounts)
    .where(eq(userAccounts.username, username))
    .limit(1)
  return row
}

export async function findUserById(handle: DbHandle, userId: string): Promise<UserRow | undefined> {
  const [row] = await handle.select().from(userAccounts).where(eq(userAccounts.id, userId)).limit(1)
  return row
}
