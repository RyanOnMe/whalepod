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
import { runs } from '../schema/run.js'

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

/**
 * #94 删除收敛：node.inventory 是本设备 Workspace 的全量快照——清单未覆盖的
 * 行即 Node registry 已移除。无 Run 引用 → 删行（投影与 registry 镜像一致）；
 * 有引用 → 标 unavailable 并保留行（runs.workspaceId FK + 历史投影）。
 * 只作用于该设备自己的行（同 owner 的其他设备不受影响）。
 */
export async function convergeDeviceWorkspaceRemovals(
  handle: DbHandle,
  input: { deviceId: string; keepIds: readonly string[]; lastCheckedAt: Date },
): Promise<void> {
  const rows = await handle
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.deviceId, input.deviceId))
  for (const row of rows) {
    if (input.keepIds.includes(row.id)) continue
    const refs = await handle
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.workspaceId, row.id))
      .limit(1)
    if (refs.length === 0) {
      await handle.delete(workspaces).where(eq(workspaces.id, row.id))
    } else {
      await handle
        .update(workspaces)
        .set({ available: false, lastCheckedAt: input.lastCheckedAt })
        .where(eq(workspaces.id, row.id))
    }
  }
}

/** owner-scoped 不透明投影（03 §4：只返回当前 Member 自己的 Workspace）。 */
export async function listWorkspacesByOwner(
  handle: DbHandle,
  ownerUserId: string,
): Promise<
  Array<{
    id: string
    /** P1-13：Run Launcher 需要 workspace→device 配对（不透明 id，非路径）。 */
    deviceId: string
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
      deviceId: workspaces.deviceId,
      name: workspaces.name,
      kind: workspaces.kind,
      capabilities: workspaces.capabilities,
      available: workspaces.available,
      lastCheckedAt: workspaces.lastCheckedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, ownerUserId))
}
