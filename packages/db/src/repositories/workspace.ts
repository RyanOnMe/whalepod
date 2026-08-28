/**
 * Workspace 投影仓储（P1-12；03 §2.4 workspace 表、§4 GET /workspaces）。
 *
 * Hub 只持有不透明投影：node.inventory 经 owner 校验后 upsert；
 * 绝对路径/canonical_path 只存在于 Node 本地（03 §2.4），不进 Hub。
 * (owner_user_id, name) 唯一：Node 侧 registry 是事实源，同名重注册按
 * 「Node 现状镜像」语义替换旧投影（删除旧行后写入新行），重放收敛。
 */
import { and, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { workspaces } from '../schema/device.js'

export interface WorkspaceUpsert {
  readonly id: string
  readonly deviceId: string
  readonly ownerUserId: string
  readonly name: string
  readonly kind: 'directory' | 'git_repository'
  readonly capabilities: Record<string, unknown>
  readonly available: boolean
  readonly lastCheckedAt: Date
}

/**
 * 按 id upsert；同名（owner 内）冲突时删旧投影再写入（Node registry 镜像语义）。
 * 返回 'upserted' | 'replaced'（同名替换）。
 */
export async function upsertWorkspace(
  handle: DbHandle,
  input: WorkspaceUpsert,
): Promise<'upserted' | 'replaced'> {
  const existingById = await handle
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.id))
    .limit(1)
  if (existingById.length > 0) {
    await handle
      .update(workspaces)
      .set({
        deviceId: input.deviceId,
        name: input.name,
        kind: input.kind,
        capabilities: input.capabilities,
        available: input.available,
        lastCheckedAt: input.lastCheckedAt,
      })
      .where(eq(workspaces.id, input.id))
    return 'upserted'
  }
  // 同名不同 id：删旧投影（Node 侧已不存在该 id 或已重注册）。
  await handle
    .delete(workspaces)
    .where(and(eq(workspaces.ownerUserId, input.ownerUserId), eq(workspaces.name, input.name)))
  await handle.insert(workspaces).values(input)
  return 'replaced'
}

/** owner-scoped 不透明投影（03 §4：只返回当前 Member 自己的 Workspace）。 */
export async function listWorkspacesByOwner(
  handle: DbHandle,
  ownerUserId: string,
): Promise<
  Array<{
    id: string
    name: string
    kind: string
    capabilities: unknown
    available: boolean
    lastCheckedAt: Date
  }>
> {
  return handle
    .select({
      id: workspaces.id,
      name: workspaces.name,
      kind: workspaces.kind,
      capabilities: workspaces.capabilities,
      available: workspaces.available,
      lastCheckedAt: workspaces.lastCheckedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, ownerUserId))
}
