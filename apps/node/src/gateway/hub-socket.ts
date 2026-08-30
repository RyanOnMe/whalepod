import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { WebSocket as WsClient } from 'ws'
import {
  parseNodeFrame,
  ProtocolError,
  RunSnapshotSchema,
  type NodeDownstream,
  type ProjectedRunEvent,
  type RunSnapshot,
} from '@project311/protocol'

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
    // 下行帧入口 fail-closed（§11，M2）：必须过协议 wire schema 才派发。
    // 非法帧丢弃并记结构化日志（只记 wire 码，绝不携带原始帧内容——其字段
    // 攻击者可控）；不崩进程、不断连接（Hub 侧独立裁决）。
    let frame: NodeDownstream
    try {
      frame = parseNodeFrame(JSON.parse(String(raw)), 'downstream')
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : 'VALIDATION_FAILED'
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          component: 'node.gateway',
          msg: 'downstream frame rejected by wire schema',
          code,
        })}\n`,
      )
      return
    }
    handlers.onMessage?.(frame)
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
export function heartbeatFrame(
  deviceId: string,
  activeRunIds: string[] = [],
  lastEventSeqByRun: Record<string, number> = {},
): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'node.heartbeat',
    payload: { deviceId, activeRunIds, lastEventSeqByRun },
  })
}

// ---------- P1-13：run 事件上行帧构造（03 §6.2/§6.4） ----------

/** 通用上行帧信封（messageId/sentAt 每次新发；载荷由 spool 原样携带，保证重发同 (runId,seq)）。 */
function upstreamFrame(type: string, payload: unknown): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  })
}

/** run.event：spool 里的 payload 是完整 ProjectedRunEvent JSON（含 seq）。 */
export function runEventFrame(payload: ProjectedRunEvent): string {
  return upstreamFrame('run.event', payload)
}

/** run.live_delta：owner-only 直播文本（不持久、不占 spool）。 */
export function runLiveDeltaFrame(runId: string, deltaSeq: number, text: string): string {
  return upstreamFrame('run.live_delta', { runId, deltaSeq, text })
}

/**
 * run.snapshot（P1-16）：Node 面向 Hub 的 Run 投影（§6.2）——status_request 的
 * 应答与「Runtime 消失」的主动上报（R9：孤儿处理后 lost(RUNTIME_LOST)）。
 * 载荷先过 RunSnapshotSchema（fail-closed 对称侧），绝不写出 schema 外字段。
 */
export function runSnapshotFrame(snapshot: RunSnapshot): string {
  return upstreamFrame('run.snapshot', RunSnapshotSchema.parse(snapshot))
}

/** command.ack：run.start/run.cancel/approval.decide 的处理确认（§6.2）。 */
export function commandAckFrame(
  commandId: string,
  accepted: boolean,
  error?: { code: string; message: string },
): string {
  return upstreamFrame('command.ack', {
    commandId,
    accepted,
    ...(error !== undefined ? { error } : {}),
  })
}
