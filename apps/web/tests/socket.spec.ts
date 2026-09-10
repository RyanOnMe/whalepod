/**
 * P1-08 TeamEventSocket 单元验收（node 环境、FakeWebSocket；02 Task 8、R2）。
 *
 * - 连接带 `?cursor=<已提交 cursor>`；
 * - 断线重连：指数退避 + full jitter（250ms → 30s 封顶）；
 * - control `resync.required` / 协议异常 → 快照重拉 + 光标重置 + 断开重连；
 * - handler 失败不重置光标（等修复后继续补发），不主动断连。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@whalepod/protocol'
import type { ClientFrame } from '@whalepod/protocol'
import { CursorStore } from '../src/shared/realtime/cursor-store.js'
import { TeamEventSocket } from '../src/shared/realtime/socket.js'
import type { WebSocketLike } from '../src/shared/realtime/socket.js'
import { controlFrame, persistentFrame } from './frames.js'

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  readonly url: string
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closedWith: { code: number; reason: string } | undefined

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  receive(data: unknown): void {
    this.onmessage?.({ data })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closedWith = { code, reason }
    this.onclose?.({ code, reason })
  }
}

function makeSocket(
  options: {
    cursorStore?: CursorStore
    onFrame?: (frame: ClientFrame) => void
    onResync?: (latestCursor?: string) => void
  } = {},
) {
  const cursorStore = options.cursorStore ?? new CursorStore()
  const onFrame = vi.fn((frame: ClientFrame) => options.onFrame?.(frame))
  const onResync = vi.fn((latestCursor?: string) => options.onResync?.(latestCursor))
  const socket = new TeamEventSocket({
    url: 'ws://hub.test/ws/v1/client',
    cursorStore,
    callbacks: { onFrame, onResync },
    WebSocketImpl: FakeWebSocket,
    random: () => 0.5, // 确定性 jitter：delay = 退避/2
  })
  return { socket, cursorStore, onFrame, onResync }
}

describe('TeamEventSocket (reconnect)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    FakeWebSocket.instances.length = 0
  })

  it('connects with the committed cursor in the URL', () => {
    const { socket, cursorStore } = makeSocket()
    cursorStore.commit('42')
    socket.connect()
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://hub.test/ws/v1/client?cursor=42')
  })

  it('reconnects after a drop with exponential backoff + full jitter, capped at 30s', async () => {
    const { socket } = makeSocket()
    socket.connect()
    FakeWebSocket.instances[0]?.open()
    // full jitter（random=0.5）：delay = min(30s, 250ms·2^n) / 2
    const expected = [125, 250, 500, 1000, 2000, 4000, 8000, 15000, 15000]
    for (const delay of expected) {
      const before = FakeWebSocket.instances.length
      FakeWebSocket.instances.at(-1)?.close(1006) // 断线
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(FakeWebSocket.instances.length).toBe(before) // 未到退避点不重连
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances.length).toBe(before + 1) // 到点立即重连
    }
  })

  it('forwards persistent frames and does not auto-reconnect while open', async () => {
    const { socket, onFrame } = makeSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.open()
    ws?.receive(JSON.stringify(persistentFrame('task.changed', { taskId: 't-1' }, '42')))
    await vi.advanceTimersByTimeAsync(0)
    expect(onFrame).toHaveBeenCalledTimes(1)
    const frame = onFrame.mock.calls[0]?.[0] as ClientFrame
    expect(frame.kind).toBe('persistent')
  })

  it('resync.required triggers the snapshot pull callback, resets the cursor and reconnects from 0', async () => {
    const { socket, cursorStore, onResync } = makeSocket()
    cursorStore.commit('77')
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.open()
    ws?.receive(JSON.stringify(controlFrame('99')))
    expect(onResync).toHaveBeenCalledWith('99')
    expect(cursorStore.load()).toBe('0') // 放弃过期光标
    expect(ws?.closedWith?.code).toBe(4000) // 断开当前连接
    await vi.advanceTimersByTimeAsync(125)
    const reconnected = FakeWebSocket.instances[1]
    expect(reconnected?.url).toContain('cursor=0') // 重连从保留窗口重放
  })

  it('an unknown frame is fail-closed: snapshot resync + cursor reset, no state change', async () => {
    const { socket, cursorStore, onResync, onFrame } = makeSocket()
    cursorStore.commit('77')
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.open()
    ws?.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: 'unknown-frame' }))
    expect(onFrame).not.toHaveBeenCalled() // 未改状态
    expect(onResync).toHaveBeenCalledWith(undefined) // 立即快照重拉
    expect(cursorStore.load()).toBe('0')
    expect(ws?.closedWith?.code).toBe(4000)
  })

  it('a failed onFrame handler triggers the snapshot resync callback without resetting the cursor', async () => {
    const { socket, cursorStore, onResync } = makeSocket({
      onFrame: () => {
        throw new Error('router exploded')
      },
    })
    cursorStore.commit('77')
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.open()
    ws?.receive(JSON.stringify(persistentFrame('task.changed', { taskId: 't-1' }, '42')))
    await vi.advanceTimersByTimeAsync(0)
    expect(onResync).toHaveBeenCalledWith(undefined) // 快照重拉治愈缓存
    expect(cursorStore.load()).toBe('77') // 不重置：等待 handler 修复后重放
    expect(ws?.closedWith).toBeUndefined() // 不主动断连
  })

  it('manual close stops reconnecting', async () => {
    const { socket } = makeSocket()
    socket.connect()
    FakeWebSocket.instances[0]?.open()
    socket.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
