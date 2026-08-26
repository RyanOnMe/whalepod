import type { NodeDownstream } from '@project311/protocol'
import type { DeviceGateway, DispatchAck } from '../run/device-gateway.js'
import { nodeConnections, type NodeConnectionRegistry } from './connection-registry.js'

/**
 * 真实下行网关：经 NodeConnectionRegistry 投递下行帧。
 * 离线（无连接或已关）同步抛 NodeOfflineError——OutboxWorker 把非 permanent 错误
 * 视为瞬时：行按退避推远，留待设备重连后下一轮重投（不置 failed_at）。
 * registry 默认取进程单例，亦可注入测试用实例。
 */
export class WsDeviceGateway implements DeviceGateway {
  constructor(private readonly registry: NodeConnectionRegistry = nodeConnections) {}

  async send(deviceId: string, frame: NodeDownstream): Promise<DispatchAck> {
    const sentAt = new Date()
    this.registry.send(deviceId, frame)
    return { sentAt }
  }
}
