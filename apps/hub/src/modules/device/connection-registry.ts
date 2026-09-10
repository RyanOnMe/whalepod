/**
 * Node 连接注册表（每进程单例）：deviceId → 唯一活跃连接。
 * 不变量：同一 Device 只允许一条连接，新连接以 4008 替换旧连接（02 Task 9 Step 4）；
 * 撤销时下发 node.token_revoked 并以 4008 关闭（Step 6）。
 */
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { AuthenticatedDevice } from '../run/device-gateway.js'
import type { NodeDownstream } from '@whalepod/protocol'

export interface NodeConnection extends AuthenticatedDevice {
  readonly socket: WebSocket
}

/** 瞬时错误（离线等）：OutboxWorker 按退避重投，不置终态。 */
export class NodeOfflineError extends Error {
  constructor(message = 'node connection is not online') {
    super(message)
    this.name = 'NodeOfflineError'
  }
}

function envelope(type: NodeDownstream['type'], payload: unknown): NodeDownstream {
  // 下行帧构造与 OutboxWorker.buildFrame 同形；此处 payload 已是协议形状。
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  } as NodeDownstream
}

export class NodeConnectionRegistry {
  private readonly byDevice = new Map<string, NodeConnection>()

  /** 注册新连接；同 Device 旧连接以 4008 替换。返回是否为新挂载。 */
  attach(connection: NodeConnection): void {
    const previous = this.byDevice.get(connection.deviceId)
    if (previous !== undefined && previous.socket !== connection.socket) {
      previous.socket.close(4008, 'replaced by a newer connection')
    }
    this.byDevice.set(connection.deviceId, connection)
    connection.socket.once('close', () => {
      if (this.byDevice.get(connection.deviceId)?.socket === connection.socket) {
        this.byDevice.delete(connection.deviceId)
      }
    })
  }

  detach(deviceId: string, socket: WebSocket): void {
    if (this.byDevice.get(deviceId)?.socket === socket) this.byDevice.delete(deviceId)
  }

  isOnline(deviceId: string): boolean {
    const connection = this.byDevice.get(deviceId)
    return connection !== undefined && connection.socket.readyState === connection.socket.OPEN
  }

  /** 下发任意合法下行帧；离线抛瞬时错误由调用方分类。 */
  send(deviceId: string, frame: NodeDownstream): void {
    const connection = this.byDevice.get(deviceId)
    if (connection === undefined || connection.socket.readyState !== connection.socket.OPEN) {
      throw new NodeOfflineError()
    }
    connection.socket.send(JSON.stringify(frame))
  }

  /** 撤销推送（03 §6.3 node.token_revoked）：先发帧再以 4008 断开并摘除。 */
  pushTokenRevokedAndClose(deviceId: string, reason: string): boolean {
    const connection = this.byDevice.get(deviceId)
    if (connection === undefined) return false
    try {
      connection.socket.send(JSON.stringify(envelope('node.token_revoked', { reason })))
    } catch {
      // 发送失败不阻碍关闭。
    }
    connection.socket.close(4008, 'token revoked')
    this.byDevice.delete(deviceId)
    return true
  }
}

/** 进程级单例：HTTP revoke 路由与 WS 层共享同一份连接事实。 */
export const nodeConnections = new NodeConnectionRegistry()
