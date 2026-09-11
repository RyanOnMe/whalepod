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
import type { NodeDownstream, ProjectedRunEvent, RuntimeCommand } from '@whalepod/protocol'
import { CommandStore } from '../src/spool/command-store.js'
import { EventStore } from '../src/spool/event-store.js'
import { SecretStore } from '../src/secret/store.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { RuntimeSupervisor } from '../src/supervisor/runtime-supervisor.js'
import { RunManager, type RunManagerTimers } from '../src/run/run-manager.js'
import { openStateDatabase } from '../src/state/db.js'
import type { RuntimeDriver, RuntimeHandle, RuntimeStartSpec } from '../src/runtime-driver.js'

let root: string
let workspaceDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-runmgr-'))
  workspaceDir = join(root, 'ws')
  await mkdir(workspaceDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMMAND_ID = '22222222-2222-4222-8222-222222222222'

function runStartFrame(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): NodeDownstream {
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
  readonly emitExit: (code: number | null, signal: string | null) => void
  terminateCount: number
  forceKillCount: number
}

/** 纯内存 fake driver：记录 stdin 帧；stdout/exit 由测试脚本化注入。 */
function makeFakeDriver(): { driver: RuntimeDriver; runtimes: FakeRuntime[] } {
  const runtimes: FakeRuntime[] = []
  const driver: RuntimeDriver = {
    async spawn(spec, ctx): Promise<RuntimeHandle> {
      const runtime: FakeRuntime = {
        runId: spec.runId,
        stdin: [],
        terminateCount: 0,
        forceKillCount: 0,
        emitStdout: (line) => ctx.onStdout(line),
        emitExit: (code, signal) => ctx.onExit(code, signal),
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
    async forceKill(handle) {
      const runtime = runtimes[runtimes.length - 1]
      if (runtime !== undefined) runtime.forceKillCount += 1
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

async function makeHarness(
  options: {
    online?: boolean
    /** P1-15：RunManager 的 Artifact 依赖注入（collector / inputs）。 */
    managerDeps?: Record<string, unknown>
    /** 捕获结构化日志（观测面断言用）。 */
    logs?: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>
  } = {},
): Promise<Harness> {
  let online = options.online ?? true
  const registry = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
  const workspace = await registry.register(workspaceDir, { name: 'ws-1' })
  const secrets = new SecretStore(join(root, 'secrets.json'), {
    WHALEPOD_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
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
    stateDir: root,
    packsRoot: join(root, 'plugin-packs'),
    ...(options.logs !== undefined
      ? {
          log: (level, msg, fields) => {
            options.logs!.push({ level, msg, ...(fields !== undefined ? { fields } : {}) })
          },
        }
      : {}),
    ...options.managerDeps,
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

function stdoutRuntimeReady(runId: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'runtime.ready',
    payload: { runId, dshSessionId: 'session-1' },
  })
}

function followupFrame(
  text: string,
  overrides: { commandId?: string; runId?: string } = {},
): NodeDownstream {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'run.followup',
    payload: {
      commandId: overrides.commandId ?? 'f0000000-0000-4000-8000-000000000001',
      runId: overrides.runId ?? RUN_ID,
      text,
    },
  } as NodeDownstream
}

/** 起一个已 ready（running）的 Run：run.start → stdout runtime.ready。 */
async function startReadyRun(h: Harness): Promise<void> {
  await h.manager.handleFrame(runStartFrame(h.workspaceId))
  h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
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

  it('凭据缺失（RuntimeEnvError）→ ack 透传 MODEL_CREDENTIAL_UNAVAILABLE，不降级 INTERNAL_ERROR', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        agent: {
          id: '55555555-5555-4555-8555-555555555555',
          profileRevisionId: '66666666-6666-4666-8666-666666666666',
          persona: 'test persona',
          provider: 'no-such-provider',
          model: 'test-model',
          credentialSlot: 'nope',
        },
      }),
    )
    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect((ack!.payload['error'] as { code: string }).code).toBe('MODEL_CREDENTIAL_UNAVAILABLE')
    expect(h.runtimes).toHaveLength(0) // spawn 前失败，Runtime 一个不启动
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
      stdoutSessionEvent(RUN_ID, {
        type: 'step/start',
        seq: 1,
        time: 1_700_000_000_000,
        data: { turn: 1, step: 1 },
      }),
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
      stdoutSessionEvent(RUN_ID, {
        type: 'step/start',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1 },
      }),
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
      stdoutSessionEvent(RUN_ID, {
        type: 'step/start',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1 },
      }),
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
      stdoutSessionEvent(RUN_ID, {
        type: 'step/start',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1 },
      }),
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

describe('run.followup 处理链（#180 / ADR-0009 决策 3）', () => {
  it('happy path：ack accepted + stdin 收到 run.followup（不新开 Run、不重发 initialize）', async () => {
    const h = await makeHarness()
    await startReadyRun(h)
    const before = h.runtimes[0]!.stdin.length

    await h.manager.handleFrame(followupFrame('顺便把 macOS 的冒烟结果也补进清单'))

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({
      commandId: 'f0000000-0000-4000-8000-000000000001',
      accepted: true,
    })
    const appended = h.runtimes[0]!.stdin.slice(before)
    expect(appended.map((c) => c.type)).toEqual(['run.followup'])
    expect((appended[0] as Extract<RuntimeCommand, { type: 'run.followup' }>).payload).toEqual({
      runId: RUN_ID,
      text: '顺便把 macOS 的冒烟结果也补进清单',
    })
    // 只追加一次追问：没有第二个 Runtime、没有第二次 initialize。
    expect(h.runtimes).toHaveLength(1)
    expect(h.runtimes[0]!.stdin.filter((c) => c.type === 'runtime.initialize')).toHaveLength(1)
    expect(h.commandStore.pending()).toHaveLength(0)
  })

  it('重复 commandId（Hub 重发 / ack 丢失）→ 只回放 ack，绝不重复注入', async () => {
    const h = await makeHarness()
    await startReadyRun(h)
    const frame = followupFrame('同一句追问')

    await h.manager.handleFrame(frame)
    await h.manager.handleFrame(frame)

    expect(h.runtimes[0]!.stdin.filter((c) => c.type === 'run.followup')).toHaveLength(1)
    const acks = h.sentFrames().filter((f) => f.type === 'command.ack')
    expect(acks.filter((f) => f.payload['accepted'] === true).length).toBeGreaterThanOrEqual(2)
  })

  it('B1 回归：首次被拒 → ack 丢失 → 同 commandId 重投（此时已 ready）必须回放拒绝，不得假受理', async () => {
    const h = await makeHarness()
    // 反例路径：Run 存在但还没 ready → 首次投递被拒（而 ack 上行丢在断连的那一侧）。
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const frame = followupFrame('这句在 Run ready 之前发的追问')
    await h.manager.handleFrame(frame)
    expect(h.sentFrames().findLast((f) => f.type === 'command.ack')?.payload).toMatchObject({
      accepted: false,
      error: { code: 'INVALID_RUN_TRANSITION' },
    })

    // Hub 没收到那条 ack（outbox 未落 acked_at）→ Run 随后 ready → 按同一 commandId 重投。
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    await h.manager.handleFrame(frame)

    const replayed = h.sentFrames().findLast((f) => f.type === 'command.ack')
    // 关键：**不能**因为「见过这个 commandId」就回 accepted=true——那句话从未进过 stdin，
    // 一旦假受理，Hub 会把 outbox 行标记完成并永不重投（已受理、零痕迹、未执行）。
    expect(replayed?.payload['accepted']).toBe(false)
    expect(replayed?.payload['error']).toMatchObject({ code: 'INVALID_RUN_TRANSITION' })
    expect(h.runtimes[0]!.stdin.map((c) => c.type)).not.toContain('run.followup')
  })

  it('首次已受理 → ack 丢失 → 同 commandId 重投 → 回放 accepted，且不二次注入', async () => {
    const h = await makeHarness()
    await startReadyRun(h)
    const frame = followupFrame('这句已经成功下发过')

    await h.manager.handleFrame(frame)
    await h.manager.handleFrame(frame) // Hub 未收到 ack → 重投

    const replayed = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(replayed?.payload['accepted']).toBe(true)
    expect(h.runtimes[0]!.stdin.filter((c) => c.type === 'run.followup')).toHaveLength(1)
  })

  it('崩溃在 record 与处理之间（无处理结果）→ 重投时真正处理一次（spool 本意）', async () => {
    const h = await makeHarness()
    await startReadyRun(h)
    const commandId = 'f0000000-0000-4000-8000-0000000000ff'
    // 模拟「已 spool 但从未处理」：直接入库，不走 handleFrame。
    h.commandStore.record({
      commandId,
      runId: RUN_ID,
      type: 'run.followup',
      payload: { commandId, runId: RUN_ID, text: '崩溃前没来得及处理的追问' },
    })

    await h.manager.handleFrame(followupFrame('崩溃前没来得及处理的追问', { commandId }))

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(true)
    expect(h.runtimes[0]!.stdin.filter((c) => c.type === 'run.followup')).toHaveLength(1)
  })

  it('Runtime 已不在管（stopAll 摘 handle）→ 确定性 RUNTIME_LOST，且不下发', async () => {
    const h = await makeHarness()
    await startReadyRun(h)
    // stopAll：摘 handle 并置 stopping（抑制退出事件 ⇒ 不写 finalFacts），于是 Run 事实
    // 仍是 running 而 Runtime 已不可派发——这是 RUNTIME_LOST 的确定性命中路径
    //（#181 评审 S2：先前"不可确定性复现"的说法不成立）。
    await h.supervisor.stopAll()

    await h.manager.handleFrame(followupFrame('Runtime 已经收摊了'))

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect(ack?.payload['error']).toMatchObject({ code: 'RUNTIME_LOST' })
    expect(h.runtimes[0]!.stdin.map((c) => c.type)).not.toContain('run.followup')
  })

  it('回放首次结果时留结构化日志（观测面：这次 ack 是回放、回放的是什么）', async () => {
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const h = await makeHarness({ logs })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const frame = followupFrame('先被拒，之后 ack 丢失重投')
    await h.manager.handleFrame(frame)
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    await h.manager.handleFrame(frame)

    const replayed = logs.find((entry) => entry.msg.includes('duplicate replayed first outcome'))
    expect(replayed?.level).toBe('info')
    expect(replayed?.fields).toMatchObject({
      replayed: 'rejected',
      replayedCode: 'INVALID_RUN_TRANSITION',
    })
  })

  it('首次结果落库失败 → 仍照发 ack（不悬挂），并留 error 级日志', async () => {
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const h = await makeHarness({ logs })
    await startReadyRun(h)
    // 模拟本地 spool 写失败（磁盘满 / IO 错 / WAL 锁）：写已发生是既定事实，ack 必须照发
    // ——否则 Hub 会重投，而 outcomeOf 仍为空 ⇒ 同一句追问二次注入（#181 评审 N1）。
    h.commandStore.recordOutcome = () => {
      throw new Error('disk full')
    }

    await h.manager.handleFrame(followupFrame('落库会失败的这句追问'))

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(true)
    expect(h.runtimes[0]!.stdin.filter((c) => c.type === 'run.followup')).toHaveLength(1)
    expect(
      logs.some((entry) => entry.level === 'error' && entry.msg.includes('outcome persist failed')),
    ).toBe(true)
  })

  it('老库补列（#181 N3）：旧 schema 的 commands 库打开后补齐三列，历史行按「未处理」处理', async () => {
    const legacyPath = join(root, 'legacy-commands.db')
    // 造一个旧 schema 的库（没有 outcome / error_code / error_message 三列）+ 一行历史数据。
    const legacy = openStateDatabase(legacyPath)
    legacy.exec(`
      create table spooled_command (
        seq_id integer primary key autoincrement,
        command_id text not null unique,
        run_id text not null,
        type text not null,
        payload text not null,
        received_at text not null,
        acked_at text
      )
    `)
    legacy
      .prepare(
        'insert into spooled_command (command_id, run_id, type, payload, received_at, acked_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run('legacy-1', RUN_ID, 'run.start', '{}', new Date().toISOString(), null)
    legacy.close()

    const store = new CommandStore(legacyPath) // 构造函数里的 ensureColumn 负责迁移
    const columns = (
      store as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
    ).db
      .prepare('pragma table_info(spooled_command)')
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['outcome', 'error_code', 'error_message']),
    )
    // 历史行没有处理结果 → 视为「未处理完」，重投时会真正处理一次（spool 本意）。
    expect(store.outcomeOf('legacy-1')).toBeUndefined()
    // 新结果可写可读，且与 ack 同步落库。
    store.recordOutcome('legacy-1', 'rejected', { code: 'NOT_FOUND', message: 'legacy row' })
    expect(store.outcomeOf('legacy-1')).toEqual({
      outcome: 'rejected',
      error: { code: 'NOT_FOUND', message: 'legacy row' },
    })
    expect(store.isAcked('legacy-1')).toBe(true)
    store.close()
  })

  it('Run 已终态 → ack false INVALID_RUN_TRANSITION，且不下发（终态禁止复活）', async () => {
    const h = await makeHarness()
    await startReadyRun(h)
    // 终态：runtime 上报 run.completed（Node 侧落 finalFacts 并释放 Runtime）。
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'run.completed',
        payload: { runId: RUN_ID, dshSessionId: 'session-1' },
      }),
    )
    const before = h.runtimes[0]!.stdin.length

    await h.manager.handleFrame(followupFrame('终态之后再插一句'))

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect(ack?.payload['error']).toMatchObject({ code: 'INVALID_RUN_TRANSITION' })
    expect(h.runtimes[0]!.stdin.slice(before).map((c) => c.type)).not.toContain('run.followup')
  })

  it('Run 存在但还没 running（未收到 runtime.ready）→ ack false INVALID_RUN_TRANSITION', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId)) // 只 start，不 emit ready

    await h.manager.handleFrame(followupFrame('还没跑起来就追问'))

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect(ack?.payload['error']).toMatchObject({ code: 'INVALID_RUN_TRANSITION' })
    expect(h.runtimes[0]!.stdin.map((c) => c.type)).not.toContain('run.followup')
  })

  it('本 Node 无此 Run 的任何事实 → ack false NOT_FOUND，且不 spawn', async () => {
    const h = await makeHarness()
    await startReadyRun(h)

    await h.manager.handleFrame(
      followupFrame('发给一个不存在的 Run', { runId: '99999999-9999-4999-8999-999999999999' }),
    )

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect(ack?.payload['error']).toMatchObject({ code: 'NOT_FOUND' })
    expect(h.runtimes).toHaveLength(1)
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
    const approvalId = (requested!.event as { approval: { approvalId: string } }).approval
      .approvalId

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
      stdoutSessionEvent(RUN_ID, {
        type: 'step/start',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1 },
      }),
    )
    const facts = h.manager.heartbeatFacts()
    expect(facts.activeRunIds).toEqual([RUN_ID])
    expect(facts.lastEventSeqByRun[RUN_ID]).toBe(2)
  })
})

describe('P1-15：Artifact 采集与 Reviewer 输入接线', () => {
  const ARTIFACT_ID = '01905f7c-0000-7000-8000-000000000801'

  function stdoutArtifactCandidate(runId: string): string {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'artifact.candidate',
      payload: {
        runId,
        relativePath: 'reports/out.md',
        title: 'Report',
        mediaType: 'text/markdown',
      },
    })
  }

  function makeCollector(options: { error?: Error } = {}) {
    const calls: Array<{
      runId: string
      candidate: Record<string, unknown>
      workspacePath: string
    }> = []
    return {
      calls,
      collector: {
        collect: async (
          runId: string,
          candidate: Record<string, unknown>,
          workspacePath: string,
        ) => {
          calls.push({ runId, candidate, workspacePath })
          if (options.error !== undefined) throw options.error
          return {
            artifactId: ARTIFACT_ID,
            sha256: 'c'.repeat(64),
            byteSize: 10,
            sourceRelativePath: candidate['relativePath'],
          }
        },
      },
    }
  }

  function makeInputs(options: { error?: Error; entries?: unknown[] } = {}) {
    const prepared: Array<{ runId: string; taskId: string }> = []
    const cleaned: string[] = []
    return {
      prepared,
      cleaned,
      deps: {
        prepareArtifactInputs: async (runId: string, taskId: string) => {
          prepared.push({ runId, taskId })
          if (options.error !== undefined) throw options.error
          return { dir: '/fake-inputs-dir', entries: options.entries ?? [] }
        },
        cleanupArtifactInputs: async (runId: string) => {
          cleaned.push(runId)
        },
      },
    }
  }

  it('Reviewer Run：run.start 先拉输入清单，initialize 带 artifactInputs+dir（成对）', async () => {
    const inputs = makeInputs({
      entries: [
        {
          artifactId: ARTIFACT_ID,
          title: 'Builder report',
          mediaType: 'text/markdown',
          byteSize: 10,
          sha256: 'c'.repeat(64),
        },
      ],
    })
    const h = await makeHarness({ managerDeps: { ...inputs.deps } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    expect(inputs.prepared).toEqual([
      { runId: RUN_ID, taskId: '33333333-3333-4333-8333-333333333333' },
    ])
    const init = h.runtimes[0]!.stdin[0] as Extract<RuntimeCommand, { type: 'runtime.initialize' }>
    expect(init.payload.artifactInputs).toEqual([
      {
        artifactId: ARTIFACT_ID,
        title: 'Builder report',
        mediaType: 'text/markdown',
        byteSize: 10,
        sha256: 'c'.repeat(64),
      },
    ])
    expect(init.payload.artifactInputsDir).toBe('/fake-inputs-dir')
  })

  it('Builder Run（无已发布 Artifact）：initialize 不携带输入字段（pair 规则）', async () => {
    const inputs = makeInputs()
    const h = await makeHarness({ managerDeps: { ...inputs.deps } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const init = h.runtimes[0]!.stdin[0] as Extract<RuntimeCommand, { type: 'runtime.initialize' }>
    expect(init.payload.artifactInputs).toBeUndefined()
    expect(init.payload.artifactInputsDir).toBeUndefined()
  })

  it('输入准备失败（如 digest 不符）→ run.start 拒绝：ack false 透传错误码，不 spawn', async () => {
    const inputs = makeInputs({
      error: Object.assign(new Error('digest mismatch'), { code: 'ARTIFACT_HASH_MISMATCH' }),
    })
    const h = await makeHarness({ managerDeps: { ...inputs.deps } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    expect(h.runtimes).toHaveLength(0)
    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect((ack?.payload['error'] as { code: string }).code).toBe('ARTIFACT_HASH_MISMATCH')
  })

  it('manifest 超限错误码（#64：ARTIFACT_INPUT_MANIFEST_TOO_LARGE）→ ack false 显式透传，不 spawn', async () => {
    // Hub input-manifest 对 >64 条已发布 Artifact 的专用拒绝码必须原样出现在
    // run.start 的 ack error.code 上（WireErrorSchema code），语义显式可归因。
    const inputs = makeInputs({
      error: Object.assign(new Error('manifest exceeds the 64-entry cap'), {
        code: 'ARTIFACT_INPUT_MANIFEST_TOO_LARGE',
      }),
    })
    const h = await makeHarness({ managerDeps: { ...inputs.deps } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    expect(h.runtimes).toHaveLength(0)
    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect((ack?.payload['error'] as { code: string }).code).toBe(
      'ARTIFACT_INPUT_MANIFEST_TOO_LARGE',
    )
  })

  it('artifact.candidate 帧 → 采集（workspace realpath）→ 双受众事件：owner 带来源路径，project 不带', async () => {
    const a = makeCollector()
    const h = await makeHarness({ managerDeps: { artifactCollector: a.collector } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(stdoutArtifactCandidate(RUN_ID))
    // 采集是异步链：让微任务队列排空。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]?.workspacePath).toBe(await realpath(workspaceDir))
    const runEvents = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
    expect(runEvents).toHaveLength(2)
    const owner = runEvents.find((e) => e.audience === 'owner')
    const project = runEvents.find((e) => e.audience === 'project')
    const ownerArtifact = (owner?.event as { artifact?: Record<string, unknown> }).artifact
    const projectArtifact = (project?.event as { artifact?: Record<string, unknown> }).artifact
    expect(ownerArtifact).toMatchObject({
      artifactId: ARTIFACT_ID,
      sourceRelativePath: 'reports/out.md',
    })
    expect(projectArtifact).toMatchObject({ artifactId: ARTIFACT_ID })
    expect(projectArtifact).not.toHaveProperty('sourceRelativePath')
  })

  it('路径攻击（采集拒绝）→ 不产生 candidate 事件，Run 继续运行', async () => {
    const a = makeCollector({
      error: Object.assign(new Error('escapes the workspace'), {
        code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
      }),
    })
    const h = await makeHarness({ managerDeps: { artifactCollector: a.collector } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(stdoutArtifactCandidate(RUN_ID))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.sentFrames().filter((f) => f.type === 'run.event')).toHaveLength(0)
    expect(h.supervisor.isActive(RUN_ID)).toBe(true)
  })

  it('Run 终态（run.completed）→ 输入副本目录清理被触发', async () => {
    const inputs = makeInputs()
    const a = makeCollector()
    const h = await makeHarness({ managerDeps: { ...inputs.deps, artifactCollector: a.collector } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'run.completed',
        payload: { runId: RUN_ID, dshSessionId: 'session-1' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inputs.cleaned).toEqual([RUN_ID])
  })
})

describe('#88 终态回收：runtime.shutdown 主动释放 + 宽限信号升级', () => {
  /** 手动时钟：按序点火未清除的计时器（fireNext 返回是否有可点火的）。 */
  function manualTimers() {
    interface Entry {
      id: number
      fn: () => void
      cleared: boolean
      fired: boolean
    }
    let seq = 0
    const entries: Entry[] = []
    const timers: RunManagerTimers = {
      setTimeout: ((fn: () => void, _ms?: number) => {
        seq += 1
        entries.push({ id: seq, fn, cleared: false, fired: false })
        return seq
      }) as unknown as typeof setTimeout,
      clearTimeout: ((id: unknown) => {
        const entry = entries.find((x) => x.id === id)
        if (entry !== undefined) entry.cleared = true
      }) as unknown as typeof clearTimeout,
    }
    const fireNext = (): boolean => {
      const entry = entries.find((x) => !x.cleared && !x.fired)
      if (entry === undefined) return false
      entry.fired = true
      entry.fn()
      return true
    }
    return { timers, fireNext }
  }

  function completedFrame(runId: string): string {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.completed',
      payload: { runId, dshSessionId: 'session-1' },
    })
  }

  it('run.completed 终态 → 下发 runtime.shutdown；Runtime 退出即释放容量，零信号升级', async () => {
    const kit = manualTimers()
    const h = await makeHarness({ managerDeps: { timers: kit.timers } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(completedFrame(RUN_ID))

    // 终态单一收敛点即发 runtime.shutdown（协议帧，bridge/bin 收敛后 EOF 退出）。
    const shutdown = h.runtimes[0]!.stdin.find((c) => c.type === 'runtime.shutdown')
    expect(shutdown).toBeDefined()
    expect((shutdown as Extract<RuntimeCommand, { type: 'runtime.shutdown' }>).payload.runId).toBe(
      RUN_ID,
    )

    // Runtime 按约退出 → 容量立即释放，宽限计时器清除，绝不发信号杀已退进程。
    h.runtimes[0]!.emitExit(0, null)
    expect(h.supervisor.isActive(RUN_ID)).toBe(false)
    expect(h.supervisor.activeRunIds()).toEqual([])
    expect(kit.fireNext()).toBe(false) // 升级计时器已全部清除
    expect(h.runtimes[0]!.terminateCount).toBe(0)
    expect(h.runtimes[0]!.forceKillCount).toBe(0)
  })

  it('shutdown 宽限到期仍滞留 → SIGTERM；再宽限仍滞留 → SIGKILL（硬超时降为最后兜底）', async () => {
    const kit = manualTimers()
    const h = await makeHarness({ managerDeps: { timers: kit.timers } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(completedFrame(RUN_ID))

    expect(kit.fireNext()).toBe(true) // 第一段宽限到期
    expect(h.runtimes[0]!.terminateCount).toBe(1)
    expect(h.runtimes[0]!.forceKillCount).toBe(0)
    expect(kit.fireNext()).toBe(true) // 第二段宽限到期
    expect(h.runtimes[0]!.forceKillCount).toBe(1)
    expect(kit.fireNext()).toBe(false) // 升级链收敛，无更多计时器
  })

  it('runtime.fatal 终态同样走 shutdown 释放（同一收敛点，不只 completed）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'runtime.fatal',
        payload: { runId: RUN_ID, code: 'INTERNAL_ERROR', summary: 'boom' },
      }),
    )
    expect(h.runtimes[0]!.stdin.some((c) => c.type === 'runtime.shutdown')).toBe(true)
  })

  it('本地已终态的 Run 收到迟到 run.cancel → 只回 ack，绝不再打扰 Runtime', async () => {
    // Hub 心跳收敛（终态仍 active → admin run.cancel）与 Node 正常 shutdown 释放
    // 之间存在竞态窗：cancel 到达时本地已终态，免打扰守卫按 finalFacts 判定。
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(completedFrame(RUN_ID))
    const stdinBefore = h.runtimes[0]!.stdin.length

    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: 'c-late',
      sentAt: new Date().toISOString(),
      type: 'run.cancel',
      payload: { commandId: 'c9c9c9c9-c9c9-4999-8999-c9c9c9c9c9c9', runId: RUN_ID, cause: 'admin' },
    } as NodeDownstream)

    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({
      commandId: 'c9c9c9c9-c9c9-4999-8999-c9c9c9c9c9c9',
      accepted: true,
    })
    expect(h.runtimes[0]!.stdin.length).toBe(stdinBefore) // 不再下发任何帧
    expect(h.runtimes[0]!.stdin.some((c) => c.type === 'run.cancel')).toBe(false)
  })

  it('supervisor lost（runtime 已死）终态路径不发 shutdown——没有可收的对象', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitExit(1, null) // Runtime 无终态帧即死 → runtime_lost 归因
    const shutdown = h.runtimes[0]!.stdin.find((c) => c.type === 'runtime.shutdown')
    expect(shutdown).toBeUndefined()
  })
})
