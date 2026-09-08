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
  heartbeatFacts?: () => { activeRunIds: string[]; lastEventSeqByRun: Record<string, number> }
  onHeartbeatError?: (error: unknown) => void
}) {
  const timers: FakeTimers = { intervals: [], timeouts: [] }
  const exits: Array<{ code: number; message: string }> = []
  const deps = {
    config,
    facts,
    onRevoked: overrides.onRevoked ?? (() => {}),
    ...(overrides.heartbeatFacts !== undefined ? { heartbeatFacts: overrides.heartbeatFacts } : {}),
    ...(overrides.onHeartbeatError !== undefined
      ? { onHeartbeatError: overrides.onHeartbeatError }
      : {}),
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

  it('#103：heartbeatFacts 抛错不穿透定时器回调——归因 onHeartbeatError、本拍跳过、下拍恢复', () => {
    FakeSocket.reset()
    const errors: unknown[] = []
    let shouldThrow = true
    const { deps, timers } = makeDeps({
      heartbeatFacts: () => {
        if (shouldThrow) throw new Error('sqlite boom')
        return { activeRunIds: [], lastEventSeqByRun: {} }
      },
      onHeartbeatError: (error) => errors.push(error),
    })
    startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    expect(socket.sent).toHaveLength(1) // hello

    // 红：修前这一行直接 throw 出定时器回调（真实进程=uncaughtException 掀宿主）。
    expect(() => timers.intervals[0]?.fn()).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(String((errors[0] as Error).message)).toContain('sqlite boom')
    expect(socket.sent).toHaveLength(1) // 本拍心跳跳过（Hub 侧陈旧判据自然兜底）

    // 故障一次性：下拍事实恢复后心跳照常，会话不因单拍失败残废。
    shouldThrow = false
    timers.intervals[0]?.fn()
    expect(socket.sent).toHaveLength(2)
    expect(parseNodeFrame(JSON.parse(socket.sent[1] ?? ''), 'upstream').type).toBe('node.heartbeat')
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

/**
 * #89 session 层上报 + #101/B2「绝不发坏帧」不变式。
 *
 * 判定要打在 **socket 上写了什么**，不是"函数抛没抛"：`ws.send` 不做校验，一帧越界
 * 值出去，Hub 按 ADR-0007 fail-closed 断设备连接，而上报发生在每条连接建立后
 * ⟹ 永久「连接→被踢→重连→再被踢」。所以源守卫（register/set）之外的带外改文件
 * 路径，必须由帧工厂的协议自检兜住；而帧工厂抛异常还不够——必须证明**没写出去**。
 */
const goodWorkspace = {
  workspaceId: '01905f7c-0000-7000-8000-000000000503',
  name: 'proj',
  kind: 'directory' as const,
  capabilities: { read: true, write: true, git: false },
  available: true,
  lastCheckedAt: '2026-09-07T00:00:00.000Z',
}

describe('#89 inventory 上报与坏帧拦截', () => {
  it('连接建立后上报一帧 node.inventory（payload 恰三键、deviceId 与 config 一致）', async () => {
    FakeSocket.reset()
    const { deps } = makeDeps({})
    startDeviceSession({
      ...deps,
      inventoryFacts: async () => ({ workspaces: [goodWorkspace], credentialSlots: [] }),
    })
    const socket = latestSocket()
    socket.emitOpen()
    // 一次宏任务 flush：让 async 事实源 + .then 发送链走完（假 timer 不帮忙，
    // 这里是微任务链，用真 setTimeout 排空微任务队列后再判定）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    const frame = socket.sent.map(JSON.parse).find((f) => f.type === 'node.inventory')
    expect(frame).toBeDefined()
    expect(Object.keys(frame.payload).sort()).toEqual(['credentialSlots', 'deviceId', 'workspaces'])
    expect(frame.payload.deviceId).toBe(deps.config.deviceId)
    expect(frame.payload.workspaces[0].name).toBe('proj')
  })

  it('带外越界事实（名字 120 字符）：一帧都不许写到 socket 上，且失败要归因', async () => {
    FakeSocket.reset()
    const { deps } = makeDeps({})
    const errors: unknown[] = []
    startDeviceSession({
      ...deps,
      inventoryFacts: async () => ({
        workspaces: [{ ...goodWorkspace, name: 'a'.repeat(120) }],
        credentialSlots: [],
      }),
      onInventoryError: (error: unknown) => errors.push(error),
    })
    const socket = latestSocket()
    socket.emitOpen()
    // 一次宏任务 flush：让 async 事实源 + .then 发送链走完（假 timer 不帮忙，
    // 这里是微任务链，用真 setTimeout 排空微任务队列后再判定）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    // hello/heartbeat 是合法帧，必须照发；关键是**没有 inventory 帧出去**。
    const types = socket.sent.map((raw) => JSON.parse(raw).type as string)
    expect(types).toContain('node.hello')
    expect(types).not.toContain('node.inventory')
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('max')
  })

  it('credentialSlots 越界（provider 120）同样不发帧——两支都收在帧工厂', async () => {
    FakeSocket.reset()
    const { deps } = makeDeps({})
    const errors: unknown[] = []
    startDeviceSession({
      ...deps,
      inventoryFacts: async () => ({
        workspaces: [goodWorkspace],
        credentialSlots: [{ provider: 'p'.repeat(120), slot: 'default' }],
      }),
      onInventoryError: (error: unknown) => errors.push(error),
    })
    const socket = latestSocket()
    socket.emitOpen()
    // 一次宏任务 flush：让 async 事实源 + .then 发送链走完（假 timer 不帮忙，
    // 这里是微任务链，用真 setTimeout 排空微任务队列后再判定）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('node.inventory')
    expect(errors).toHaveLength(1)
  })
})
