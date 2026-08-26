/**
 * Node 出站会话循环（02 Task 9 Step 5；03 §6）。
 *
 * 职责（cli.ts 只负责进程绑定，本模块可测）：
 * - 连接建立后**首发 node.hello**（回填 #37 运行时事实列），随后每 heartbeatMs
 *   发 node.heartbeat 维持设备租约（30s 窗口，03 §3.2）；
 * - 断线按 nextBackoffMs 退避重连；
 * - 永久失败停止：升级前 HTTP 401/403（hub-socket 映射为 4401）、4008（被替换/
 *   被撤销）、收到 node.token_revoked（先清本地 Token 再退出）——绝不拿陈旧
 *   凭证无限重试。
 */
import type { NodeConfig } from '../config.js'
import {
  heartbeatFrame,
  helloFrame,
  openHubSocket,
  type HelloFacts,
  type HubSocketOptions,
} from './hub-socket.js'
import { nextBackoffMs, shouldStopReconnect } from './reconnect.js'

export const HEARTBEAT_INTERVAL_MS = 10_000 as const

export interface DeviceSessionDeps {
  readonly config: NodeConfig
  readonly facts: HelloFacts
  /** 收到 node.token_revoked 时的本地清理（删 config.json）。 */
  readonly onRevoked: () => void
  /** 永久退出（CLI 绑 process.exit；测试注入采集）。 */
  readonly exit: (code: number, message: string) => void
  readonly WebSocketImpl?: HubSocketOptions['WebSocketImpl']
  readonly random?: () => number
  readonly heartbeatMs?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly setIntervalImpl?: typeof setInterval
  readonly setTimeoutImpl?: typeof setTimeout
  readonly clearIntervalImpl?: typeof clearInterval
  readonly clearTimeoutImpl?: typeof clearTimeout
}

interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

export function startDeviceSession(deps: DeviceSessionDeps): { stop: () => void } {
  const setIntervalFn = deps.setIntervalImpl ?? setInterval
  const setTimeoutFn = deps.setTimeoutImpl ?? setTimeout
  const clearIntervalFn = deps.clearIntervalImpl ?? clearInterval
  const clearTimeoutFn = deps.clearTimeoutImpl ?? clearTimeout
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS

  let current: SocketLike | undefined
  let attempt = 0
  let revoked = false
  let manuallyStopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const heartbeatTimer = setIntervalFn(() => {
    // 会话级单一定时器：跨重连存活，只打当前 OPEN 连接。
    if (current !== undefined && current.readyState === 1) {
      current.send(heartbeatFrame(deps.config.deviceId))
    }
  }, heartbeatMs)

  const connect = (): void => {
    const socket = openHubSocket(
      deps.config.hubUrl,
      deps.config.deviceToken,
      {
        onMessage: (frame) => {
          if (frame.type === 'node.token_revoked') {
            // 先标记再清理：随后到来的 close（1000 自发或 4008 对端）直接退出，不重连。
            revoked = true
            deps.onRevoked()
            current?.close(1000, 'token revoked locally')
          }
        },
        onClose: (code, reason) => {
          if (current !== (socket as unknown as SocketLike)) return // 旧连接事件忽略
          current = undefined
          if (revoked) {
            deps.exit(1, 'device token revoked; run `project311-node pair` to re-pair')
            return
          }
          if (shouldStopReconnect(code)) {
            deps.exit(1, `permanent close ${code} (${reason}); re-pair required`)
            return
          }
          if (manuallyStopped) return
          const delay = nextBackoffMs(attempt, deps.random)
          attempt += 1
          reconnectTimer = setTimeoutFn(connect, delay)
        },
        onError: () => {
          // 网络错误后必跟 close/unexpected-response，由 onClose 统一调度。
        },
      },
      deps.WebSocketImpl === undefined ? {} : { WebSocketImpl: deps.WebSocketImpl },
    )
    current = socket as unknown as SocketLike
    socket.once('open', () => {
      attempt = 0
      // 先 hello（运行时事实）再进入心跳周期（首个心跳由定时器触发）。
      socket.send(helloFrame(deps.config.deviceId, deps.facts))
    })
  }
  connect()

  return {
    stop: () => {
      manuallyStopped = true
      clearIntervalFn(heartbeatTimer)
      if (reconnectTimer !== undefined) clearTimeoutFn(reconnectTimer)
      current?.close(1000, 'client stop')
      current = undefined
    },
  }
}
