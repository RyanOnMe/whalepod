import type { NodeDownstream } from '@whalepod/protocol'

/**
 * Hub → Device Node 的下行网关（02-第一阶段实施计划.md Task 10 Interfaces）。
 * send 成功只代表帧已写入 Node 连接；Node 的处理确认经 command.ack 上行，
 * 由 RunOrchestrator.ingestNodeEvent 落 Outbox acked_at（03 §2.6）。
 * 真实 WS 实现是 P1-09/13 的事；测试用 packages/testkit 的 FakeDeviceGateway。
 */
export interface DeviceGateway {
  send(deviceId: string, frame: NodeDownstream): Promise<DispatchAck>
}

export interface DispatchAck {
  sentAt: Date
}

/** 已通过 Device Token 认证的 Node 连接身份（真实实现由 P1-09 连接层提供）。 */
export interface AuthenticatedDevice {
  deviceId: string
  ownerUserId: string
}
