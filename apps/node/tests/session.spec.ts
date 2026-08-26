/**
 * 出站会话循环（gateway/session.ts）单测：FakeSocket + 手动定时器。
 * 覆盖 review 修复点：连接首发 node.hello（帧过协议 parseNodeFrame 验证）、
 * 心跳周期真实发送、永久关闭（4401/4008/token_revoked）停止重连、普通断线退避重连。
 */
import { describe, expect, it } from 'vitest'
import { parseNodeFrame } from '@project311/protocol'
import { startDeviceSession } from '../src/gateway/session.js'
import type { HelloFacts } from '../src/gateway/hub-socket.js'
import type { NodeConfig } from '../src/config.js'

const DEVICE_ID = '018f8f8f-8f8f-7a8f-8f8f-8f8f8f8f8f8f'

const config: NodeConfig = {
  hubUrl: 'http://hub.local:8080',
  deviceId: DEVICE_ID,
  deviceToken: 'test-device-token',
}

const facts: HelloFacts = {
  nodeVersion: 'v24.12.0',
  platform: 'darwin',
  architecture: 'arm64',
  dshDistributionVersion: '0.1.0-rc.8',
  pluginPackDigests: [],
}

type Handler = (...args: never[]) => void

class FakeSocket {
  static instances: FakeSocket[] = []
  static reset(): void {
    FakeSocket.instances = []
  }
  readyState = 0
  readonly sent: string[] = []
  closedWith: { code: number; reason: string } | undefined
  private readonly handlers = new Map<string, Handler[]>()

  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    FakeSocket.instances.push(this)
  }

  on(event: string, fn: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
    return this
  }

  once(event: string, fn: Handler): this {
    return this.on(event, fn)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.closedWith = { code, reason }
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  emit(event: string, ...args: never[]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(...args)
  }

  emitOpen(): void {
    this.readyState = 1
    this.emit('open')
  }

  emitMessage(frame: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(frame))
  }

  emitClose(code: number, reason = ''): void {
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  emitUnexpectedResponse(statusCode: number): void {
    this.emit('unexpected-response', {}, { statusCode })
  }
}

interface FakeTimers {
  intervals: Array<{ fn: () => void; ms: number; cancelled: boolean }>
  timeouts: Array<{ fn: () => void; ms: number; cancelled: boolean }>
}

function makeDeps(overrides: {
  exit?: (code: number, message: string) => void
  onRevoked?: () => void
}) {
  const timers: FakeTimers = { intervals: [], timeouts: [] }
  const exits: Array<{ code: number; message: string }> = []
  const deps = {
    config,
    facts,
    onRevoked: overrides.onRevoked ?? (() => {}),
    exit: overrides.exit ?? ((code: number, message: string) => exits.push({ code, message })),
    WebSocketImpl: FakeSocket as never,
    random: () => 0,
    heartbeatMs: 10_000,
    baseDelayMs: 250,
    maxDelayMs: 30_000,
    setIntervalImpl: ((fn: () => void, ms: number) => {
      const h = { fn, ms, cancelled: false }
      timers.intervals.push(h)
      return h
    }) as unknown as typeof setInterval,
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      const h = { fn, ms, cancelled: false }
      timers.timeouts.push(h)
      return h
    }) as unknown as typeof setTimeout,
    clearIntervalImpl: ((h: { cancelled: boolean }) => {
      h.cancelled = true
    }) as unknown as typeof clearInterval,
    clearTimeoutImpl: ((h: { cancelled: boolean }) => {
      h.cancelled = true
    }) as unknown as typeof clearTimeout,
  }
  return { deps, timers, exits }
}

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
  if (socket === undefined) throw new Error('no socket created')
  return socket
}

describe('startDeviceSession', () => {
  it('连接建立后首发 node.hello（帧过协议 schema），随后心跳按周期发送', () => {
    FakeSocket.reset()
    const { deps, timers } = makeDeps({})
    const session = startDeviceSession(deps)
    const socket = latestSocket()
    expect(socket.url).toBe('ws://hub.local:8080/ws/v1/node')
    expect((socket.options as { headers: Record<string, string> }).headers.authorization).toBe(
      `Device ${config.deviceToken}`,
    )

    socket.emitOpen()
    expect(socket.sent).toHaveLength(1)
    const hello = parseNodeFrame(JSON.parse(socket.sent[0] ?? ''), 'upstream')
    expect(hello.type).toBe('node.hello')
    if (hello.type === 'node.hello') {
      expect(hello.payload.deviceId).toBe(DEVICE_ID)
      expect(hello.payload.dshDistributionVersion).toBe('0.1.0-rc.8')
      expect(hello.payload.supportedProtocolVersions).toEqual([1])
    }

    // 心跳由会话级定时器驱动：每个周期一帧，只在 OPEN 时发。
    timers.intervals[0]?.fn()
    timers.intervals[0]?.fn()
    expect(socket.sent).toHaveLength(3)
    const heartbeat = parseNodeFrame(JSON.parse(socket.sent[1] ?? ''), 'upstream')
    expect(heartbeat.type).toBe('node.heartbeat')
    session.stop()
  })

  it('4401（升级前 HTTP 401 映射）永久失败：退出且不调度重连', () => {
    FakeSocket.reset()
    const { deps, timers, exits } = makeDeps({})
    startDeviceSession(deps)
    latestSocket().emitUnexpectedResponse(401)
    expect(exits).toHaveLength(1)
    expect(exits[0]?.code).toBe(1)
    expect(timers.timeouts).toHaveLength(0)
  })

  it('4008（被替换/被撤销）永久失败：退出且不调度重连', () => {
    FakeSocket.reset()
    const { deps, timers, exits } = makeDeps({})
    startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    socket.emitClose(4008, 'replaced by a newer connection')
    expect(exits).toHaveLength(1)
    expect(timers.timeouts).toHaveLength(0)
  })

  it('node.token_revoked：先清本地 Token，close 后退出不重连', () => {
    FakeSocket.reset()
    let revokedCalls = 0
    const { deps, timers, exits } = makeDeps({ onRevoked: () => (revokedCalls += 1) })
    startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    socket.emitMessage({
      protocolVersion: 1,
      messageId: '018f8f8f-8f8f-7a8f-8f8f-8f8f8f8f8f90',
      sentAt: new Date().toISOString(),
      type: 'node.token_revoked',
      payload: { reason: 'device token revoked' },
    })
    expect(revokedCalls).toBe(1)
    expect(socket.closedWith?.code).toBe(1000)
    expect(exits).toHaveLength(1)
    expect(exits[0]?.message).toContain('revoked')
    expect(timers.timeouts).toHaveLength(0)
  })

  it('普通断线（1006）：按退避调度重连，新连接重发 hello', () => {
    FakeSocket.reset()
    const { deps, timers, exits } = makeDeps({})
    startDeviceSession(deps)
    const first = latestSocket()
    first.emitOpen()
    expect(first.sent).toHaveLength(1)
    first.emitClose(1006, 'abnormal')
    expect(exits).toHaveLength(0)
    expect(timers.timeouts).toHaveLength(1)
    expect(timers.timeouts[0]?.ms).toBe(250)

    timers.timeouts[0]?.fn()
    expect(FakeSocket.instances).toHaveLength(2)
    const second = latestSocket()
    second.emitOpen()
    expect(second.sent).toHaveLength(1)
    const hello = parseNodeFrame(JSON.parse(second.sent[0] ?? ''), 'upstream')
    expect(hello.type).toBe('node.hello')
  })
})
