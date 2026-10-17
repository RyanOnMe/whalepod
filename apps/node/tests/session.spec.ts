/**
 * 出站会话循环（gateway/session.ts）单测：FakeSocket + 手动定时器。
 * 覆盖 review 修复点：连接首发 node.hello（帧过协议 parseNodeFrame 验证）、
 * 心跳周期真实发送、永久关闭（4401/4008/token_revoked）停止重连、普通断线退避重连。
 */
import { describe, expect, it } from 'vitest'
import { parseNodeFrame } from '@whalepod/protocol'
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
  helloFacts?: () => HelloFacts | Promise<HelloFacts>
  onHelloError?: (error: unknown) => void
}) {
  const timers: FakeTimers = { intervals: [], timeouts: [] }
  const exits: Array<{ code: number; message: string }> = []
  const deps = {
    config,
    // #352：hello 事实是**按连接重算**的函数；测试用同一注入点验「重连/刷新时重算」。
    helloFacts: overrides.helloFacts ?? (() => facts),
    onRevoked: overrides.onRevoked ?? (() => {}),
    ...(overrides.heartbeatFacts !== undefined ? { heartbeatFacts: overrides.heartbeatFacts } : {}),
    ...(overrides.onHeartbeatError !== undefined
      ? { onHeartbeatError: overrides.onHeartbeatError }
      : {}),
    ...(overrides.onHelloError !== undefined ? { onHelloError: overrides.onHelloError } : {}),
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

/** #352：hello 采集是异步的（await helloFacts）——open 之后要先把微任务排空再断言。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** 取一行上行帧里的 node.hello（#352 的判据面）。 */
function parseHello(line: string | undefined) {
  const frame = parseNodeFrame(JSON.parse(line ?? ''), 'upstream')
  if (frame.type !== 'node.hello') throw new Error(`not a hello frame: ${frame.type}`)
  return frame
}

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
  if (socket === undefined) throw new Error('no socket created')
  return socket
}

describe('startDeviceSession', () => {
  it('连接建立后首发 node.hello（帧过协议 schema），随后心跳按周期发送', async () => {
    FakeSocket.reset()
    const { deps, timers } = makeDeps({})
    const session = startDeviceSession(deps)
    const socket = latestSocket()
    expect(socket.url).toBe('ws://hub.local:8080/ws/v1/node')
    expect((socket.options as { headers: Record<string, string> }).headers.authorization).toBe(
      `Device ${config.deviceToken}`,
    )

    socket.emitOpen()
    await flushMicrotasks() // #352：hello 采集是异步的（await helloFacts）
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

  it('#103：heartbeatFacts 抛错不穿透定时器回调——归因 onHeartbeatError、本拍跳过、下拍恢复', async () => {
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
    await flushMicrotasks() // #352：hello 采集是异步的
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

  it('普通断线（1006）：按退避调度重连，新连接重发 hello', async () => {
    FakeSocket.reset()
    const { deps, timers, exits } = makeDeps({})
    startDeviceSession(deps)
    const first = latestSocket()
    first.emitOpen()
    await flushMicrotasks() // #352：hello 采集是异步的
    expect(first.sent).toHaveLength(1)
    first.emitClose(1006, 'abnormal')
    expect(exits).toHaveLength(0)
    expect(timers.timeouts).toHaveLength(1)
    expect(timers.timeouts[0]?.ms).toBe(250)

    timers.timeouts[0]?.fn()
    expect(FakeSocket.instances).toHaveLength(2)
    const second = latestSocket()
    second.emitOpen()
    await flushMicrotasks()
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

  it('#352：hello 采集慢时也不许插队——inventory 必须等 hello 出线（#320 依赖它）', async () => {
    // 断链背景：hello 的采集会 await 探针（一次 node spawn，真机几十~几百 ms），而
    // **设备行有事实**才是 Hub 侧「设备在线」的判据（#320 的 preparation-check 否则
    // 409 DEVICE_OFFLINE）。实现把 sendHello 从连接流程里 fire-and-forget 出去时，
    // 本用例红（inventory 会在采集放行前就出线）——Q2 的 preparation-node-bin 用例
    // 曾经以 409 的形态抓到过同一回归。
    FakeSocket.reset()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps } = makeDeps({
      helloFacts: async () => {
        await gate
        return { ...facts }
      },
    })
    startDeviceSession({
      ...deps,
      inventoryFacts: async () => ({ workspaces: [goodWorkspace], credentialSlots: [] }),
    })
    const socket = latestSocket()
    socket.emitOpen()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 采集未放行：一帧 inventory 都不许出线（hello 也还没出）。
    expect(socket.sent.map((raw) => JSON.parse(raw).type as string)).not.toContain('node.inventory')

    release!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const types = socket.sent.map((raw) => JSON.parse(raw).type as string)
    expect(types.indexOf('node.hello')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('node.hello')).toBeLessThan(types.indexOf('node.inventory'))
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

describe('#94 inventory 变化时重报（心跳节拍检测，会话不重启）', () => {
  const secondWorkspace = {
    workspaceId: '01905f7c-0000-7000-8000-000000000594',
    name: 'docs',
    kind: 'directory' as const,
    capabilities: { read: true, write: true, git: false },
    available: true,
    lastCheckedAt: '2026-09-09T00:00:00.000Z',
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const inventoryFrames = (socket: FakeSocket) =>
    socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: { workspaces: unknown[] } })
      .filter((f) => f.type === 'node.inventory')

  it('registry revision 变化 → 下一拍心跳补发 node.inventory；未变不重报', async () => {
    FakeSocket.reset()
    let revision = 'v1'
    let workspaces = [goodWorkspace]
    const { deps, timers } = makeDeps({})
    startDeviceSession({
      ...deps,
      inventoryFacts: async () => ({ workspaces, credentialSlots: [] }),
      inventoryRevision: async () => revision,
    })
    const socket = latestSocket()
    socket.emitOpen()
    await flush()
    expect(inventoryFrames(socket)).toHaveLength(1) // 连接后首报（#89 既有）

    // 另一终端 `workspace add` 之前：revision 不变 → 心跳拍不重报（零常态带宽）。
    timers.intervals[0]!.fn()
    await flush()
    expect(inventoryFrames(socket)).toHaveLength(1)

    // 另一终端 workspace add 落库 → 指纹变化 → 下一拍补报，含新 Workspace。
    revision = 'v2'
    workspaces = [goodWorkspace, secondWorkspace]
    timers.intervals[0]!.fn()
    await flush()
    const frames = inventoryFrames(socket)
    expect(frames).toHaveLength(2)
    const names = frames[1]!.payload.workspaces.map((w) => (w as { name: string }).name)
    expect(names).toEqual(['proj', 'docs'])
  })

  it('revision 探测失败：只归因 onInventoryError——心跳照发、会话存活、恢复后下拍补报', async () => {
    FakeSocket.reset()
    let revision: string | Error = 'v1' // 连接期探测正常，首报入账指纹
    const { deps, timers } = makeDeps({})
    const errors: unknown[] = []
    startDeviceSession({
      ...deps,
      inventoryFacts: async () => ({ workspaces: [goodWorkspace], credentialSlots: [] }),
      inventoryRevision: async () => {
        if (revision instanceof Error) throw revision
        return revision
      },
      onInventoryError: (error: unknown) => errors.push(error),
    })
    const socket = latestSocket()
    socket.emitOpen()
    await flush()
    expect(inventoryFrames(socket)).toHaveLength(1) // 连接后首报
    expect(errors).toHaveLength(0)

    // 探测开始失败（如 sqlite 文件暂时锁住）：本拍只归因，心跳照发不重报。
    revision = new Error('sqlite locked')
    const heartbeatsBefore = socket.sent.filter((raw) => raw.includes('node.heartbeat')).length
    timers.intervals[0]!.fn()
    await flush()
    expect(errors).toHaveLength(1) // 归因留证
    expect(socket.sent.filter((raw) => raw.includes('node.heartbeat')).length).toBe(
      heartbeatsBefore + 1,
    ) // 心跳本拍照发，不被探测失败株连
    expect(inventoryFrames(socket)).toHaveLength(1) // 不重报

    // 探测恢复且 revision 已变 → 下拍自然补报（错误不黏住会话）。
    revision = 'v2'
    timers.intervals[0]!.fn()
    await flush()
    expect(inventoryFrames(socket)).toHaveLength(2)
  })
})

describe('#112 归因回调缺省不可静默（默认结构化 warn 兜底）', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const original = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    return {
      lines,
      restore: () => {
        process.stderr.write = original
      },
    }
  }

  it('heartbeatFacts 抛错且未接 onHeartbeatError：stderr 有结构化 warn（不是静默）', async () => {
    FakeSocket.reset()
    const { deps, timers } = makeDeps({
      heartbeatFacts: () => {
        throw new Error('sqlite gone')
      },
    })
    const cap = captureStderr()
    try {
      startDeviceSession({ ...deps }) // 故意不接 onHeartbeatError
      const socket = latestSocket()
      socket.emitOpen()
      timers.intervals[0]!.fn()
      await flush()
    } finally {
      cap.restore()
    }
    const warn = cap.lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return undefined
        }
      })
      .find((l) => l?.component === 'node.session')
    expect(warn).toBeDefined()
    expect(warn!.level).toBe('warn')
    expect(String(warn!.error)).toContain('sqlite gone')
  })

  it('inventoryFacts 失败且未接 onInventoryError：stderr 同样兜底（两族同形态）', async () => {
    FakeSocket.reset()
    const { deps } = makeDeps({})
    const cap = captureStderr()
    try {
      startDeviceSession({
        ...deps,
        inventoryFacts: async () => {
          throw new Error('build boom')
        },
      })
      const socket = latestSocket()
      socket.emitOpen()
      await flush()
    } finally {
      cap.restore()
    }
    const warn = cap.lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return undefined
        }
      })
      .find((l) => l?.component === 'node.session')
    expect(warn).toBeDefined()
    expect(warn!.level).toBe('warn')
    expect(String(warn!.error)).toContain('build boom')
  })
})

describe('#352 node.hello 事实刷新', () => {
  // ---- #352：hello 事实按连接重算 + 会话内刷新（含序号单调与同连接去重）----

  const helloCount = (socket: FakeSocket): number =>
    socket.sent.filter((line) => parseHello(line).type === 'node.hello').length

  it('#352：重连时 hello 事实**重算**（pack 装好后不必重启 Node）', async () => {
    FakeSocket.reset()
    let digests: string[] = []
    const { deps, timers } = makeDeps({
      helloFacts: () => ({ ...facts, pluginPackDigests: [...digests] }),
    })
    startDeviceSession(deps)
    const first = latestSocket()
    first.emitOpen()
    await flushMicrotasks()
    expect(parseHello(first.sent.at(-1)).payload.pluginPackDigests).toEqual([])

    // 本机装了一个 pack（不重启 Node）：断线重连 → hello 必须带上新 digest。
    digests = ['b'.repeat(64)]
    first.emitClose(1006, 'network blip')
    timers.timeouts.at(-1)!.fn() // 退避后重连
    const second = latestSocket()
    second.emitOpen()
    await flushMicrotasks()
    expect(parseHello(second.sent.at(-1)).payload.pluginPackDigests).toEqual(['b'.repeat(64)])
  })

  it('#352：refreshHello() 在**连接保持时**发新事实（preflight 装包后的会话内刷新）', async () => {
    FakeSocket.reset()
    let digests: string[] = []
    const { deps } = makeDeps({
      helloFacts: () => ({ ...facts, pluginPackDigests: [...digests] }),
    })
    const session = startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    await flushMicrotasks()
    const hellosBefore = helloCount(socket)
    expect(hellosBefore).toBe(1)

    digests = ['c'.repeat(64)]
    session.refreshHello()
    await flushMicrotasks()
    const hellos = socket.sent.filter((line) => parseHello(line).type === 'node.hello')
    expect(hellos.length).toBe(hellosBefore + 1)
    expect(parseHello(hellos.at(-1)).payload.pluginPackDigests).toEqual(['c'.repeat(64)])

    // 无活连接时 no-op（不抛、不发）。
    socket.emitClose(1006, 'gone')
    session.refreshHello()
    await flushMicrotasks()
    expect(helloCount(socket)).toBe(hellos.length)
  })

  it('#352：同一连接内事实未变 → 不重发；换连接（重连）即使未变也照发', async () => {
    FakeSocket.reset()
    const { deps, timers } = makeDeps({ helloFacts: () => ({ ...facts }) })
    const session = startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    await flushMicrotasks()
    expect(helloCount(socket)).toBe(1)

    session.refreshHello()
    session.refreshHello()
    await flushMicrotasks()
    expect(helloCount(socket)).toBe(1) // 同连接 + 事实未变：不发（空转的 device.changed 免了）

    socket.emitClose(1006, 'blip')
    timers.timeouts.at(-1)!.fn()
    const second = latestSocket()
    second.emitOpen()
    await flushMicrotasks()
    expect(helloCount(second)).toBe(1) // 新连接：Hub 侧「设备在线」的信号面，必须发
    session.stop()
  })

  it('#352：旧快照后到不得覆盖新快照（两处采集同时在飞时的序号单调）', async () => {
    FakeSocket.reset()
    // 两个受控 deferred：先发起的（连接建立）慢，后发起的（会话内刷新）快。
    const pending: Array<(v: HelloFacts) => void> = []
    const { deps } = makeDeps({
      helloFacts: () => new Promise<HelloFacts>((resolve) => pending.push(resolve)),
    })
    const session = startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    await flushMicrotasks()

    // 场景：重连后 Hub 立刻派了排队的 run.start → preflight 本地命中 → 会话内刷新。
    // 早先发起的采集（无 pack 的旧事实）比它晚结算。
    session.refreshHello()
    expect(pending).toHaveLength(2)
    pending[1]!({ ...facts, pluginPackDigests: ['d'.repeat(64)] }) // 新快照先落地
    await flushMicrotasks()
    expect(helloCount(socket)).toBe(1)
    expect(parseHello(socket.sent.at(-1)).payload.pluginPackDigests).toEqual(['d'.repeat(64)])

    pending[0]!({ ...facts, pluginPackDigests: [] }) // 旧快照后到：不许覆盖
    await flushMicrotasks()
    expect(helloCount(socket)).toBe(1)
    expect(parseHello(socket.sent.at(-1)).payload.pluginPackDigests).toEqual(['d'.repeat(64)])
  })

  it('#352：采集失败只归因、不打断会话，也不掀宿主（归因回调自身抛错也吞掉）', async () => {
    FakeSocket.reset()
    const errors: unknown[] = []
    let shouldThrow = true
    const { deps } = makeDeps({
      helloFacts: () => {
        if (shouldThrow) throw new Error('disk boom')
        return { ...facts, pluginPackDigests: ['e'.repeat(64)] }
      },
      onHelloError: (error: unknown) => {
        errors.push(error)
        throw new Error('callback boom')
      },
    })
    const session = startDeviceSession(deps)
    const socket = latestSocket()
    socket.emitOpen()
    await flushMicrotasks()
    expect(helloCount(socket)).toBe(0) // 本连接不报 hello
    expect(errors).toHaveLength(1)

    // 让回调正常一次：随机探测恢复后同样能补发（不因上次失败而卡死）。
    shouldThrow = false
    const { deps: depsOk } = makeDeps({
      helloFacts: () => ({ ...facts, pluginPackDigests: ['f'.repeat(64)] }),
      onHelloError: () => {},
    })
    const sessionOk = startDeviceSession(depsOk)
    const socketOk = latestSocket()
    socketOk.emitOpen()
    await flushMicrotasks()
    expect(helloCount(socketOk)).toBe(1)
    session.stop()
    sessionOk.stop()
  })
})
