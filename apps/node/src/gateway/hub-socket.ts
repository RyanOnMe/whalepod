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

/** Hub 对认证失败的应答是升级前 HTTP 401/403（非 WS 关闭码）：映射为 4401 交重连层判定停止。 */
const HTTP_AUTH_REJECT_CLOSE_CODE = 4401 as const

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
  // 升级被拒绝（非 101）：有监听器时 ws 不再自发 error/close，这里统一翻译为
  // onClose——401/403 映射 4401（永久，停止重连），其余按 1006 走退避重连。
  socket.on('unexpected-response', (_request: unknown, response: { statusCode?: number }) => {
    const status = response.statusCode ?? 0
    const code = status === 401 || status === 403 ? HTTP_AUTH_REJECT_CLOSE_CODE : 1006
    handlers.onClose?.(code, `unexpected-response ${status}`)
  })
  return socket
}

/** node.hello 上报的运行时事实（03 §6.2；pluginPackDigests 元素级 64-hex 由协议层校验）。 */
export interface HelloFacts {
  readonly nodeVersion: string
  readonly platform: 'darwin' | 'linux' | 'win32'
  readonly architecture: string
  /** 该 Node 的 DSH 发行版版本；未托管 DSH 时由 CLI 显式标注。 */
  readonly dshDistributionVersion: string
  readonly pluginPackDigests: string[]
}

/** 构造上行 node.hello 帧（连接建立后首发；03 §6.2）。 */
export function helloFrame(deviceId: string, facts: HelloFacts): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'node.hello',
    payload: {
      deviceId,
      nodeVersion: facts.nodeVersion,
      platform: facts.platform,
      architecture: facts.architecture,
      supportedProtocolVersions: [1],
      dshDistributionVersion: facts.dshDistributionVersion,
      pluginPackDigests: facts.pluginPackDigests,
    },
  })
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
