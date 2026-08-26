import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { WebSocket as WsClient } from 'ws'
import type { NodeDownstream } from '@project311/protocol'

/** Hub 出站连接包装：认证升级 + 消息/关闭/错误回调。 */
export interface HubSocketHandlers {
  onMessage?: (frame: NodeDownstream) => void
  onClose?: (code: number, reason: string) => void
  onError?: (error: Error) => void
}

export interface HubSocketOptions {
  /** WS 子协议/headers 注入点（测试用）。 */
  WebSocketImpl?: typeof WsClient
}

/** 打开一条到 Hub 的已认证 Node 连接。 */
export function openHubSocket(
  hubUrl: string,
  deviceToken: string,
  handlers: HubSocketHandlers,
  options: HubSocketOptions = {},
): WebSocket {
  const url = `${hubUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws/v1/node`
  const socket = new (options.WebSocketImpl ?? WsClient)(url, {
    headers: { authorization: `Device ${deviceToken}` },
  })
  socket.on('message', (raw: unknown) => {
    try {
      handlers.onMessage?.(JSON.parse(String(raw)))
    } catch {
      // 非 JSON：忽略（协议层 Hub 侧已 fail-closed 断开）。
    }
  })
  socket.on('close', (code: number, reasonBuf: Buffer) => {
    handlers.onClose?.(code, String(reasonBuf))
  })
  socket.on('error', (error: Error) => {
    handlers.onError?.(error)
  })
  return socket
}

/** 构造上行 node.heartbeat 帧（10s 周期发送）。 */
export function heartbeatFrame(deviceId: string, activeRunIds: string[] = []): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'node.heartbeat',
    payload: { deviceId, activeRunIds, lastEventSeqByRun: {} },
  })
}
