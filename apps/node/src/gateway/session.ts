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
import type { NodeDownstream } from '@project311/protocol'
import {
  heartbeatFrame,
  helloFrame,
  inventoryFrame,
  openHubSocket,
  type HelloFacts,
  type HubSocketOptions,
  type InventoryFacts,
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
  /**
   * P1-13：run 相关下行帧委托（run.start/run.cancel/approval.decide/
   * run.event_ack/run.resend_from）。node.token_revoked 由本模块先行处理，不委托。
   */
  readonly onFrame?: (frame: NodeDownstream) => void
  /** P1-13：连接（重）建立、hello 发出后回调——spool 全量补发的触发点（R1）。 */
  readonly onConnected?: () => void
  /** P1-13：心跳事实源（activeRunIds + lastEventSeqByRun，03 §6.2）。 */
  readonly heartbeatFacts?: () => {
    activeRunIds: string[]
    lastEventSeqByRun: Record<string, number>
  }
  /**
   * #103：心跳事实采集失败的归因回调（与 onInventoryError 同构）。
   * 缺省静默——但进程必须活着：本拍心跳跳过，Hub 侧设备陈旧判据自然兜底。
   */
  readonly onHeartbeatError?: (error: unknown) => void
  /**
   * #89：inventory 事实源。与 hello 同责——**每条连接建立后**（含重连）上报一次，
   * 因为 Hub 的 Workspace 投影只有这一个来源（03 §6.2）。缺省不上报。
   */
  readonly inventoryFacts?: () => Promise<InventoryFacts>
  /** #89：inventory 构建/发送失败的归因回调（缺省无操作）。 */
  readonly onInventoryError?: (error: unknown) => void
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

export function startDeviceSession(deps: DeviceSessionDeps): {
  stop: () => void
  /** P1-13 上行帧出口：仅当前连接 OPEN 时写出，否则丢弃（持久事件仍在 spool）。 */
  send: (frame: string) => void
} {
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
      // #103：事实采集抛错（SQLite 等本地 I/O）不得穿透定时器回调——
      // uncaughtException 会掀掉宿主进程。本拍跳过 + 归因，进程活着。
      let facts: { activeRunIds: string[]; lastEventSeqByRun: Record<string, number> } | undefined
      try {
        facts = deps.heartbeatFacts?.()
      } catch (error) {
        deps.onHeartbeatError?.(error)
        return
      }
      current.send(
        heartbeatFrame(
          deps.config.deviceId,
          facts?.activeRunIds ?? [],
          facts?.lastEventSeqByRun ?? {},
        ),
      )
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
            return
          }
          // P1-13：其余已认证下行帧委托运行会话层（RunManager）。
          deps.onFrame?.(frame)
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
      // P1-13/R1：连接（重）建立后补发 spool 里全部未 ack 事件。
      deps.onConnected?.()
      // #89：inventory 与 hello 同责——**每条**连接建立后上报一次（Hub 的
      // Workspace 投影只有这一个来源）。异步构建，失败只归因、不打断会话，
      // 由下条连接自然收敛。守卫：构建完成时该连接必须仍是当前活连接且 OPEN，
      // 否则丢帧（不得往已关闭/已被替换的 socket 上写）。
      if (deps.inventoryFacts !== undefined) {
        const me = current
        void deps
          .inventoryFacts()
          .then((facts) => {
            if (current === me && me !== undefined && me.readyState === 1) {
              me.send(inventoryFrame(deps.config.deviceId, facts))
            }
          })
          .catch((error: unknown) => {
            deps.onInventoryError?.(error)
          })
      }
    })
  }
  connect()

  return {
    /** P1-13 上行帧出口：仅当前连接 OPEN 时写出，否则丢弃（持久事件仍在 spool）。 */
    send: (frame: string) => {
      if (current !== undefined && current.readyState === 1) current.send(frame)
    },
    stop: () => {
      manuallyStopped = true
      clearIntervalFn(heartbeatTimer)
      if (reconnectTimer !== undefined) clearTimeoutFn(reconnectTimer)
      current?.close(1000, 'client stop')
      current = undefined
    },
  }
}
