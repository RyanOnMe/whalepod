/**
 * Hub 侧 Workspace 投影（P1-12；03 §2.4 workspace、§4 GET /workspaces、02 Task 12 Step 3）。
 *
 * node.inventory 经两层校验后 upsert 不透明投影：
 * 1. 设备归属：inventory 只能来自该 Device 的活跃连接（identity 由 WS 层绑定）；
 * 2. owner 校验：投影归属恒等 Device owner（03 §2.4：workspace 永不转移）。
 * 每条 upsert 失败不拖垮整批（逐条 best-effort + 审计可查），保证 inventory 重放收敛。
 */
import type { Database } from '@whalepod/db'
import { convergeDeviceWorkspaceRemovals, upsertWorkspace } from '@whalepod/db'
import type { AuthenticatedDevice } from '../run/device-gateway.js'

export interface InventoryWorkspaceInput {
  readonly workspaceId: string
  readonly name: string
  readonly kind: 'directory' | 'git_repository'
  readonly capabilities: { readonly read: boolean; readonly write: boolean; readonly git: boolean }
  readonly available: boolean
  readonly lastCheckedAt: string
}

export interface DeviceInventoryDeps {
  readonly database: Database
  readonly warn?: (message: string, context: Record<string, unknown>) => void
}

export class WorkspaceInventoryIngest {
  constructor(private readonly deps: DeviceInventoryDeps) {}

  /**
   * 处理一条 node.inventory；返回成功 upsert 条数。逐条容错：
   * 单条形状/约束失败只跳过该条（Node 侧下轮 inventory 重放自然收敛）。
   */
  async ingest(
    device: AuthenticatedDevice,
    inventory: { workspaces: InventoryWorkspaceInput[] },
  ): Promise<number> {
    let upserted = 0
    const lastCheckedAt = new Date()
    for (const ws of inventory.workspaces) {
      try {
        await upsertWorkspace(this.deps.database.db, {
          id: ws.workspaceId,
          deviceId: device.deviceId,
          ownerUserId: device.ownerUserId,
          name: ws.name,
          kind: ws.kind,
          capabilities: { ...ws.capabilities },
          available: ws.available,
          lastCheckedAt,
        })
        upserted += 1
      } catch (error) {
        console.error('INVENTORY_FAIL', error)
        this.deps.warn?.('workspace inventory upsert failed', {
          deviceId: device.deviceId,
          workspaceId: ws.workspaceId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        })
      }
    }
    // #94 删除收敛：inventory 是全量快照——清单未覆盖的本设备行即 Node registry
    // 已移除（无 Run 引用删行、有引用标 unavailable；只动本设备的行）。
    // keepIds 取帧内清单而非成功 upsert 集：单条 upsert 失败不该把该行当「已移除」。
    await convergeDeviceWorkspaceRemovals(this.deps.database.db, {
      deviceId: device.deviceId,
      keepIds: inventory.workspaces.map((ws) => ws.workspaceId),
      lastCheckedAt,
    })
    return upserted
  }
}
