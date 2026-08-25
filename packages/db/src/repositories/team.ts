import { and, count, eq, isNull, ne } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { teamMembers, teams, userAccounts } from '../schema/identity.js'

export type TeamRow = typeof teams.$inferSelect
export type UserRow = typeof userAccounts.$inferSelect
export type TeamMemberRow = typeof teamMembers.$inferSelect
export type Role = TeamMemberRow['role']

/**
 * 03 §2.1 不变量「始终至少有一个未停用 Owner」无法表达为行级约束，
 * 由事务策略保护：Owner 变更先锁 Team 行串行化，再核对其余未停用 Owner 计数。
 * Hub 层映射为 FORBIDDEN/CONFLICT（03 §10 无专用码）。
 */
export class LastOwnerError extends Error {
  readonly code = 'LAST_OWNER_REQUIRED' as const

  constructor(message: string = 'team must keep at least one enabled owner') {
    super(message)
    this.name = 'LastOwnerError'
  }
}

export async function insertTeam(
  handle: DbHandle,
  team: { id: string; name: string },
): Promise<TeamRow> {
  const [row] = await handle.insert(teams).values(team).returning()
  if (row === undefined) throw new Error('insert team returned no row')
  return row
}

export async function getTeam(handle: DbHandle): Promise<TeamRow | undefined> {
  const [row] = await handle.select().from(teams).limit(1)
  return row
}

export interface NewUser {
  id: string
  username: string
  displayName: string
  passwordHash: string
}

export async function insertUser(handle: DbHandle, user: NewUser): Promise<UserRow> {
  const [row] = await handle.insert(userAccounts).values(user).returning()
  if (row === undefined) throw new Error('insert user returned no row')
  return row
}

export async function insertMember(
  handle: DbHandle,
  member: { teamId: string; userId: string; role: Role },
): Promise<TeamMemberRow> {
  const [row] = await handle.insert(teamMembers).values(member).returning()
  if (row === undefined) throw new Error('insert member returned no row')
  return row
}

export async function getMember(
  handle: DbHandle,
  teamId: string,
  userId: string,
): Promise<TeamMemberRow | undefined> {
  const [row] = await handle
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1)
  return row
}

/**
 * 取「未停用」的 Team Member（03 §2.2：Task assignee 必须是未停用 Member）。
 * 不存在或已停用均返回 undefined，调用方统一映射为输入校验失败。
 */
export async function getEnabledMember(
  handle: DbHandle,
  teamId: string,
  userId: string,
): Promise<TeamMemberRow | undefined> {
  const [row] = await handle
    .select({ member: teamMembers, disabledAt: userAccounts.disabledAt })
    .from(teamMembers)
    .innerJoin(userAccounts, eq(userAccounts.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1)
  if (row === undefined || row.disabledAt !== null) return undefined
  return row.member
}

export async function setMemberRole(
  handle: DbHandle,
  teamId: string,
  userId: string,
  role: Role,
): Promise<TeamMemberRow | undefined> {
  await lockTeam(handle, teamId)
  const member = await getMember(handle, teamId, userId)
  if (member === undefined) return undefined
  if (member.role === 'owner' && role !== 'owner' && (await isEnabled(handle, userId))) {
    await assertAnotherEnabledOwner(handle, teamId, userId)
  }
  const [row] = await handle
    .update(teamMembers)
    .set({ role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning()
  return row
}

/** 停用成员：被停用后所有 Session 与 Device Token 失效（03 §2.1，失效动作由 Hub 落地）。 */
export async function disableUser(
  handle: DbHandle,
  userId: string,
  disabledAt: Date,
): Promise<UserRow | undefined> {
  const [member] = await handle
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .limit(1)
  if (member !== undefined && member.role === 'owner' && (await isEnabled(handle, userId))) {
    await lockTeam(handle, member.teamId)
    await assertAnotherEnabledOwner(handle, member.teamId, userId)
  }
  const [row] = await handle
    .update(userAccounts)
    .set({ disabledAt })
    .where(eq(userAccounts.id, userId))
    .returning()
  return row
}

async function lockTeam(handle: DbHandle, teamId: string): Promise<void> {
  await handle.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for('update')
}

async function isEnabled(handle: DbHandle, userId: string): Promise<boolean> {
  const [row] = await handle
    .select({ disabledAt: userAccounts.disabledAt })
    .from(userAccounts)
    .where(eq(userAccounts.id, userId))
    .limit(1)
  return row !== undefined && row.disabledAt === null
}

async function assertAnotherEnabledOwner(
  handle: DbHandle,
  teamId: string,
  userId: string,
): Promise<void> {
  const [row] = await handle
    .select({ value: count() })
    .from(teamMembers)
    .innerJoin(userAccounts, eq(userAccounts.id, teamMembers.userId))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, 'owner'),
        ne(teamMembers.userId, userId),
        isNull(userAccounts.disabledAt),
      ),
    )
  if ((row?.value ?? 0) === 0) throw new LastOwnerError()
}
