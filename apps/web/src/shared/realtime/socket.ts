/**
 * P1-08 Browser WS 重连包装（02 Task 8、R2：断线 5 秒 → 指针补发；直播 delta 可丢）。
 *
 * - 每次连接带 `?cursor=<已提交 cursor>`；重连复用 CursorStore 当前值。
 * - 断线重连：指数退避 + full jitter（250ms → 30s），连续失败按 2^n 放大、封顶。
 * - control `resync.required` / 协议异常：触发注入的 onResync（上层全量快照重拉）、
 *   放弃本地 cursor（reset 为 '0'，重放 24h 保留窗口）并断开重连；否则会陷入
 *   “旧 cursor → 服务端再次 resync”的无限循环。
 * - 帧一律过 parseClientFrame（fail-closed）；未知帧不改任何状态。
 */
import { parseClientFrame } from '@whalepod/protocol'
import type { ClientFrame } from '@whalepod/protocol'
import type { CursorStore } from './cursor-store.js'

export interface TeamEventSocketCallbacks {
  /** 已解析帧交给上层（event-router）；失败时上层不推进 cursor。 */
  onFrame(frame: ClientFrame): void | Promise<void>
  /** resync.required / 协议异常 → 上层全量快照重拉。latestCursor 为服务端提示（可能缺失）。 */
  onResync(latestCursor?: string): void
}

/** 最小 WebSocket 结构（tsconfig 无 DOM lib，测试注入 FakeWebSocket 无需真实实现）。 */
export interface WebSocketLike {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(code?: number, reason?: string): void
}

export type WebSocketCtor = new (url: string) => WebSocketLike

export const DEFAULT_BASE_DELAY_MS = 250
export const DEFAULT_MAX_DELAY_MS = 30_000

export interface TeamEventSocketOptions {
  /** ws(s)://…/ws/v1/client（不含 query；cursor 由本模块追加）。 */
  readonly url: string
  readonly cursorStore: CursorStore
  readonly callbacks: TeamEventSocketCallbacks
  /** 测试注入 FakeWebSocket；缺省用运行时全局（浏览器/Node ≥22）。 */
  readonly WebSocketImpl?: WebSocketCtor
  readonly random?: () => number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
}

export class TeamEventSocket {
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly random: () => number
  private readonly WebSocketImpl: WebSocketCtor
  private current: WebSocketLike | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private manuallyClosed = true

  constructor(private readonly options: TeamEventSocketOptions) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.random = options.random ?? Math.random
    this.WebSocketImpl =
      options.WebSocketImpl ?? (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket
  }

  /** 建立（或恢复）连接；之后断线自动按退避重连。 */
  connect(): void {
    this.manuallyClosed = false
    this.clearTimer()
    this.open()
  }

  /** 手动关闭：不再自动重连。 */
  close(): void {
    this.manuallyClosed = true
    this.clearTimer()
    this.current?.close(1000, 'client-close')
    this.current = undefined
  }

  private open(): void {
    const cursor = encodeURIComponent(this.options.cursorStore.load())
    const ws = new this.WebSocketImpl(`${this.options.url}?cursor=${cursor}`)
    this.current = ws
    ws.onopen = () => {
      this.reconnectAttempts = 0
    }
    ws.onmessage = (event) => {
      this.handleMessage(event.data)
    }
    ws.onclose = () => {
      // 手动 close 已顶掉 current：旧 socket 的 close 事件不触发重连。
      if (this.current !== ws) return
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // 网络错误后必跟 close 事件，由 onclose 统一调度重连。
    }
  }

  private handleMessage(raw: unknown): void {
    let frame: ClientFrame
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      frame = parseClientFrame(parsed)
    } catch {
      // 协议层 fail-closed：未登记/畸形帧不改状态，立即快照重拉 + 断开重连。
      this.options.callbacks.onResync(undefined)
      this.options.cursorStore.reset()
      this.closeCurrent(4000, 'protocol-error')
      return
    }
    if (frame.kind === 'control') {
      this.options.callbacks.onResync(frame.latestCursor)
      this.options.cursorStore.reset()
      this.closeCurrent(4000, 'resync.required')
      return
    }
    // persistent/live：交上层处理；handler 失败不推进 cursor，提示快照重拉。
    Promise.resolve()
      .then(() => this.options.callbacks.onFrame(frame))
      .catch(() => {
        this.options.callbacks.onResync(undefined)
      })
  }

  private closeCurrent(code: number, reason: string): void {
    this.current?.close(code, reason)
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.reconnectAttempts)
    const delay = Math.floor(this.random() * exponential) // full jitter
    this.reconnectAttempts += 1
    this.clearTimer()
    this.reconnectTimer = setTimeout(() => {
      this.open()
    }, delay)
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}
