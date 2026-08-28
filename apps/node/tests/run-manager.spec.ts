/**
 * RunManager 单测（P1-13 切片 B；03 §6/§7、R6/R7 前置）。
 *
 * 判定基线：
 * - run.start：command 先落 spool → ack accepted → Runtime stdin 收到
 *   initialize+prompt；容量/凭据/工作区失败 → ack accepted=false 且不 spawn。
 * - 重复 run.start（R7 重发）：runtime 在管 → 回旧 ack 且绝不起第二 Runtime。
 * - stdout 帧 → 投影双受众事件原子落 spool → 上行 run.event（seq 单调）；
 *   text-delta → run.live_delta 上行但不落 spool（非持久通道）。
 * - run.event_ack → spool 删除；run.resend_from / 重连 → 未 ack 全量补发
 *   （同 (runId,seq)，Hub 幂等去重）。
 * - Runtime 协议外输出 → 当前 Run 合成 run.failed（§11 fail-closed）。
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeDownstream, ProjectedRunEvent, RuntimeCommand } from '@project311/protocol'
import { CommandStore } from '../src/spool/command-store.js'
import { EventStore } from '../src/spool/event-store.js'
import { SecretStore } from '../src/secret/store.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { RuntimeSupervisor } from '../src/supervisor/runtime-supervisor.js'
import { RunManager } from '../src/run/run-manager.js'
import type { RuntimeDriver, RuntimeHandle, RuntimeStartSpec } from '../src/runtime-driver.js'

let root: string
let workspaceDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-runmgr-'))
  workspaceDir = join(root, 'ws')
  await mkdir(workspaceDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMMAND_ID = '22222222-2222-4222-8222-222222222222'

function runStartFrame(workspaceId: string, overrides: Record<string, unknown> = {}): NodeDownstream {
  return {
    protocolVersion: 1,
    messageId: 'm-1',
    sentAt: new Date().toISOString(),
    type: 'run.start',
    payload: {
      commandId: COMMAND_ID,
      runId: RUN_ID,
      taskId: '33333333-3333-4333-8333-333333333333',
      ownerUserId: '44444444-4444-4444-8444-444444444444',
      agent: {
        id: '55555555-5555-4555-8555-555555555555',
        profileRevisionId: '66666666-6666-4666-8666-666666666666',
        persona: 'test persona',
        provider: 'dsh',
        model: 'test-model',
        credentialSlot: 'api_key',
      },
      workspaceId,
      expectedProfileDigest: 'a'.repeat(64),
      expectedPluginPackDigest: 'b'.repeat(64),
      prompt: 'do the thing',
      ...overrides,
    },
  } as NodeDownstream
}

interface FakeRuntime {
  readonly runId: string
  readonly stdin: RuntimeCommand[]
  readonly emitStdout: (line: string) => void
  terminateCount: number
}

/** 纯内存 fake driver：记录 stdin 帧；stdout 由测试脚本化注入。 */
function makeFakeDriver(): { driver: RuntimeDriver; runtimes: FakeRuntime[] } {
  const runtimes: FakeRuntime[] = []
  const driver: RuntimeDriver = {
    async spawn(spec, ctx): Promise<RuntimeHandle> {
      const runtime: FakeRuntime = {
        runId: spec.runId,
        stdin: [],
        terminateCount: 0,
        emitStdout: (line) => ctx.onStdout(line),
      }
      runtimes.push(runtime)
      return {
        pid: 2_000_000 + runtimes.length, // 超出系统 pid 范围：ps 探针必查无此进程
        exitPromise: new Promise(() => {}),
        send: (command) => {
          runtime.stdin.push(command)
        },
      }
    },
    async terminate(handle) {
      const runtime = runtimes[runtimes.length - 1]
      if (runtime !== undefined) runtime.terminateCount += 1
      void handle
    },
  }
  return { driver, runtimes }
}

interface Harness {
  manager: RunManager
  supervisor: RuntimeSupervisor
  eventStore: EventStore
  commandStore: CommandStore
  runtimes: FakeRuntime[]
  sent: string[]
  workspaceId: string
  setOnline: (online: boolean) => void
  sentFrames: () => Array<{ type: string; payload: Record<string, unknown> }>
}

async function makeHarness(options: { online?: boolean } = {}): Promise<Harness> {
  let online = options.online ?? true
  const registry = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
  const workspace = await registry.register(workspaceDir, { name: 'ws-1' })
  const secrets = new SecretStore(join(root, 'secrets.json'), {
    PROJECT311_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
  })
  const { driver, runtimes } = makeFakeDriver()
  const eventStore = new EventStore(join(root, 'events.db'))
  const commandStore = new CommandStore(join(root, 'commands.db'))
  const sent: string[] = []
  const harness: Harness = {
    runtimes,
    eventStore,
    commandStore,
    sent,
    workspaceId: workspace.id,
    setOnline: (value) => {
      online = value
    },
    supervisor: undefined as unknown as RuntimeSupervisor,
    manager: undefined as unknown as RunManager,
    sentFrames: () =>
      sent.map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> }),
  }
  const supervisor = new RuntimeSupervisor({
    driver,
    registry,
    secrets,
    stateDbPath: join(root, 'supervisor.db'),
    capacity: 2,
    runtimeTimeoutMs: 60_000,
    onStdoutLine: (runId, line) => harness.manager.handleStdoutLine(runId, line),
  })
  const manager = new RunManager({
    supervisor,
    registry,
    commandStore,
    eventStore,
    send: (frame) => {
      if (online) sent.push(frame) // 离线时丢弃：spool 仍持有，重连补发
    },
    runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
    homeDir: '/Users/testhome',
  })
  harness.supervisor = supervisor
  harness.manager = manager
  return harness
}

function stdoutSessionEvent(runId: string, event: unknown): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'session.event',
    payload: { runId, dshSessionId: 'session-1', event },
  })
}

describe('run.start 处理链', () => {
  it('happy path：command 先落 spool → ack accepted → stdin 收 initialize+prompt', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))

    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({ commandId: COMMAND_ID, accepted: true })
    expect(h.runtimes).toHaveLength(1)
    const stdinTypes = h.runtimes[0]!.stdin.map((c) => c.type)
    expect(stdinTypes).toEqual(['runtime.initialize', 'run.prompt'])
    expect(h.supervisor.isActive(RUN_ID)).toBe(true)
    expect(h.commandStore.pending()).toHaveLength(0) // 已 markAcked
  })

  it('initialize 载荷带 workspace/dshHome/digest/persona（runtime wire 唯一允许绝对路径处）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const init = h.runtimes[0]!.stdin[0]!
    expect(init.type).toBe('runtime.initialize')
    const payload = (init as Extract<RuntimeCommand, { type: 'runtime.initialize' }>).payload
    // registry.resolve 返回 realpath（macOS 上 /var → /private/var）。
    expect(payload.workspacePath).toBe(await realpath(workspaceDir))
    expect(payload.profileDigest).toBe('a'.repeat(64))
    expect(payload.persona).toBe('test persona')
  })

  it('容量满 → ack accepted=false NODE_CAPACITY_REACHED，第三个不 spawn', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        commandId: 'c2c2c2c2-c2c2-4222-8222-c2c2c2c2c2c2',
        runId: '77777777-7777-4777-8777-777777777777',
      }),
    )
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        commandId: 'c3c3c3c3-c3c3-4333-8333-c3c3c3c3c3c3',
        runId: '88888888-8888-4888-8888-888888888888',
      }),
    )
    expect(h.runtimes).toHaveLength(2)
    const acks = h.sentFrames().filter((f) => f.type === 'command.ack')
    const rejected = acks[2]!
    expect(rejected.payload['accepted']).toBe(false)
    expect((rejected.payload['error'] as { code: string }).code).toBe('NODE_CAPACITY_REACHED')
  })

  it('重复 run.start（R7）：runtime 在管 → 重放 ack accepted，绝不起第二 Runtime', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    await h.manager.handleFrame(runStartFrame(h.workspaceId)) // Hub 因 ack 丢失重发
    expect(h.runtimes).toHaveLength(1)
    const acks = h.sentFrames().filter((f) => f.type === 'command.ack')
    expect(acks).toHaveLength(2)
    expect(acks[1]!.payload).toMatchObject({ commandId: COMMAND_ID, accepted: true })
  })
})

describe('stdout → 投影 → spool → 上行', () => {
  it('step/start → 双受众 run.event 上行，seq 从 1 单调，spool 持有', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, { type: 'step/start', seq: 1, time: 1_700_000_000_000, data: { turn: 1, step: 1 } }),
    )
    const runEvents = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
    expect(runEvents).toHaveLength(2)
    expect(runEvents.map((e) => e.seq)).toEqual([1, 2])
    expect(runEvents.map((e) => e.audience).sort()).toEqual(['owner', 'project'])
    expect(h.eventStore.pending(RUN_ID)).toHaveLength(2)
  })

  it('text-delta → run.live_delta 上行但不落 spool（非持久，deltaSeq 单调）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, {
        type: 'assistant/chunk',
        seq: 1,
        time: 1_700_000_000_000,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } },
      }),
    )
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, {
        type: 'assistant/chunk',
        seq: 2,
        time: 1_700_000_000_100,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } },
      }),
    )
    const live = h.sentFrames().filter((f) => f.type === 'run.live_delta')
    expect(live.map((f) => f.payload['deltaSeq'])).toEqual([1, 2])
    expect(live.map((f) => f.payload['text'])).toEqual(['Hel', 'lo'])
    expect(h.eventStore.pending(RUN_ID)).toHaveLength(0)
  })

  it('run.event_ack → spool 删除至 throughSeq', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }),
    )
    expect(h.eventStore.pending(RUN_ID)).toHaveLength(2)
    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: 'ack-1',
      sentAt: new Date().toISOString(),
      type: 'run.event_ack',
      payload: { runId: RUN_ID, throughSeq: 2 },
    } as NodeDownstream)
    expect(h.eventStore.pending(RUN_ID)).toHaveLength(0)
  })

  it('离线期产出的事件留在 spool；重连 onReconnect 全量补发同 (runId,seq)（R1）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.setOnline(false) // Hub 重启 → socket 断开：上行帧全部丢弃
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }),
    )
    expect(h.sentFrames().filter((f) => f.type === 'run.event')).toHaveLength(0)
    expect(h.eventStore.pending(RUN_ID)).toHaveLength(2)

    // Hub 恢复 → 重连 → drain：同 (runId,seq) 补发，Hub 幂等去重。
    h.setOnline(true)
    h.manager.onReconnect()
    const resent = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => (f.payload as unknown as ProjectedRunEvent).seq)
    expect(resent).toEqual([1, 2])
  })

  it('run.resend_from → 未 ack 事件重发（同 seq，Hub 幂等去重，R6）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }),
    )
    const before = h.sentFrames().filter((f) => f.type === 'run.event').length
    expect(before).toBe(2)
    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: 'rs-1',
      sentAt: new Date().toISOString(),
      type: 'run.resend_from',
      payload: { runId: RUN_ID, fromSeq: 1 },
    } as NodeDownstream)
    const after = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => (f.payload as unknown as ProjectedRunEvent).seq)
    expect(after).toEqual([1, 2, 1, 2]) // 首次 + 重发同 seq
  })
})

describe('run.cancel 与 approval.decide', () => {
  it('run.cancel → stdin run.cancel（admin→parent）+ ack accepted', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: 'c-1',
      sentAt: new Date().toISOString(),
      type: 'run.cancel',
      payload: { commandId: 'c9c9c9c9-c9c9-4999-8999-c9c9c9c9c9c9', runId: RUN_ID, cause: 'admin' },
    } as NodeDownstream)
    const cancel = h.runtimes[0]!.stdin.find((c) => c.type === 'run.cancel')
    expect(cancel).toBeDefined()
    expect((cancel as Extract<RuntimeCommand, { type: 'run.cancel' }>).payload.cause).toBe('parent')
    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(true)
  })

  it('approval.decide → stdin 转发 + approval.decided 双受众回显落 spool', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    // 先让 runtime 产出 tool/call + approval.requested
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, {
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      }),
    )
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'approval.requested',
        payload: { runId: RUN_ID, callId: 'call-1', toolName: 'bash', reason: 'needs approval' },
      }),
    )
    const requested = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
      .find((e) => e.event.type === 'approval.requested')
    const approvalId = (requested!.event as { approval: { approvalId: string } }).approval.approvalId

    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: 'd-1',
      sentAt: new Date().toISOString(),
      type: 'approval.decide',
      payload: {
        commandId: 'd8d8d8d8-d8d8-4888-8888-d8d8d8d8d8d8',
        runId: RUN_ID,
        approvalId,
        callId: 'call-1',
        decision: 'allowed_once',
      },
    } as NodeDownstream)

    const decide = h.runtimes[0]!.stdin.find((c) => c.type === 'approval.decide')
    expect(decide).toBeDefined()
    const decidedEvents = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
      .filter((e) => e.event.type === 'approval.decided')
    expect(decidedEvents).toHaveLength(2)
    expect(decidedEvents[0]!.event).toMatchObject({ approvalId, status: 'allowed_once' })
  })
})

describe('§11 协议违例', () => {
  it('非 JSON stdout 行 → 合成 run.failed INTERNAL_ERROR 上行 + 终止 runtime', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout('this is not json')
    const failed = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
      .find((e) => e.event.type === 'run.failed')
    expect(failed).toBeDefined()
    expect((failed!.event as { code: string }).code).toBe('INTERNAL_ERROR')
    expect(h.runtimes[0]!.terminateCount).toBe(1)
  })

  it('帧 runId 与来源进程不符 → 串扰防护（run.failed）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent('99999999-9999-4999-8999-999999999999', {
        type: 'step/start',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1 },
      }),
    )
    const failed = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
      .find((e) => e.event.type === 'run.failed')
    expect(failed).toBeDefined()
  })
})

describe('心跳事实', () => {
  it('heartbeatFacts 上报 activeRunIds 与 lastEventSeqByRun', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      stdoutSessionEvent(RUN_ID, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }),
    )
    const facts = h.manager.heartbeatFacts()
    expect(facts.activeRunIds).toEqual([RUN_ID])
    expect(facts.lastEventSeqByRun[RUN_ID]).toBe(2)
  })
})
