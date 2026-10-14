import type { PreparationFacts } from '@whalepod/protocol'
import type { WorkspaceRegistry } from './registry.js'
import type { SecretStore } from '../secret/store.js'

/** 与实际启动共用本机 resolve；不调用模型、Runtime 或工具，不返回敏感错误。 */
export async function checkPreparation(
  request: { workspaceId: string; provider: string; credentialSlot: string },
  deps: { registry: WorkspaceRegistry; secrets: SecretStore },
): Promise<PreparationFacts> {
  let workspace: PreparationFacts['workspace'] = 'unconfirmed'
  let credential: PreparationFacts['credential'] = 'unconfirmed'
  try {
    await deps.registry.resolve(request.workspaceId)
    workspace = 'available'
  } catch {
    workspace = 'unavailable'
  }
  try {
    const secret = deps.secrets.resolve(request.provider, request.credentialSlot)
    credential = typeof secret === 'string' && secret.length > 0 ? 'configured' : 'unconfigured'
  } catch {
    credential = 'unconfirmed'
  }
  return { workspace, credential }
}
