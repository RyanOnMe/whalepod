import {
  nodeConnections,
  NodeOfflineError,
  type SourcePermissionCheckInput,
  type SourcePermissionSnapshot,
} from '../device/connection-registry.js'

/**
 * 来源绑定只依赖这一个只读面；生产用进程级连接注册表，集成测试走真实 WS。
 * 不把凭据或正文带进接口——只传槽位名与不透明资源身份。
 */
export interface SourceCollector {
  isOnline(deviceId: string): boolean
  requestSourcePermission(
    deviceId: string,
    input: SourcePermissionCheckInput,
    timeoutMs?: number,
  ): Promise<SourcePermissionSnapshot>
}

export const nodeSourceCollector: SourceCollector = nodeConnections

export { NodeOfflineError }
