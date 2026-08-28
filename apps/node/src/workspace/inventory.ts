/**
 * node.inventory 构建器（P1-12；03 §6.2 NodeInventorySchema、02 Task 12 Step 3）。
 *
 * Node 是本地事实源：对每个注册 Workspace 做 resolve preflight（available），
 * capabilities 按真实状态（read 恒真；write 视目录可写；git 视 .git 存在）；
 * credentialSlots 只报「本机可服务的 slot 名」（本地 secrets.json 已配置项 + 环境变量
 * 已注入项不可枚举，由 run.start spawn 前的 resolve 兜底），绝不包含任何明文。
 */
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecretStore } from '../secret/store.js'
import type { WorkspaceRegistry } from './registry.js'

export interface InventoryWorkspace {
  readonly workspaceId: string
  readonly name: string
  readonly kind: 'directory' | 'git_repository'
  readonly capabilities: { readonly read: boolean; readonly write: boolean; readonly git: boolean }
  readonly available: boolean
  readonly lastCheckedAt: string
}

export interface InventoryPayload {
  readonly workspaces: InventoryWorkspace[]
  readonly credentialSlots: Array<{ readonly provider: string; readonly slot: string }>
}

export class WorkspaceInventory {
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly secrets: SecretStore,
  ) {}

  async build(): Promise<InventoryPayload> {
    const lastCheckedAt = new Date().toISOString()
    const workspaces: InventoryWorkspace[] = []
    for (const ws of await this.registry.list()) {
      let available = true
      try {
        await this.registry.resolve(ws.id)
      } catch {
        available = false
      }
      let writable = false
      if (available) {
        try {
          await access(ws.canonicalPath, constants.W_OK)
          writable = true
        } catch {
          writable = false
        }
      }
      workspaces.push({
        workspaceId: ws.id,
        name: ws.name,
        kind: ws.kind,
        capabilities: { read: true, write: writable, git: ws.kind === 'git_repository' },
        available,
        lastCheckedAt,
      })
    }
    const credentialSlots = (await this.secrets.configuredSlots()).map(({ provider, slot }) => ({
      provider,
      slot,
    }))
    return { workspaces, credentialSlots }
  }
}
