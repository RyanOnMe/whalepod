import { randomUUID } from 'node:crypto'
import { NodePreparationResultSchema, type PreparationFacts } from '@whalepod/protocol'
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
import type { NodeDownstream } from '@whalepod/protocol'
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
  /**
   * #352：hello 事实**按连接重算**（此前是启动时算好的一份冻结对象）——本地 preflight
   * 装/重建 pack 之后、或本机 DSH 换版之后，设备视图不该等 Node 重启才刷新。
   * 与 inventoryFacts 同形；返回 Promise 时 hello 发送前 await（顺序仍是 hello → spool 补发）。
   */
  readonly helloFacts: () => HelloFacts | Promise<HelloFacts>
  /** #352：hello 事实采集失败的归因回调（缺省同族 stderr warn；失败不打断会话）。 */
  readonly onHelloError?: (error: unknown) => void
  /** 收到 node.token_revoked 时的本地清理（删 config.json）。 */
  readonly onRevoked: () => void
  /** 永久退出（CLI 绑 process.exit；测试注入采集）。 */
  readonly exit: (code: number, message: string) => void
  /**
   * P1-13：run 相关下行帧委托（run.start/run.cancel/approval.decide/
   * run.event_ack/run.resend_from）。node.token_revoked 由本模块先行处理，不委托。
   */
  readonly preparationCheck?: (request: {
    workspaceId: string
    provider: string
    credentialSlot: string
  }) => Promise<PreparationFacts>
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
   * #112：缺省**不静默**——回落到结构化 stderr warn（component=node.session），
   * 调用方可覆盖不可遗忘（cli.ts 接的正是同形态结构化行）。
   */
  readonly onHeartbeatError?: (error: unknown) => void
  /**
   * #89：inventory 事实源。与 hello 同责——**每条连接建立后**（含重连）上报一次，
   * 因为 Hub 的 Workspace 投影只有这一个来源（03 §6.2）。缺省不上报。
   */
  readonly inventoryFacts?: () => Promise<InventoryFacts>
  /**
   * #94：inventory 变更指纹（如 registry 文件的 mtime/size 摘要）。与
   * inventoryFacts 配对注入后，心跳每拍探测一次：指纹变化即重报
   * node.inventory——「workspace add 后无需重启 node」的会话内收敛。
   * 不开新协议帧、不引 fs watch：检测成本是一拍一次 stat，重放收敛靠
   * Hub upsert 幂等。缺省不探测（行为退化为只连后上报）。
   */
  readonly inventoryRevision?: () => Promise<string>
  /** #89：inventory 构建/发送失败的归因回调（#112：缺省同族 stderr warn 兜底）。 */
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
  /** #352：会话内刷新 hello（重算事实；与本次连接已发的一致时不发）；无活连接时是 no-op。 */
  refreshHello: () => void
} {
  const setIntervalFn = deps.setIntervalImpl ?? setInterval
  const setTimeoutFn = deps.setTimeoutImpl ?? setTimeout
  const clearIntervalFn = deps.clearIntervalImpl ?? clearInterval
  const clearTimeoutFn = deps.clearTimeoutImpl ?? clearTimeout
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS

  // #112：归因回调缺省不静默——调用方忘接也有结构化 stderr 留痕（footgun 拆掉）。
  // stderr 自身写不进时无处可报，吞掉是唯一诚实选择（绝不能让兜底掀掉宿主进程）。
  const defaultWarn = (msg: string, error: unknown): void => {
    try {
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          component: 'node.session',
          msg,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      )
    } catch {
      // stderr 不可写：最后的出口也断了，保持进程活着。
    }
  }
  const onHeartbeatError =
    deps.onHeartbeatError ?? ((e: unknown) => defaultWarn('heartbeat_facts_failed', e))
  const onInventoryError =
    deps.onInventoryError ?? ((e: unknown) => defaultWarn('inventory_report_failed', e))
  const onHelloError = deps.onHelloError ?? ((e: unknown) => defaultWarn('hello_facts_failed', e))

  let current: SocketLike | undefined
  let attempt = 0
  let revoked = false
  let manuallyStopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  // #94：最近一次成功上报时的 inventory 指纹（首报时若注入 revision 源则入账）。
  let lastInventoryRevision: string | undefined

  // ---- #352：hello 事实的发送纪律（三件事，都在这一处收口）----
  // ① 归因回调不许掀宿主（#103/#112 同纪律）：采集或发送抛错只归因；
  // ② **序号单调**：连接建立与会话内刷新可能同时在飞（探针各要一次 spawn），
  //    旧快照后到会把 Hub 事实列写回旧值——只让序号 ≥ 已结算序号的采集落地；
  // ③ **同连接内事实未变不重发**（#94 的指纹口径）：Hub 每收一条 hello 会追加一条
  //    持久化 device.changed 团队事件，本地命中（没动盘）的 Run 不该制造这笔噪声。
  //    换连接（重连）时必须照发——那是 Hub 侧「设备在线」的信号面。
  let helloSeq = 0
  let lastEvaluatedHelloSeq = 0
  let lastSentHello: { socket: SocketLike; factsJson: string } | undefined
  const reportHelloFailure = (error: unknown): void => {
    try {
      onHelloError(error)
    } catch {
      // 归因回调自身抛错也不许穿透（最后的出口断了，保持进程活着）。
    }
  }
  const sendHello = (socket: SocketLike): void => {
    const seq = (helloSeq += 1)
    void (async () => {
      let facts: HelloFacts
      try {
        facts = await deps.helloFacts()
      } catch (error) {
        // 失败不打断会话（同 inventory 口径）：本连接跳过 hello，等下条连接自然收敛。
        reportHelloFailure(error)
        return
      }
      if (seq < lastEvaluatedHelloSeq) return // 更新的快照已结算：旧的不许覆盖
      lastEvaluatedHelloSeq = seq
      if (current !== socket || socket.readyState !== 1) return
      const factsJson = JSON.stringify(facts)
      if (lastSentHello?.socket === socket && lastSentHello.factsJson === factsJson) return
      lastSentHello = { socket, factsJson }
      socket.send(helloFrame(deps.config.deviceId, facts))
    })().catch((error: unknown) => {
      reportHelloFailure(error)
    })
  }

  // #94：指纹变化才重建+重报；与连接后首报共用同一份连接守卫纪律（构建完成时
  // 该连接必须仍是当前活连接且 OPEN）。任何失败只归因、不穿透定时器回调（#103）。
  const maybeReportInventoryChange = (): void => {
    if (deps.inventoryFacts === undefined || deps.inventoryRevision === undefined) return
    const me = current
    if (me === undefined || me.readyState !== 1) return
    void (async () => {
      const revision = await deps.inventoryRevision!()
      if (revision === lastInventoryRevision) return
      const facts = await deps.inventoryFacts!()
      if (current !== me || me.readyState !== 1) return // 连接已换/已关：丢帧，下拍自然收敛
      me.send(inventoryFrame(deps.config.deviceId, facts))
      lastInventoryRevision = revision
    })().catch((error: unknown) => {
      onInventoryError(error)
    })
  }

  const heartbeatTimer = setIntervalFn(() => {
    // 会话级单一定时器：跨重连存活，只打当前 OPEN 连接。
    if (current !== undefined && current.readyState === 1) {
      // #103：事实采集抛错（SQLite 等本地 I/O）不得穿透定时器回调——
      // uncaughtException 会掀掉宿主进程。本拍跳过 + 归因，进程活着。
      let facts: { activeRunIds: string[]; lastEventSeqByRun: Record<string, number> } | undefined
      try {
        facts = deps.heartbeatFacts?.()
      } catch (error) {
        onHeartbeatError(error)
        return
      }
      current.send(
        heartbeatFrame(
          deps.config.deviceId,
          facts?.activeRunIds ?? [],
          facts?.lastEventSeqByRun ?? {},
        ),
      )
      // #94：心跳节拍顺带探测 inventory 指纹——变化时重报（不株连心跳本身）。
      maybeReportInventoryChange()
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
          if (frame.type === 'node.preparation_check') {
            // 检查与响应均留在当前连接；断线/替换后不把旧结果发到另一条连接。
            const checkedSocket = socket
            void deps
              .preparationCheck?.(frame.payload)
              .then((facts) => {
                if (
                  current !== (checkedSocket as unknown as SocketLike) ||
                  checkedSocket.readyState !== 1
                )
                  return
                checkedSocket.send(
                  JSON.stringify(
                    NodePreparationResultSchema.parse({
                      protocolVersion: 1,
                      messageId: randomUUID(),
                      sentAt: new Date().toISOString(),
                      type: 'node.preparation_result',
                      payload: { requestId: frame.payload.requestId, ...facts },
                    }),
                  ),
                )
              })
              .catch(() => {
                // 无检查器/失败即沉默，由Hub超时给出“未确认”；不记录敏感本机错误。
              })
            return
          }
          // P1-13：其余已认证下行帧委托运行会话层（RunManager）。
          deps.onFrame?.(frame)
        },
        onClose: (code, reason) => {
          if (current !== (socket as unknown as SocketLike)) return // 旧连接事件忽略
          current = undefined
          if (revoked) {
            deps.exit(1, 'device token revoked; run `whalepod-node pair` to re-pair')
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
      const me = current
      // #352：hello 事实**当场重算**（可能 await），再按 hello → spool 补发 → inventory
      // 的既有次序发帧。守卫（当前活连接 + OPEN + 序号单调）在 sendHello 内统一收口。
      void (async () => {
        if (me === undefined || me.readyState !== 1 || current !== me) return
        sendHello(me)
        // P1-13/R1：连接（重）建立后补发 spool 里全部未 ack 事件。
        deps.onConnected?.()
        // #89：inventory 与 hello 同责——**每条**连接建立后上报一次（Hub 的
        // Workspace 投影只有这一个来源）。异步构建，失败只归因、不打断会话，
        // 由下条连接自然收敛。
        if (deps.inventoryFacts !== undefined) {
          try {
            // #94：指纹在构建前取——构建读到的是更新的 registry 时，旧指纹入账后
            // 下一拍会再报一次（多报无害，漏报才有害）。
            const revision = await deps.inventoryRevision?.()
            const facts = await deps.inventoryFacts()
            if (current === me && me.readyState === 1) {
              me.send(inventoryFrame(deps.config.deviceId, facts))
              lastInventoryRevision = revision
            }
          } catch (error) {
            onInventoryError(error)
          }
        }
      })().catch((error: unknown) => {
        onHelloError(error)
      })
    })
  }
  connect()

  return {
    /** P1-13 上行帧出口：仅当前连接 OPEN 时写出，否则丢弃（持久事件仍在 spool）。 */
    send: (frame: string) => {
      if (current !== undefined && current.readyState === 1) current.send(frame)
    },
    /**
     * #352：**会话内刷新 hello**（重算事实）——本地 preflight 装/重建 pack 之后调用，
     * 设备视图不等重连/重启就刷新（Hub 收 hello 即回填事实列并发 device.changed）。
     * 事实与本次连接已发的一致时**不发**（本地命中的 Run 不该制造空转的团队事件，
     * #94 同口径）；无活连接时什么都不做（下条连接的 hello 本就会重算）。
     */
    refreshHello: () => {
      const me = current
      if (me === undefined || me.readyState !== 1) return
      sendHello(me)
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
