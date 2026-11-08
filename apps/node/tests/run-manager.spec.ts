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
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, chmod, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  NodeDownstream,
  ProjectedRunEvent,
  RunContextStateWire,
  RunContextStateEntry,
  RunProjectContextManifestEntry,
  RunWorkInputReceipt,
  RuntimeCommand,
  WorkInputManifestEntry,
} from '@whalepod/protocol'
import { contextStateDigestInput, RunStartSchema } from '@whalepod/protocol'
import {
  MemoryContextReceiptOutbox,
  SqliteContextReceiptOutbox,
} from '../src/context/receipt-outbox.js'
import type { RunContextReceiptOutbox } from '../src/context/receipt-outbox.js'
import { MemoryContextStateStore } from '../src/context/state-store.js'
import {
  MemoryWorkInputReceiptStore,
  type WorkInputReceiptStore,
} from '../src/work/receipt-store.js'
import { CommandStore } from '../src/spool/command-store.js'
import { EventStore } from '../src/spool/event-store.js'
import { SecretStore } from '../src/secret/store.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { RuntimeSupervisor } from '../src/supervisor/runtime-supervisor.js'
import { RunManager, type RunManagerTimers } from '../src/run/run-manager.js'
import {
  MemoryRunTerminalCleanupStore,
  SqliteRunTerminalCleanupStore,
} from '../src/run/terminal-cleanup.js'
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

/** #256：轮询到条件成立或超时（等待异步链不得用固定 sleep 猜时长）。 */
async function waitForValue<T>(
  probe: () => T | undefined,
  describe: string,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error(`${describe}（等待上限 ${timeoutMs}ms，判据是条件成立而不是固定时长）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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
  readonly pid: number
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
      const pid = 2_000_000 + runtimes.length + 1 // 超出系统 pid 范围：ps 探针必查无此进程
      const runtime: FakeRuntime = {
        runId: spec.runId,
        pid,
        stdin: [],
        terminateCount: 0,
        forceKillCount: 0,
        emitStdout: (line) => ctx.onStdout(line),
        emitExit: (code, signal) => ctx.onExit(code, signal),
      }
      runtimes.push(runtime)
      return {
        pid,
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
    /** 同一测试里模拟进程重启时，第二实例用不同 workspace 名避免注册冲突。 */
    workspaceName?: string
    /** P1-15：RunManager 的 Artifact 依赖注入（collector / inputs）。 */
    managerDeps?: Record<string, unknown>
    /** 捕获结构化日志（观测面断言用）。 */
    logs?: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>
  } = {},
): Promise<Harness> {
  let online = options.online ?? true
  const registry = new WorkspaceRegistry(join(root, 'registry.db'))
  const workspace = await registry.register(workspaceDir, {
    name: options.workspaceName ?? 'ws-1',
  })
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
      if (!online) return false // 离线时丢弃：spool 仍持有，重连补发
      sent.push(frame)
      return true
    },
    runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
    homeDir: '/Users/testhome',
    stateDir: root,
    packsRoot: join(root, 'plugin-packs'),
    deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    dshDistributionVersion: '0.1.0-rc.8',
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

/** 记录 RunManager 是否真的把一次回执的状态/序号/outbox 放进 store 事务。 */
class RecordingWorkInputReceiptStore implements WorkInputReceiptStore {
  transactions = 0
  private readonly inner = new MemoryWorkInputReceiptStore()

  snapshot(runId: string, manifestDigest: string) {
    return this.inner.snapshot(runId, manifestDigest)
  }
  nextSeq(runId: string, manifestDigest: string) {
    return this.inner.nextSeq(runId, manifestDigest)
  }
  addDelivered(runId: string, manifestDigest: string, itemIds: readonly string[]) {
    this.inner.addDelivered(runId, manifestDigest, itemIds)
  }
  addRead(runId: string, manifestDigest: string, itemId: string) {
    this.inner.addRead(runId, manifestDigest, itemId)
  }
  enqueue(receipt: RunWorkInputReceipt) {
    this.inner.enqueue(receipt)
  }
  pending() {
    return this.inner.pending()
  }
  removePending(runId: string, manifestDigest: string, receiptSeq: number) {
    this.inner.removePending(runId, manifestDigest, receiptSeq)
  }
  transaction<T>(fn: () => T): T {
    this.transactions += 1
    return this.inner.transaction(fn)
  }
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

/** runtime.ready 帧：profileDigest 是「收到方对照点」（#288），缺省与 runStartFrame 的固化值一致。 */
function stdoutRuntimeReady(runId: string, profileDigest: string = 'a'.repeat(64)): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'runtime.ready',
    payload: { runId, dshSessionId: 'session-1', profileDigest },
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

  it('切片⑤ resume：initialize 的 resumeSessionId 透传、dshHomePath 指向**来源 Run** 的 home', async () => {
    const h = await makeHarness()
    const SOURCE_RUN_ID = '99999999-9999-4999-8999-999999999999'
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        resumeOfRunId: SOURCE_RUN_ID,
        resumeSessionId: `whalepod-run-${SOURCE_RUN_ID}`,
      }),
    )
    const init = h.runtimes[0]!.stdin[0]!
    expect(init.type).toBe('runtime.initialize')
    const payload = (init as Extract<RuntimeCommand, { type: 'runtime.initialize' }>).payload
    // 装载身份直达 Runtime（ctx.agents.resume 的对象）。
    expect(payload.resumeSessionId).toBe(`whalepod-run-${SOURCE_RUN_ID}`)
    // DSH_HOME 复用来源 Run 的隔离目录——新 runId 的 home 里没有旧日志，
    // persisted load 会找不到存储（探针 #176 的复用前提，Node 侧的落点）。
    expect(payload.dshHomePath).toContain(join('runtime-home', SOURCE_RUN_ID))
    expect(payload.dshHomePath).not.toContain(join('runtime-home', RUN_ID))
  })

  it('切片⑧ 审批档位：initialize 透传 approvalPolicy（缺省不携带 = 旧语义）', async () => {
    // 同一 harness 起两个 Run（makeHarness 不能调两次——workspace 名会撞）：第一个
    // 不带字段（对照），第二个带 full_access。
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const init1 = h.runtimes[0]!.stdin[0]! as Extract<
      RuntimeCommand,
      { type: 'runtime.initialize' }
    >
    expect(init1.payload.approvalPolicy).toBeUndefined()

    const FULL_ACCESS_RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        runId: FULL_ACCESS_RUN_ID,
        approvalPolicy: 'full_access',
      }),
    )
    const init2 = h.runtimes[1]!.stdin[0] as Extract<RuntimeCommand, { type: 'runtime.initialize' }>
    expect(init2.payload.approvalPolicy).toBe('full_access')
  })

  it('RD-03c1 工具策略：machine toolPolicy 原样透传进 runtime.initialize', async () => {
    const h = await makeHarness()
    const toolPolicy = {
      mode: 'draft',
      allowedToolNames: ['read', 'glob'],
      mandateVersion: 4,
      workKey: '01905f7c-0000-7000-8000-000000000904',
    }
    // wire 形状先过生产 schema：字段拼错/被 strict 拒绝必须在 Node 入口就红，
    // 而不是靠 hand-built cast 混过去（helper 的 messageId 是 m-1，需换合法 UUID）。
    const frame = { ...runStartFrame(h.workspaceId, { toolPolicy }), messageId: randomUUID() }
    expect(RunStartSchema.parse(frame).payload.toolPolicy).toEqual(toolPolicy)
    await h.manager.handleFrame(frame)
    const init = h.runtimes[0]!.stdin[0]!
    expect(init.type).toBe('runtime.initialize')
    const payload = (init as Extract<RuntimeCommand, { type: 'runtime.initialize' }>).payload
    expect(payload.toolPolicy).toEqual(toolPolicy)
  })

  it('RD-03c1 工具策略：人类 Run 缺省不携带 toolPolicy', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const init = h.runtimes[0]!.stdin[0]!
    expect(init.type).toBe('runtime.initialize')
    const payload = (init as Extract<RuntimeCommand, { type: 'runtime.initialize' }>).payload
    expect(payload.toolPolicy).toBeUndefined()
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

  it('#501：同一 commandId 并发重投 → 等前一条完成，只 spawn 一个且不清理在途输入', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let prepareCalls = 0
    const cleaned: string[] = []
    const h = await makeHarness({
      managerDeps: {
        prepareArtifactInputs: async () => {
          prepareCalls += 1
          await gate
          return { dir: join(root, 'artifact-inputs'), entries: [] }
        },
        cleanupArtifactInputs: async (runId: string) => {
          cleaned.push(runId)
        },
      },
    })
    const first = h.manager.handleFrame(runStartFrame(h.workspaceId))
    const second = h.manager.handleFrame(runStartFrame(h.workspaceId))
    // 首条停在 prepare 里；修复前第二条会在这里并发进入崩溃恢复分支（负控红在
    // prepareCalls=2）。
    await waitForValue(() => (prepareCalls > 0 ? true : undefined), '首条 run.start 进入 prepare')
    release()
    await Promise.all([first, second])

    // 真实缺陷路径里第二个进程会在主键冲突后退出；fake driver 自身不退出，这里
    // 显式复刻这次退出——它绝不能按 runId 删掉存活 Runtime 的行/句柄。
    for (const extra of h.runtimes.slice(1)) extra.emitExit(1, null)

    // 后来者等待前一条完成后再按 isActive 早退：不重复 prepare/spawn，也不误清输入。
    expect(prepareCalls).toBe(1)
    expect(cleaned).toEqual([])
    expect(h.runtimes).toHaveLength(1)
    expect(h.supervisor.isActive(RUN_ID)).toBe(true)
    const db = openStateDatabase(join(root, 'supervisor.db'))
    const activeRows = db
      .prepare('select run_id, pid from active_runtime where run_id = ?')
      .all(RUN_ID) as Array<{ run_id: string; pid: number }>
    db.close()
    expect(activeRows).toEqual([{ run_id: RUN_ID, pid: h.runtimes[0]!.pid }])
    expect(h.commandStore.isAcked(COMMAND_ID)).toBe(true)
    expect(h.commandStore.pending()).toHaveLength(0)
    const acks = h.sentFrames().filter((f) => f.type === 'command.ack')
    expect(acks).toHaveLength(2)
    expect(acks.every((ack) => ack.payload['accepted'] === true)).toBe(true)
    expect(h.sentFrames().filter((f) => f.type === 'run.snapshot')).toHaveLength(0)
  })

  it('#501：首条启动被拒后，等待中的重投回放同一拒绝，不误标 lost', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let prepareCalls = 0
    const cleaned: string[] = []
    const h = await makeHarness({
      managerDeps: {
        prepareArtifactInputs: async () => {
          prepareCalls += 1
          await gate
          const error = new Error('artifact digest mismatch')
          ;(error as Error & { code?: string }).code = 'ARTIFACT_HASH_MISMATCH'
          throw error
        },
        cleanupArtifactInputs: async (runId: string) => {
          cleaned.push(runId)
        },
      },
    })
    const first = h.manager.handleFrame(runStartFrame(h.workspaceId))
    const second = h.manager.handleFrame(runStartFrame(h.workspaceId))
    await waitForValue(() => (prepareCalls > 0 ? true : undefined), '首条 run.start 进入 prepare')
    release()
    await Promise.all([first, second])

    expect(prepareCalls).toBe(1)
    expect(h.runtimes).toHaveLength(0)
    const acks = h.sentFrames().filter((f) => f.type === 'command.ack')
    expect(acks).toHaveLength(2)
    for (const ack of acks) {
      expect(ack.payload['accepted']).toBe(false)
      expect((ack.payload['error'] as { code: string }).code).toBe('ARTIFACT_HASH_MISMATCH')
    }
    // 从未 spawn 的 Run 不得被标成 RUNTIME_LOST；重投也不得再触发一次清理。
    expect(h.sentFrames().filter((f) => f.type === 'run.snapshot')).toHaveLength(0)
    expect(cleaned).toEqual([RUN_ID])
  })

  it('#501：串行化按 runId 隔离，不同 Run 的启动不互相阻塞', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstGated = false
    const h = await makeHarness({
      managerDeps: {
        prepareArtifactInputs: async (runId: string) => {
          if (runId === RUN_ID) {
            firstGated = true
            await gate
          }
          return { dir: join(root, 'artifact-inputs'), entries: [] }
        },
      },
    })
    const first = h.manager.handleFrame(runStartFrame(h.workspaceId))
    await waitForValue(() => (firstGated ? true : undefined), '首个 Run 进入 prepare')

    const OTHER_RUN_ID = '99999999-9999-4999-8999-999999999999'
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        commandId: '99999999-9999-4999-8999-999999999998',
        runId: OTHER_RUN_ID,
      }),
    )
    expect(h.runtimes).toHaveLength(1)
    expect(h.runtimes[0]!.runId).toBe(OTHER_RUN_ID)

    release()
    await first
    expect(h.runtimes).toHaveLength(2)
  })

  it('#501：首次结果落库失败 → 仍照发 ack 并留 error 日志，启动不被阻断', async () => {
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const h = await makeHarness({ logs })
    // 本地 spool 写失败（磁盘满 / IO 错 / WAL 锁）：处理结果已发生，ack 必须照发；
    // 代价是同一 commandId 若再重投会按「未处理」重新走一次（#181 N1 同口径）。
    h.commandStore.recordOutcome = () => {
      throw new Error('disk full')
    }
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    expect(h.runtimes).toHaveLength(1)
    const ack = h.sentFrames().findLast((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(true)
    expect(
      logs.some(
        (entry) =>
          entry.level === 'error' && entry.msg.includes('run.start outcome persist failed'),
      ),
    ).toBe(true)
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

  it('run.mandate_invalidated → stdin 转发 + ack；重复 commandId 只回放 ack', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    const frame = {
      protocolVersion: 1 as const,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.mandate_invalidated' as const,
      payload: {
        commandId: 'e1e1e1e1-e1e1-4e11-8e11-e1e1e1e1e1e1',
        runId: RUN_ID,
        mandateId: '01905f7c-0000-7000-8000-000000000906',
        reason: 'mandate_revoked' as const,
      },
    }
    await h.manager.handleFrame(frame)
    const forwarded = h.runtimes[0]!.stdin.filter((c) => c.type === 'run.mandate_invalidated')
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]!.payload).toMatchObject({
      runId: RUN_ID,
      reason: 'mandate_revoked',
    })
    expect(h.sentFrames().findLast((f) => f.type === 'command.ack')?.payload).toMatchObject({
      commandId: frame.payload.commandId,
      accepted: true,
    })

    await h.manager.handleFrame(frame)
    expect(h.runtimes[0]!.stdin.filter((c) => c.type === 'run.mandate_invalidated')).toHaveLength(1)
    expect(h.sentFrames().findLast((f) => f.type === 'command.ack')?.payload).toMatchObject({
      commandId: frame.payload.commandId,
      accepted: true,
    })
  })

  it('本地已终态的 Run 收到 run.mandate_invalidated → 只回 ack', async () => {
    const h = await makeHarness()
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
    const stdinBefore = h.runtimes[0]!.stdin.length
    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.mandate_invalidated',
      payload: {
        commandId: 'e2e2e2e2-e2e2-4e22-8e22-e2e2e2e2e2e2',
        runId: RUN_ID,
        mandateId: '01905f7c-0000-7000-8000-000000000906',
        reason: 'mandate_expired',
      },
    } as NodeDownstream)
    expect(h.runtimes[0]!.stdin.length).toBe(stdinBefore)
    expect(h.sentFrames().findLast((f) => f.type === 'command.ack')?.payload).toMatchObject({
      commandId: 'e2e2e2e2-e2e2-4e22-8e22-e2e2e2e2e2e2',
      accepted: true,
    })
  })

  it('Runtime 不在时 run.mandate_invalidated → 只回 ack，不 spawn', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.mandate_invalidated',
      payload: {
        commandId: 'e3e3e3e3-e3e3-4e33-8e33-e3e3e3e3e3e3',
        runId: '99999999-9999-4999-8999-999999999999',
        mandateId: '01905f7c-0000-7000-8000-000000000906',
        reason: 'mandate_revoked',
      },
    } as NodeDownstream)
    expect(h.runtimes).toHaveLength(0)
    expect(h.sentFrames().findLast((f) => f.type === 'command.ack')?.payload).toMatchObject({
      commandId: 'e3e3e3e3-e3e3-4e33-8e33-e3e3e3e3e3e3',
      accepted: true,
    })
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

  it('runtime.ready 回报的 profileDigest ≠ 固化的 Revision digest → run.failed PROFILE_MISMATCH + 终止 runtime', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID, 'f'.repeat(64)))
    const failed = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
      .find((e) => e.event.type === 'run.failed')
    expect(failed).toBeDefined()
    expect((failed!.event as { code: string }).code).toBe('PROFILE_MISMATCH')
    expect(h.runtimes[0]!.terminateCount).toBe(1)
  })

  it('runtime.ready 回报的 profileDigest 一致 → 照常 running（不误杀）', async () => {
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    const events = h
      .sentFrames()
      .filter((f) => f.type === 'run.event')
      .map((f) => f.payload as unknown as ProjectedRunEvent)
    expect(events.find((e) => e.event.type === 'run.failed')).toBeUndefined()
    expect(h.runtimes[0]!.terminateCount).toBe(0)
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
    // #256：等采集链真的产出（可观察条件），不猜 20ms。
    await waitForValue(
      () => (a.calls.length > 0 ? true : undefined),
      'artifact 采集链未在超时内产出（collector 从未被调用）',
    )
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
    // #256：负向断言（不得产事件）。先等采集链真的跑过（可观察：collector 被调），
    // 再排空一个宏任务让 catch 分支走完——不用固定 20ms 猜时长。
    await waitForValue(
      () => (a.calls.length > 0 ? true : undefined),
      'artifact 采集链未在超时内运行（collector 从未被调用）',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    // #256：等清理真的发生（可观察条件），不猜 20ms。
    await waitForValue(
      () => (inputs.cleaned.includes(RUN_ID) ? true : undefined),
      'run.completed 未在超时内触发输入副本清理',
    )
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

describe('ADR-0027：项目上下文交付与两级回执', () => {
  it('passes the pinned manifest to runtime.initialize and forwards cumulative receipts', async () => {
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entryDigest = createHash('sha256').update(body).digest('hex')
    const snapshotDigest = createHash('sha256').update('snapshot-pc05a').digest('hex')
    const runId = RUN_ID
    const nonce = createHash('sha256')
      .update(`${snapshotDigest}|${runId}`)
      .digest('hex')
      .slice(0, 16)
    const entryId = '01905f7c-0000-7000-8000-000000000951'
    const entry: RunProjectContextManifestEntry = {
      entryId,
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: entryDigest,
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const headerText = `[project-context:${nonce}]\n- ${entryId} 预算结论`
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const entriesDir = join(root, 'runtime-context', runId)
    await mkdir(entriesDir, { recursive: true })
    await writeFile(join(entriesDir, entryId), body)
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => ({
          runId,
          dir: entriesDir,
          snapshotId: '01905f7c-0000-7000-8000-000000000961',
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
        runtimeContextDirFor: () => entriesDir,
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId: '01905f7c-0000-7000-8000-000000000961',
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )

    const initialize = h.runtimes[0]!.stdin[0] as Extract<
      RuntimeCommand,
      { type: 'runtime.initialize' }
    >
    expect(initialize.payload.projectContext).toMatchObject({
      snapshotId: '01905f7c-0000-7000-8000-000000000961',
      digest: snapshotDigest,
      headerDigest,
      entriesDir,
      entries: [entry],
    })

    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(runId))
    const at = new Date().toISOString()
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: at,
        type: 'runtime.context_receipt',
        payload: {
          kind: 'delivered',
          runId,
          snapshotId: '01905f7c-0000-7000-8000-000000000961',
          headerDigest,
          nonceMatched: true,
          entriesDelivered: [entryId],
          at,
        },
      }),
    )
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: at,
        type: 'runtime.context_receipt',
        payload: {
          kind: 'read',
          runId,
          snapshotId: '01905f7c-0000-7000-8000-000000000961',
          entryId,
          digestVerified: true,
          byteSize: entry.byteSize,
          at,
        },
      }),
    )

    const receipts = h
      .sentFrames()
      .filter((frame) => frame.type === 'run.context_receipt')
      .map((frame) => frame.payload)
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({
      receiptSeq: 1,
      headerDigest,
      nonceMatched: true,
      entriesDelivered: [entryId],
      entriesRead: [],
      missing: [],
      digestVerified: true,
    })
    expect(receipts[1]).toMatchObject({
      receiptSeq: 2,
      entriesDelivered: [entryId],
      entriesRead: [entryId],
      readEvents: [{ entryId, digestVerified: true, byteSize: entry.byteSize, at }],
      missing: [],
      digestVerified: true,
    })

    // ADR-0027 §6（PC-05b-3）：终态帧只登记清理任务，Runtime 还在管时不删副本。
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'run.completed',
        payload: { runId, dshSessionId: 'session-1' },
      }),
    )
    expect(existsSync(entriesDir)).toBe(true)
    // Runtime 退出确认后才执行删除。
    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (existsSync(entriesDir) ? undefined : true),
      'Runtime 退出后未在超时内清理 runtime-context 目录',
    )
  })

  it('persists receipts offline, replays on reconnect and clears only after Hub ack', async () => {
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entryDigest = createHash('sha256').update(body).digest('hex')
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b2').digest('hex')
    const runId = RUN_ID
    const entryId = '01905f7c-0000-7000-8000-000000000951'
    const snapshotId = '01905f7c-0000-7000-8000-000000000961'
    const entry: RunProjectContextManifestEntry = {
      entryId,
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: entryDigest,
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const headerText = `[project-context:0123456789abcdef]\n- ${entryId} 预算结论`
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const entriesDir = join(root, 'runtime-context', runId)
    await mkdir(entriesDir, { recursive: true })
    await writeFile(join(entriesDir, entryId), body)
    const outbox = new MemoryContextReceiptOutbox()
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => ({
          runId,
          dir: entriesDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
        contextReceiptOutbox: outbox,
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(runId))
    h.setOnline(false)
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'runtime.context_receipt',
        payload: {
          kind: 'delivered',
          runId,
          snapshotId,
          headerDigest,
          nonceMatched: true,
          entriesDelivered: [entryId],
          at: new Date().toISOString(),
        },
      }),
    )
    expect(outbox.pending()).toHaveLength(1)
    expect(h.sentFrames().filter((frame) => frame.type === 'run.context_receipt')).toHaveLength(0)

    h.setOnline(true)
    h.manager.onReconnect()
    const replayed = h.sentFrames().filter((frame) => frame.type === 'run.context_receipt')
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.payload).toMatchObject({ receiptSeq: 1, entriesDelivered: [entryId] })

    // 高 highestSeq 不能连带删除更低的未 ack 项：Hub 允许 seq 空洞。
    const firstReceipt = outbox.pending()[0]!.receipt
    outbox.enqueue({ ...firstReceipt, receiptSeq: 2 }, new Date().toISOString())
    const ack = {
      type: 'run.context_receipt_ack' as const,
      payload: {
        runId,
        snapshotId,
        receiptSeq: 1,
        highestSeq: 2,
        result: 'accepted' as const,
      },
    }
    await h.manager.handleFrame(ack as NodeDownstream)
    expect(outbox.pending().map((item) => item.receipt.receiptSeq)).toEqual([2])
    // 重复 ack 幂等：既不复活已删项，也不误删 seq 2。
    await h.manager.handleFrame(ack as NodeDownstream)
    expect(outbox.pending().map((item) => item.receipt.receiptSeq)).toEqual([2])
    await h.manager.handleFrame({
      ...ack,
      payload: { ...ack.payload, receiptSeq: 2 },
    } as NodeDownstream)
    expect(outbox.pending()).toHaveLength(0)

    // late/rejected 的 highestSeq=0：只删被 ack 的精确 seq，其他待发项保留。
    outbox.enqueue({ ...firstReceipt, receiptSeq: 3 }, new Date().toISOString())
    outbox.enqueue({ ...firstReceipt, receiptSeq: 4 }, new Date().toISOString())
    await h.manager.handleFrame({
      type: 'run.context_receipt_ack',
      payload: { runId, snapshotId, receiptSeq: 3, highestSeq: 0, result: 'late' },
    } as NodeDownstream)
    expect(outbox.pending().map((item) => item.receipt.receiptSeq)).toEqual([4])
    await h.manager.handleFrame({
      type: 'run.context_receipt_ack',
      payload: {
        runId,
        snapshotId,
        receiptSeq: 4,
        highestSeq: 0,
        result: 'rejected',
        reason: 'digest_not_verified',
      },
    } as NodeDownstream)
    expect(outbox.pending()).toHaveLength(0)
  })

  it('replays a receipt persisted by a previous manager process from SQLite', async () => {
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entryDigest = createHash('sha256').update(body).digest('hex')
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b2-restart').digest('hex')
    const runId = RUN_ID
    const entryId = '01905f7c-0000-7000-8000-000000000951'
    const snapshotId = '01905f7c-0000-7000-8000-000000000961'
    const entry: RunProjectContextManifestEntry = {
      entryId,
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: entryDigest,
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const headerText = `[project-context:0123456789abcdef]\n- ${entryId} 预算结论`
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const entriesDir = join(root, 'runtime-context', runId)
    await mkdir(entriesDir, { recursive: true })
    await writeFile(join(entriesDir, entryId), body)
    const outboxPath = join(root, 'context-receipt-outbox.sqlite')
    const firstOutbox = new SqliteContextReceiptOutbox(outboxPath)
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => ({
          runId,
          dir: entriesDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
        contextReceiptOutbox: firstOutbox,
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(runId))
    h.setOnline(false)
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'runtime.context_receipt',
        payload: {
          kind: 'delivered',
          runId,
          snapshotId,
          headerDigest,
          nonceMatched: true,
          entriesDelivered: [entryId],
          at: new Date().toISOString(),
        },
      }),
    )
    expect(firstOutbox.pending(runId)).toHaveLength(1)
    firstOutbox.closeForTest()

    // 模拟进程重启：同一 SQLite 文件交给新 manager，重连后按 seq 重放。
    const secondOutbox = new SqliteContextReceiptOutbox(outboxPath)
    const restarted = await makeHarness({
      workspaceName: 'ws-restarted',
      managerDeps: { contextReceiptOutbox: secondOutbox },
    })
    restarted.manager.onReconnect()
    const replayed = restarted.sentFrames().filter((frame) => frame.type === 'run.context_receipt')
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.payload).toMatchObject({ receiptSeq: 1, entriesDelivered: [entryId] })
    await restarted.manager.handleFrame({
      type: 'run.context_receipt_ack',
      payload: { runId, snapshotId, receiptSeq: 1, highestSeq: 1, result: 'accepted' },
    } as NodeDownstream)
    expect(secondOutbox.pending()).toHaveLength(0)
    secondOutbox.closeForTest()
  })

  it('logs persist_failed and sends nothing when the outbox rejects the receipt', async () => {
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entryDigest = createHash('sha256').update(body).digest('hex')
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b2-persist').digest('hex')
    const runId = RUN_ID
    const entryId = '01905f7c-0000-7000-8000-000000000951'
    const snapshotId = '01905f7c-0000-7000-8000-000000000961'
    const entry: RunProjectContextManifestEntry = {
      entryId,
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: entryDigest,
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const headerText = `[project-context:0123456789abcdef]\n- ${entryId} 预算结论`
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const entriesDir = join(root, 'runtime-context', runId)
    await mkdir(entriesDir, { recursive: true })
    await writeFile(join(entriesDir, entryId), body)
    const throwingOutbox: RunContextReceiptOutbox = {
      enqueue: () => {},
      enqueueNext: () => {
        throw new Error('disk full')
      },
      pending: () => [],
      ack: () => {},
      size: () => 0,
    }
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
    const h = await makeHarness({
      logs,
      managerDeps: {
        prepareProjectContext: async () => ({
          runId,
          dir: entriesDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
        contextReceiptOutbox: throwingOutbox,
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(runId))
    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'runtime.context_receipt',
        payload: {
          kind: 'delivered',
          runId,
          snapshotId,
          headerDigest,
          nonceMatched: true,
          entriesDelivered: [entryId],
          at: new Date().toISOString(),
        },
      }),
    )
    expect(h.sentFrames().filter((frame) => frame.type === 'run.context_receipt')).toHaveLength(0)
    expect(
      logs.some(
        (entryLog) =>
          entryLog.msg === 'project context receipt persist failed' &&
          entryLog.fields?.['event'] === 'persist_failed' &&
          entryLog.fields?.['component'] === 'node.context',
      ),
    ).toBe(true)
  })

  it('cleans up a partially prepared runtime-context directory when run.start is rejected', async () => {
    const runId = RUN_ID
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000951',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const entriesDir = join(root, 'runtime-context', runId)
    await mkdir(entriesDir, { recursive: true })
    await writeFile(join(entriesDir, 'partial-entry'), body)
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => {
          throw Object.assign(new Error('bundle digest mismatch'), {
            code: 'CONTEXT_DIGEST_MISMATCH',
          })
        },
        runtimeContextDirFor: () => entriesDir,
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId: '01905f7c-0000-7000-8000-000000000961',
          digest: createHash('sha256').update('snapshot-pc05a').digest('hex'),
          headerText: '[project-context:0123456789abcdef]',
          headerDigest: createHash('sha256')
            .update('[project-context:0123456789abcdef]')
            .digest('hex'),
          manifest: [entry],
        },
      }),
    )
    expect(h.runtimes).toHaveLength(0)
    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect((ack?.payload['error'] as { code: string }).code).toBe('CONTEXT_DIGEST_MISMATCH')
    await waitForValue(
      () => (existsSync(entriesDir) ? undefined : true),
      'run.start 拒绝路径未清理 runtime-context 目录',
    )
  })

  it('run.start 拒绝后的清理失败同样进持久队列，下一轮重试成功', async () => {
    const runId = RUN_ID
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000955',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const entriesDir = join(root, 'runtime-context', runId)
    await mkdir(join(entriesDir, 'sub'), { recursive: true })
    await writeFile(join(entriesDir, 'sub', 'partial-entry'), body)
    await chmod(entriesDir, 0o500)
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: -1000,
        runtimeContextDirFor: () => entriesDir,
        prepareProjectContext: async () => {
          throw Object.assign(new Error('bundle digest mismatch'), {
            code: 'CONTEXT_DIGEST_MISMATCH',
          })
        },
      },
    })
    try {
      await h.manager.handleFrame(
        runStartFrame(h.workspaceId, {
          projectContext: {
            snapshotId: '01905f7c-0000-7000-8000-000000000965',
            digest: createHash('sha256').update('snapshot-pc05b3-reject-fail').digest('hex'),
            headerText: '[project-context:0123456789abcdef]',
            headerDigest: createHash('sha256')
              .update('[project-context:0123456789abcdef]')
              .digest('hex'),
            manifest: [entry],
          },
        }),
      )
      const ack = h.sentFrames().findLast((frame) => frame.type === 'command.ack')
      expect(ack?.payload['accepted']).toBe(false)
      await waitForValue(
        () => (store.get(RUN_ID)?.state === 'cleanup_pending' ? true : undefined),
        '拒绝路径清理失败未进入 cleanup_pending',
      )
      expect(store.get(RUN_ID)?.attempts).toBe(1)
    } finally {
      await chmod(entriesDir, 0o700)
    }

    expect(h.manager.runTerminalCleanupTick()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(entriesDir)).toBe(false)
  })

  it('拒绝路径的清理与队列写入同时失败：内存保留事实，下一轮补登记并清理', async () => {
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000956',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const entriesDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(join(entriesDir, 'sub'), { recursive: true })
    await writeFile(join(entriesDir, 'sub', 'partial-entry'), body)
    await chmod(entriesDir, 0o500)
    const store = new MemoryRunTerminalCleanupStore()
    const originalSchedule = store.schedule.bind(store)
    let failures = 1
    store.schedule = (input) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('database is busy')
      }
      originalSchedule(input)
    }
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: -1000,
        runtimeContextDirFor: () => entriesDir,
        prepareProjectContext: async () => {
          throw Object.assign(new Error('bundle digest mismatch'), {
            code: 'CONTEXT_DIGEST_MISMATCH',
          })
        },
      },
    })
    try {
      await h.manager.handleFrame(
        runStartFrame(h.workspaceId, {
          projectContext: {
            snapshotId: '01905f7c-0000-7000-8000-000000000966',
            digest: createHash('sha256').update('snapshot-pc05b3-reject-retry').digest('hex'),
            headerText: '[project-context:0123456789abcdef]',
            headerDigest: createHash('sha256')
              .update('[project-context:0123456789abcdef]')
              .digest('hex'),
            manifest: [entry],
          },
        }),
      )
      expect(
        h.sentFrames().findLast((frame) => frame.type === 'command.ack')?.payload,
      ).toMatchObject({
        accepted: false,
      })
      // 删除失败 + 队列写失败：本进程队列里暂时没有任务，但 facts 不能丢。
      expect(store.get(RUN_ID)).toBeUndefined()
    } finally {
      await chmod(entriesDir, 0o700)
    }

    expect(h.manager.runTerminalCleanupTick()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(entriesDir)).toBe(false)
  })

  function contextFixture() {
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entryDigest = createHash('sha256').update(body).digest('hex')
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b').digest('hex')
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000952',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000202',
      digest: entryDigest,
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const headerText = '[project-context:0123456789abcdef]\n- 预算结论'
    return {
      body,
      entry,
      snapshotId: '01905f7c-0000-7000-8000-000000000962',
      snapshotDigest,
      headerText,
      headerDigest: createHash('sha256').update(headerText).digest('hex'),
      entriesDir: join(root, 'runtime-context', RUN_ID),
      start: {
        snapshotId: '01905f7c-0000-7000-8000-000000000962',
        digest: snapshotDigest,
        headerText,
        headerDigest: createHash('sha256').update(headerText).digest('hex'),
        manifest: [entry],
      },
    }
  }

  function contextState(
    fixture: ReturnType<typeof contextFixture>,
    entries: RunContextStateEntry[],
    stateVersion = 1,
  ): RunContextStateWire {
    return {
      commandId: randomUUID(),
      runId: RUN_ID,
      snapshotId: fixture.snapshotId,
      stateVersion,
      stateDigest: createHash('sha256')
        .update(contextStateDigestInput(stateVersion, entries))
        .digest('hex'),
      entries,
      generatedAt: new Date().toISOString(),
    }
  }

  async function preparedHarness(fixture: ReturnType<typeof contextFixture>) {
    await mkdir(fixture.entriesDir, { recursive: true })
    await writeFile(join(fixture.entriesDir, fixture.entry.entryId), fixture.body)
    const store = new MemoryContextStateStore()
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => ({
          runId: RUN_ID,
          dir: fixture.entriesDir,
          snapshotId: fixture.snapshotId,
          snapshotDigest: fixture.snapshotDigest,
          headerText: fixture.headerText,
          headerDigest: fixture.headerDigest,
          entries: [fixture.entry],
        }),
        contextStateStore: store,
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId, { projectContext: fixture.start }))
    return { h, store }
  }

  it('writes the initial frozen state file, then deletes unread revoked copies and acks', async () => {
    const fixture = contextFixture()
    const { h } = await preparedHarness(fixture)
    const initial = JSON.parse(await readFile(join(fixture.entriesDir, 'state.json'), 'utf8')) as {
      stateVersion: number
      paused: boolean
      entries: RunContextStateEntry[]
    }
    expect(initial.stateVersion).toBe(0)
    expect(initial.paused).toBe(false)
    expect(initial.entries[0]).toMatchObject({ entryId: fixture.entry.entryId, state: 'frozen' })

    const revoked: RunContextStateEntry[] = [
      {
        entryId: fixture.entry.entryId,
        kind: 'observation',
        state: 'retracted',
        currentAuthorizationGeneration: null,
        reason: 'entry_corrected',
      },
    ]
    await h.manager.handleFrame({
      type: 'run.context_state',
      payload: contextState(fixture, revoked),
    } as NodeDownstream)

    await expect(readFile(join(fixture.entriesDir, fixture.entry.entryId))).rejects.toThrow()
    const applied = JSON.parse(await readFile(join(fixture.entriesDir, 'state.json'), 'utf8')) as {
      stateVersion: number
      entries: RunContextStateEntry[]
    }
    expect(applied.stateVersion).toBe(1)
    expect(applied.entries[0]?.state).toBe('retracted')
    const ack = h.sentFrames().findLast((frame) => frame.type === 'context.state_ack')
    expect(ack?.payload).toMatchObject({ stateVersion: 1, failedEntryIds: [] })
  })

  it('deletes copies revoked before run.start when the bundle is later prepared', async () => {
    const fixture = contextFixture()
    await mkdir(fixture.entriesDir, { recursive: true })
    await writeFile(join(fixture.entriesDir, fixture.entry.entryId), fixture.body)
    const store = new MemoryContextStateStore()
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => ({
          runId: RUN_ID,
          dir: fixture.entriesDir,
          snapshotId: fixture.snapshotId,
          snapshotDigest: fixture.snapshotDigest,
          headerText: fixture.headerText,
          headerDigest: fixture.headerDigest,
          entries: [fixture.entry],
        }),
        contextStateStore: store,
      },
    })
    // 撤权帧先于 run.start 到达：此时还没有 prepared，状态只落库。
    await h.manager.handleFrame({
      type: 'run.context_state',
      payload: contextState(fixture, [
        {
          entryId: fixture.entry.entryId,
          kind: 'observation',
          state: 'retracted',
          currentAuthorizationGeneration: null,
          reason: 'entry_corrected',
        },
      ]),
    } as NodeDownstream)
    expect(store.get(RUN_ID)?.stateVersion).toBe(1)

    await h.manager.handleFrame(runStartFrame(h.workspaceId, { projectContext: fixture.start }))
    await expect(readFile(join(fixture.entriesDir, fixture.entry.entryId))).rejects.toThrow()
    const stateFile = JSON.parse(
      await readFile(join(fixture.entriesDir, 'state.json'), 'utf8'),
    ) as { entries: RunContextStateEntry[]; paused: boolean }
    expect(stateFile.entries[0]?.state).toBe('retracted')
    expect(stateFile.paused).toBe(false)
  })

  it('rejects an older full state without deleting or downgrading the applied state', async () => {
    const fixture = contextFixture()
    const { h, store } = await preparedHarness(fixture)
    const revoked: RunContextStateEntry[] = [
      {
        entryId: fixture.entry.entryId,
        kind: 'observation',
        state: 'retracted',
        currentAuthorizationGeneration: null,
        reason: 'entry_corrected',
      },
    ]
    await h.manager.handleFrame({
      type: 'run.context_state',
      payload: contextState(fixture, revoked, 2),
    } as NodeDownstream)
    const stale = contextState(
      fixture,
      [
        {
          entryId: fixture.entry.entryId,
          kind: 'observation',
          state: 'frozen',
          currentAuthorizationGeneration: null,
          reason: null,
        },
      ],
      1,
    )
    await h.manager.handleFrame({ type: 'run.context_state', payload: stale } as NodeDownstream)
    expect(store.get(RUN_ID)?.stateVersion).toBe(2)
    await expect(readFile(join(fixture.entriesDir, fixture.entry.entryId))).rejects.toThrow()
    const ack = h.sentFrames().findLast((frame) => frame.type === 'context.state_ack')
    expect(ack?.payload).toMatchObject({ stateVersion: 2 })
  })

  it('rejects a full state whose digest does not match its entries', async () => {
    const fixture = contextFixture()
    const { h } = await preparedHarness(fixture)
    await h.manager.handleFrame({
      type: 'run.context_state',
      payload: {
        ...contextState(fixture, [
          {
            entryId: fixture.entry.entryId,
            kind: 'observation',
            state: 'retracted',
            currentAuthorizationGeneration: null,
            reason: 'entry_corrected',
          },
        ]),
        stateDigest: 'c'.repeat(64),
      },
    } as NodeDownstream)
    await expect(readFile(join(fixture.entriesDir, fixture.entry.entryId))).resolves.toBeDefined()
    const ack = h.sentFrames().findLast((frame) => frame.type === 'command.ack')
    expect(ack?.payload).toMatchObject({ accepted: false })
  })

  it('keeps a read copy when the entry is revoked', async () => {
    const fixture = contextFixture()
    const { h, store } = await preparedHarness(fixture)
    store.markRead(RUN_ID, fixture.snapshotId, fixture.entry.entryId)
    const revoked: RunContextStateEntry[] = [
      {
        entryId: fixture.entry.entryId,
        kind: 'observation',
        state: 'source_tombstoned',
        currentAuthorizationGeneration: '2',
        reason: 'source_revoked',
      },
    ]
    await h.manager.handleFrame({
      type: 'run.context_state',
      payload: contextState(fixture, revoked),
    } as NodeDownstream)
    await expect(readFile(join(fixture.entriesDir, fixture.entry.entryId))).resolves.toBeDefined()
  })

  it('quarantines deletion failures and fails closed when quarantine also fails', async () => {
    const fixture = contextFixture()
    const { h } = await preparedHarness(fixture)
    // 条目变成目录：unlink 失败；quarantine 目标被普通文件占住：rename 也失败。
    await rm(join(fixture.entriesDir, fixture.entry.entryId))
    await mkdir(join(fixture.entriesDir, fixture.entry.entryId))
    await mkdir(join(root, 'runtime-home', RUN_ID), { recursive: true })
    await writeFile(join(root, 'runtime-home', RUN_ID, 'quarantine'), 'blocked')
    const revoked: RunContextStateEntry[] = [
      {
        entryId: fixture.entry.entryId,
        kind: 'observation',
        state: 'retracted',
        currentAuthorizationGeneration: null,
        reason: 'entry_corrected',
      },
    ]
    await h.manager.handleFrame({
      type: 'run.context_state',
      payload: contextState(fixture, revoked),
    } as NodeDownstream)
    const applied = JSON.parse(await readFile(join(fixture.entriesDir, 'state.json'), 'utf8')) as {
      paused: boolean
    }
    expect(applied.paused).toBe(true)
    const ack = h.sentFrames().findLast((frame) => frame.type === 'context.state_ack')
    expect(ack?.payload['failedEntryIds']).toEqual([fixture.entry.entryId])
  })

  it('requests a full state pull on heartbeat mismatch and accepts a matching heartbeat', async () => {
    const fixture = contextFixture()
    const { h } = await preparedHarness(fixture)
    await h.manager.handleFrame({
      type: 'context.state_sync',
      payload: {
        commandId: randomUUID(),
        runId: RUN_ID,
        snapshotId: fixture.snapshotId,
        stateVersion: 1,
        stateDigest: 'b'.repeat(64),
        at: new Date().toISOString(),
      },
    } as NodeDownstream)
    const pull = h.sentFrames().findLast((frame) => frame.type === 'context.state_pull')
    expect(pull?.payload).toMatchObject({ knownStateVersion: 0 })

    const frozen: RunContextStateEntry[] = [
      {
        entryId: fixture.entry.entryId,
        kind: 'observation',
        state: 'frozen',
        currentAuthorizationGeneration: null,
        reason: null,
      },
    ]
    const state = contextState(fixture, frozen)
    await h.manager.handleFrame({ type: 'run.context_state', payload: state } as NodeDownstream)
    await h.manager.handleFrame({
      type: 'context.state_sync',
      payload: {
        commandId: randomUUID(),
        runId: RUN_ID,
        snapshotId: fixture.snapshotId,
        stateVersion: state.stateVersion,
        stateDigest: state.stateDigest,
        at: new Date().toISOString(),
      },
    } as NodeDownstream)
    expect(h.sentFrames().filter((frame) => frame.type === 'context.state_pull')).toHaveLength(1)
  })
})

describe('ADR-0028：工作输入交付与回执', () => {
  const workKey = '01905f7c-0000-7000-8000-000000000971'
  const itemId = '01905f7c-0000-7000-8000-000000000981'
  const unknownItemId = '01905f7c-0000-7000-8000-000000000982'
  const manifestDigest = createHash('sha256').update('manifest-rd02a2b').digest('hex')

  function manifestEntry(
    body: string,
    overrides: Partial<WorkInputManifestEntry> = {},
  ): WorkInputManifestEntry {
    return {
      inboxItemId: itemId,
      sourceType: 'task_message',
      sourceId: '01905f7c-0000-7000-8000-000000000991',
      sourceVersion: '1',
      sourceDigest: createHash('sha256').update('source-1').digest('hex'),
      bodyDigest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      authorizationGeneration: 'gen-1',
      title: '需求澄清',
      ...overrides,
    }
  }

  function workInputStart(entry: WorkInputManifestEntry): Record<string, unknown> {
    return {
      workInput: {
        manifestDigest,
        manifest: { version: 'rd02a2.v1', workKey, entries: [entry] },
      },
    }
  }

  function runtimeReceipt(payload: Record<string, unknown>): string {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'runtime.work_input_receipt',
      payload,
    })
  }

  it('passes pinned inputs to runtime.initialize and forwards cumulative receipts', async () => {
    const body = '预算口径：含税，单位万元。\n'
    const entry = manifestEntry(body)
    const entriesDir = join(root, 'runtime-work-inputs', RUN_ID)
    await mkdir(entriesDir, { recursive: true })
    await writeFile(join(entriesDir, itemId), body)
    const store = new MemoryWorkInputReceiptStore()
    const preparedCalls: Array<{ runId: string; workKey: string; digest: string }> = []
    const cleaned: string[] = []
    const h = await makeHarness({
      managerDeps: {
        prepareWorkInputs: async (
          runId: string,
          input: { manifestDigest: string; manifest: { workKey: string } },
        ) => {
          preparedCalls.push({
            runId,
            workKey: input.manifest.workKey,
            digest: input.manifestDigest,
          })
          return { dir: entriesDir, workKey, manifestDigest, entries: [entry] }
        },
        cleanupWorkInputs: async (id: string) => {
          cleaned.push(id)
        },
        workInputReceiptStore: store,
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId, workInputStart(entry)))

    expect(preparedCalls).toEqual([{ runId: RUN_ID, workKey, digest: manifestDigest }])
    const initialize = h.runtimes[0]!.stdin[0] as Extract<
      RuntimeCommand,
      { type: 'runtime.initialize' }
    >
    expect(initialize.payload.workInputs).toEqual({
      workKey,
      manifestDigest,
      entries: [entry],
      entriesDir,
    })

    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    const at = new Date().toISOString()
    // 清单外条目必须在 Node 侧过滤，绝不进入上行回执。
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'delivered',
        runId: RUN_ID,
        workKey,
        manifestDigest,
        entriesDelivered: [itemId, unknownItemId],
        at,
      }),
    )
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'read',
        runId: RUN_ID,
        workKey,
        manifestDigest,
        inboxItemId: itemId,
        digestVerified: true,
        byteSize: entry.byteSize,
        at,
      }),
    )

    const receipts = h
      .sentFrames()
      .filter((frame) => frame.type === 'run.work_input_receipt')
      .map((frame) => frame.payload)
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({
      runId: RUN_ID,
      workKey,
      manifestDigest,
      receiptSeq: 1,
      entriesDelivered: [itemId],
      entriesRead: [],
      readEvents: [],
      missing: [],
      digestVerified: true,
    })
    expect(receipts[1]).toMatchObject({
      receiptSeq: 2,
      entriesDelivered: [itemId],
      entriesRead: [itemId],
      readEvents: [{ inboxItemId: itemId, digestVerified: true, byteSize: entry.byteSize, at }],
      missing: [],
      digestVerified: true,
    })

    h.runtimes[0]!.emitStdout(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'run.completed',
        payload: { runId: RUN_ID, dshSessionId: 'session-1' },
      }),
    )
    await waitForValue(
      () => (cleaned.includes(RUN_ID) ? true : undefined),
      'run.completed 未在超时内触发 runtime-work-inputs 清理',
    )
  })

  it('wraps receipt state, sequence and outbox in one store transaction', async () => {
    const body = '# 输入\n'
    const entry = manifestEntry(body)
    const store = new RecordingWorkInputReceiptStore()
    const h = await makeHarness({
      managerDeps: {
        prepareWorkInputs: async () => ({
          dir: join(root, 'runtime-work-inputs', RUN_ID),
          workKey,
          manifestDigest,
          entries: [entry],
        }),
        workInputReceiptStore: store,
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId, workInputStart(entry)))
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'delivered',
        runId: RUN_ID,
        workKey,
        manifestDigest,
        entriesDelivered: [itemId],
        at: new Date().toISOString(),
      }),
    )
    expect(store.transactions).toBe(1)
    expect(h.sentFrames().filter((frame) => frame.type === 'run.work_input_receipt')).toHaveLength(
      1,
    )
  })

  it('drops a read receipt for an item outside the pinned manifest', async () => {
    const body = '# 输入\n'
    const entry = manifestEntry(body)
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const h = await makeHarness({
      logs,
      managerDeps: {
        prepareWorkInputs: async () => ({
          dir: join(root, 'runtime-work-inputs', RUN_ID),
          workKey,
          manifestDigest,
          entries: [entry],
        }),
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId, workInputStart(entry)))
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'read',
        runId: RUN_ID,
        workKey,
        manifestDigest,
        inboxItemId: unknownItemId,
        digestVerified: true,
        byteSize: entry.byteSize,
        at: new Date().toISOString(),
      }),
    )
    expect(h.sentFrames().filter((frame) => frame.type === 'run.work_input_receipt')).toHaveLength(
      0,
    )
    expect(
      logs.some(
        (log) =>
          log.level === 'warn' &&
          log.msg === 'work input read receipt for an unknown item dropped' &&
          log.fields?.['component'] === 'node.work_input',
      ),
    ).toBe(true)
  })

  it('drops a receipt whose manifest identity does not match the prepared copy', async () => {
    const entry = manifestEntry('# 输入\n')
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const h = await makeHarness({
      logs,
      managerDeps: {
        prepareWorkInputs: async () => ({
          dir: join(root, 'runtime-work-inputs', RUN_ID),
          workKey,
          manifestDigest,
          entries: [entry],
        }),
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId, workInputStart(entry)))
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'delivered',
        runId: RUN_ID,
        workKey,
        manifestDigest: 'c'.repeat(64),
        entriesDelivered: [itemId],
        at: new Date().toISOString(),
      }),
    )
    expect(h.sentFrames().filter((frame) => frame.type === 'run.work_input_receipt')).toHaveLength(
      0,
    )
    expect(
      logs.some(
        (log) =>
          log.level === 'warn' &&
          log.msg === 'work input receipt manifest mismatch dropped' &&
          log.fields?.['component'] === 'node.work_input',
      ),
    ).toBe(true)
  })

  it('fails closed when run.start pins inputs but the node has no downloader', async () => {
    const entry = manifestEntry('# 输入\n')
    const h = await makeHarness()
    await h.manager.handleFrame(runStartFrame(h.workspaceId, workInputStart(entry)))
    expect(h.runtimes).toHaveLength(0)
    const ack = h.sentFrames().find((frame) => frame.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect((ack?.payload['error'] as { code: string }).code).toBe('CONTEXT_UNAVAILABLE')
  })

  it('keeps receipts written while offline and replays them on reconnect', async () => {
    const body = '# 输入\n'
    const entry = manifestEntry(body)
    const store = new MemoryWorkInputReceiptStore()
    const h = await makeHarness({
      managerDeps: {
        prepareWorkInputs: async () => ({
          dir: join(root, 'runtime-work-inputs', RUN_ID),
          workKey,
          manifestDigest,
          entries: [entry],
        }),
        workInputReceiptStore: store,
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId, workInputStart(entry)))
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    const at = new Date().toISOString()
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'delivered',
        runId: RUN_ID,
        workKey,
        manifestDigest,
        entriesDelivered: [itemId],
        at,
      }),
    )
    expect(store.pending()).toHaveLength(0)

    h.setOnline(false)
    h.runtimes[0]!.emitStdout(
      runtimeReceipt({
        kind: 'read',
        runId: RUN_ID,
        workKey,
        manifestDigest,
        inboxItemId: itemId,
        digestVerified: true,
        byteSize: entry.byteSize,
        at,
      }),
    )
    expect(store.pending()).toHaveLength(1)
    expect(h.sentFrames().filter((frame) => frame.type === 'run.work_input_receipt')).toHaveLength(
      1,
    )

    h.setOnline(true)
    h.manager.onReconnect()
    const receipts = h
      .sentFrames()
      .filter((frame) => frame.type === 'run.work_input_receipt')
      .map((frame) => frame.payload)
    expect(receipts.map((receipt) => receipt['receiptSeq'])).toEqual([1, 2])
    expect(receipts[1]).toMatchObject({ entriesRead: [itemId] })
    expect(store.pending()).toHaveLength(0)
  })
})

describe('ADR-0027 §6（PC-05b-3）：终态清理队列与 blocked 清理', () => {
  const homeFor = (runId = RUN_ID): string => join(root, 'runtime-home', runId)

  function terminatedFrame(runId = RUN_ID): string {
    return JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.completed',
      payload: { runId, dshSessionId: 'session-1' },
    })
  }

  async function seedHome(home: string): Promise<void> {
    await mkdir(join(home, 'sessions', 'project', 'session-1'), { recursive: true })
    await writeFile(join(home, 'sessions', 'project', 'session-1', 'session.jsonl'), '{}\n')
    await writeFile(join(home, 'settings.yaml'), 'model: replay\n')
    await mkdir(join(home, 'spill', 'session-abc'), { recursive: true })
    await writeFile(join(home, 'spill', 'session-abc', 'bash.txt'), 'SPILLED_BODY')
    await mkdir(join(home, 'quarantine'), { recursive: true })
    await writeFile(join(home, 'quarantine', 'entry'), 'REVOKED_BODY')
  }

  it('full：终态帧先登记；Runtime 退出后才删 runtime-context/spill/quarantine，保留 session 与非 session', async () => {
    const home = homeFor()
    await seedHome(home)
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, 'entry'), 'context body')
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        runtimeContextDirFor: () => ctxDir,
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(terminatedFrame())

    // 终态帧只登记：Runtime 仍在管，绝不先删 session/spill/runtime-context/quarantine。
    expect(store.get(RUN_ID)).toMatchObject({ state: 'pending', entryCount: 0 })
    expect(existsSync(join(home, 'spill'))).toBe(true)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
    expect(existsSync(join(home, 'quarantine'))).toBe(true)
    expect(existsSync(ctxDir)).toBe(true)

    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      'Runtime 退出后终态清理未完成',
    )
    expect(existsSync(ctxDir)).toBe(false)
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'quarantine'))).toBe(false)
    // full：session 与非 session 文件保持原样（ADR-0009 resume 依赖）。
    expect(existsSync(join(home, 'sessions', 'project', 'session-1', 'session.jsonl'))).toBe(true)
    expect(existsSync(join(home, 'settings.yaml'))).toBe(true)
  })

  it('blocked：非空项目上下文 Run 删除 home 下全部子项，但保留 home 根', async () => {
    const home = homeFor()
    await seedHome(home)
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000953',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const snapshotId = '01905f7c-0000-7000-8000-000000000963'
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b3').digest('hex')
    const headerText = '[project-context:0123456789abcdef]\n- 预算结论'
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, entry.entryId), body)
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => ({
          runId: RUN_ID,
          dir: ctxDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    h.runtimes[0]!.emitStdout(terminatedFrame())
    expect(store.get(RUN_ID)).toMatchObject({ state: 'pending', entryCount: 1 })
    expect(existsSync(join(home, 'sessions'))).toBe(true)

    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      'blocked 清理未完成',
    )
    expect(existsSync(home)).toBe(true)
    expect(readdirSync(home)).toEqual([])
    expect(existsSync(ctxDir)).toBe(false)
  })

  it('spawn 后下发失败：run.start 拒绝不删活跃 session，退出确认后才 blocked 清理', async () => {
    const home = homeFor()
    await seedHome(home)
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000954',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const snapshotId = '01905f7c-0000-7000-8000-000000000964'
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b3-reject').digest('hex')
    const headerText = '[project-context:0123456789abcdef]\n- 预算结论'
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, entry.entryId), body)
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => ({
          runId: RUN_ID,
          dir: ctxDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
      },
    })
    // spawn 成功后 stdin 已关闭：run.start 进 catch，但 Runtime 仍在管。
    h.supervisor.dispatchToRuntime = () => {
      throw new Error('stdin closed')
    }
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    const ack = h.sentFrames().findLast((frame) => frame.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect(store.get(RUN_ID)?.state).toBe('pending')
    expect(existsSync(join(home, 'sessions', 'project', 'session-1', 'session.jsonl'))).toBe(true)

    h.runtimes[0]!.emitExit(1, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      'Runtime 退出后未执行 rejected run 的 blocked 清理',
    )
    expect(readdirSync(home)).toEqual([])
  })

  it('本 Run 的 Runtime 仍活跃时 tick 只 deferred，不删 session/spill', async () => {
    const home = homeFor()
    await seedHome(home)
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: -1000,
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(terminatedFrame())
    expect(store.get(RUN_ID)?.state).toBe('pending')

    // 终态帧已到、shutdown 宽限中：本 Run 的 Runtime 仍是活跃进程，绝不能删。
    expect(h.manager.runTerminalCleanupTick()).toBe(0)
    expect(store.get(RUN_ID)?.state).toBe('deferred')
    expect(existsSync(join(home, 'sessions'))).toBe(true)
    expect(existsSync(join(home, 'spill'))).toBe(true)

    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      'Runtime 退出后清理未完成',
    )
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
  })

  it('清理队列写失败不阻断终态收敛与 runtime.shutdown', async () => {
    const home = homeFor()
    await seedHome(home)
    const store = new MemoryRunTerminalCleanupStore()
    store.schedule = () => {
      throw new Error('database is busy')
    }
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const h = await makeHarness({
      managerDeps: { terminalCleanupStore: store },
      logs,
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    expect(() => h.runtimes[0]!.emitStdout(terminatedFrame())).not.toThrow()
    expect(h.runtimes[0]!.stdin.some((command) => command.type === 'runtime.shutdown')).toBe(true)
    expect(
      logs.some(
        (entry) =>
          entry.msg === 'run terminal cleanup schedule failed' &&
          entry.fields?.['event'] === 'schedule_failed',
      ),
    ).toBe(true)
  })

  it('resume Run spawn 前失败：只清自己的 runtime-context，来源 home 的 session/spill 不动', async () => {
    const sourceRunId = '99999999-9999-4999-8999-999999999999'
    const sourceHome = join(root, 'runtime-home', sourceRunId)
    await seedHome(sourceHome)
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, 'partial'), 'context body')
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000956',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const h = await makeHarness({
      managerDeps: {
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => {
          throw Object.assign(new Error('bundle digest mismatch'), {
            code: 'CONTEXT_DIGEST_MISMATCH',
          })
        },
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        resumeOfRunId: sourceRunId,
        resumeSessionId: 'session-source',
        projectContext: {
          snapshotId: '01905f7c-0000-7000-8000-000000000966',
          digest: createHash('sha256').update('snapshot-pc05b3-resume-fail').digest('hex'),
          headerText: '[project-context:0123456789abcdef]',
          headerDigest: createHash('sha256')
            .update('[project-context:0123456789abcdef]')
            .digest('hex'),
          manifest: [entry],
        },
      }),
    )
    expect(h.runtimes).toHaveLength(0)
    const ack = h.sentFrames().findLast((frame) => frame.type === 'command.ack')
    expect(ack?.payload['accepted']).toBe(false)
    expect(existsSync(ctxDir)).toBe(false)
    expect(existsSync(join(sourceHome, 'sessions', 'project', 'session-1', 'session.jsonl'))).toBe(
      true,
    )
    expect(existsSync(join(sourceHome, 'spill'))).toBe(true)
  })

  it('facts 缺失时从 run.start spool 重建 entryCount：拒绝路径按 blocked 清自己的 home', async () => {
    const home = homeFor()
    await seedHome(home)
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000957',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const h = await makeHarness({
      managerDeps: {
        prepareProjectContext: async () => {
          throw Object.assign(new Error('bundle digest mismatch'), {
            code: 'CONTEXT_DIGEST_MISMATCH',
          })
        },
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId: '01905f7c-0000-7000-8000-000000000967',
          digest: createHash('sha256').update('snapshot-pc05b3-spool-fallback').digest('hex'),
          headerText: '[project-context:0123456789abcdef]',
          headerDigest: createHash('sha256')
            .update('[project-context:0123456789abcdef]')
            .digest('hex'),
          manifest: [entry],
        },
      }),
    )
    // 本进程没写 putFacts；兜底必须从 spool 得到 entryCount=1 并按 blocked 删 home。
    expect(readdirSync(home)).toEqual([])
  })

  it('resume Run ready 后终态：blocked 清理共享 home（Hub 负责把血缘标 blocked）', async () => {
    const sourceRunId = '88888888-8888-4888-8888-888888888888'
    const sourceHome = join(root, 'runtime-home', sourceRunId)
    await seedHome(sourceHome)
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000958',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const snapshotId = '01905f7c-0000-7000-8000-000000000968'
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b3-resume').digest('hex')
    const headerText = '[project-context:0123456789abcdef]\n- 预算结论'
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, entry.entryId), body)
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => ({
          runId: RUN_ID,
          dir: ctxDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
      },
    })
    await h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        resumeOfRunId: sourceRunId,
        resumeSessionId: 'session-source',
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    h.runtimes[0]!.emitStdout(stdoutRuntimeReady(RUN_ID))
    h.runtimes[0]!.emitStdout(terminatedFrame())
    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      'resume Run 的共享 home 清理未完成',
    )
    expect(store.get(RUN_ID)).toMatchObject({
      entryCount: 1,
      ownsHome: false,
      sessionReady: true,
    })
    expect(store.getFacts(RUN_ID)?.sessionReady).toBe(true)
    expect(readdirSync(sourceHome)).toEqual([])
    expect(existsSync(ctxDir)).toBe(false)
  })

  it('重启后的 lost 快照带持久化 dshSessionId（Hub 才能传播 blocked 血缘）', async () => {
    const sourceRunId = '55555555-5555-4555-8555-555555555555'
    const store = new MemoryRunTerminalCleanupStore()
    store.putFacts(
      {
        runId: RUN_ID,
        homePath: join(root, 'runtime-home', sourceRunId),
        entryCount: 0,
        ownsHome: false,
        sessionReady: true,
        dshSessionId: 'session-persisted',
      },
      '2026-11-03T00:00:00.000Z',
    )
    const h = await makeHarness({ managerDeps: { terminalCleanupStore: store } })
    const start = runStartFrame(h.workspaceId, {
      resumeOfRunId: sourceRunId,
      resumeSessionId: 'session-persisted',
    })
    h.commandStore.record({
      commandId: COMMAND_ID,
      runId: RUN_ID,
      type: 'run.start',
      payload: start.payload,
    })
    await h.manager.handleFrame({
      protocolVersion: 1,
      messageId: 'status-1',
      sentAt: new Date().toISOString(),
      type: 'run.status_request',
      payload: { runId: RUN_ID },
    } as NodeDownstream)
    const snapshot = h.sentFrames().findLast((frame) => frame.type === 'run.snapshot')
    expect(snapshot?.payload['dshSessionId']).toBe('session-persisted')
  })

  it('共享 home 仍被活跃 Runtime 使用时 deferred，使用者退出后下一轮删除', async () => {
    const home = homeFor()
    await seedHome(home)
    let inUse = true
    const checked: Array<{ homePath: string; exceptRunId: string }> = []
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: -1000,
        isRuntimeHomeInUse: (homePath: string, exceptRunId: string) => {
          checked.push({ homePath, exceptRunId })
          return inUse
        },
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(terminatedFrame())
    h.runtimes[0]!.emitExit(0, null)

    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'deferred' ? true : undefined),
      '共享 home 未进入 deferred',
    )
    expect(checked).toContainEqual({ homePath: home, exceptRunId: RUN_ID })
    expect(existsSync(join(home, 'spill'))).toBe(true)

    inUse = false
    expect(h.manager.runTerminalCleanupTick()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(join(home, 'spill'))).toBe(false)
  })

  it('home 占用探测异常按 cleanup_pending 保留队列，不拖垮定时器', async () => {
    const home = homeFor()
    await seedHome(home)
    let broken = true
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: -1000,
        isRuntimeHomeInUse: () => {
          if (broken) throw new Error('database is busy')
          return false
        },
      },
    })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(terminatedFrame())
    h.runtimes[0]!.emitExit(0, null)

    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'cleanup_pending' ? true : undefined),
      '占用探测异常未收敛为 cleanup_pending',
    )
    expect(store.get(RUN_ID)?.attempts).toBe(1)
    expect(existsSync(join(home, 'spill'))).toBe(true)

    broken = false
    expect(h.manager.runTerminalCleanupTick()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(join(home, 'spill'))).toBe(false)
  })

  it('删除失败进入 cleanup_pending 并保留队列，下一轮重试成功', async () => {
    const home = homeFor()
    await seedHome(home)
    // 非空且不可写的目录：rmSync 在修复权限前必然失败（不同平台错误码不同，
    // 这里只断言“抛了、队列入 cleanup_pending”，不绑死平台码）。
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(join(ctxDir, 'sub'), { recursive: true })
    await writeFile(join(ctxDir, 'sub', 'entry'), 'context body')
    await chmod(ctxDir, 0o500)
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: -1000,
        runtimeContextDirFor: () => ctxDir,
      },
    })
    try {
      await h.manager.handleFrame(runStartFrame(h.workspaceId))
      h.runtimes[0]!.emitStdout(terminatedFrame())
      h.runtimes[0]!.emitExit(0, null)

      await waitForValue(
        () => (store.get(RUN_ID)?.state === 'cleanup_pending' ? true : undefined),
        '删除失败未进入 cleanup_pending',
      )
      expect(store.get(RUN_ID)).toMatchObject({ attempts: 1 })
      expect(store.get(RUN_ID)?.lastError).toBeTruthy()
      expect(existsSync(join(home, 'spill'))).toBe(true)
    } finally {
      await chmod(ctxDir, 0o700)
    }

    expect(h.manager.runTerminalCleanupTick()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(ctxDir)).toBe(false)
    expect(existsSync(join(home, 'spill'))).toBe(false)
  })

  it('非 owner 任务在 sessionReady=false 时只清 runtime-context，绝不删共享 home', async () => {
    const sourceHome = join(root, 'runtime-home', '77777777-7777-4777-8777-777777777777')
    await seedHome(sourceHome)
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, 'entry'), 'context body')
    const store = new MemoryRunTerminalCleanupStore()
    store.schedule({
      runId: RUN_ID,
      homePath: sourceHome,
      entryCount: 1,
      ownsHome: false,
      sessionReady: false,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-02T00:00:00.000Z',
    })
    const h = await makeHarness({
      managerDeps: { terminalCleanupStore: store, runtimeContextDirFor: () => ctxDir },
    })
    expect(h.manager.runTerminalCleanupTick()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(ctxDir)).toBe(false)
    expect(existsSync(join(sourceHome, 'sessions'))).toBe(true)
    expect(existsSync(join(sourceHome, 'spill'))).toBe(true)
  })

  it('启动清扫可先只清自有 home，共享 home 延后到首次连接后', async () => {
    const ownHome = homeFor()
    const sourceRunId = '44444444-4444-4444-8444-444444444444'
    const sharedHome = join(root, 'runtime-home', sourceRunId)
    await seedHome(ownHome)
    await seedHome(sharedHome)
    const store = new MemoryRunTerminalCleanupStore()
    store.schedule({
      runId: RUN_ID,
      homePath: ownHome,
      entryCount: 0,
      ownsHome: true,
      sessionReady: true,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-02T00:00:00.000Z',
    })
    store.schedule({
      runId: '33333333-3333-4333-8333-333333333333',
      homePath: sharedHome,
      entryCount: 0,
      ownsHome: false,
      sessionReady: true,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-02T00:00:00.000Z',
    })
    const h = await makeHarness({ managerDeps: { terminalCleanupStore: store } })

    expect(h.manager.startTerminalCleanup(false)).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(store.get('33333333-3333-4333-8333-333333333333')?.state).toBe('pending')
    expect(existsSync(join(sharedHome, 'spill'))).toBe(true)

    expect(h.manager.startTerminalCleanup()).toBe(1)
    expect(store.get('33333333-3333-4333-8333-333333333333')?.state).toBe('done')
    expect(existsSync(join(sharedHome, 'spill'))).toBe(false)
    expect(existsSync(join(sharedHome, 'sessions'))).toBe(true)
  })

  it('队列写失败后同一进程下一轮 tick 补登记并完成清理', async () => {
    const home = homeFor()
    await seedHome(home)
    const store = new MemoryRunTerminalCleanupStore()
    const originalSchedule = store.schedule.bind(store)
    let failed = false
    store.schedule = (input) => {
      if (!failed) {
        failed = true
        throw new Error('database is busy')
      }
      originalSchedule(input)
    }
    const h = await makeHarness({ managerDeps: { terminalCleanupStore: store } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(terminatedFrame())
    expect(store.get(RUN_ID)).toBeUndefined()
    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      'schedule 失败后的补登记未清理',
    )
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
  })

  it('启动对账：只有 facts、没有任务的 Run 也会被清扫（prepare 后崩溃窗口）', async () => {
    const home = homeFor()
    await seedHome(home)
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, 'entry'), 'context body')
    const store = new MemoryRunTerminalCleanupStore()
    store.putFacts(
      {
        runId: RUN_ID,
        homePath: home,
        entryCount: 0,
        ownsHome: true,
        sessionReady: false,
        dshSessionId: null,
      },
      '2026-11-03T00:00:00.000Z',
    )
    const h = await makeHarness({
      managerDeps: { terminalCleanupStore: store, runtimeContextDirFor: () => ctxDir },
    })
    expect(h.manager.startTerminalCleanup(false)).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(ctxDir)).toBe(false)
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
  })

  it('首次连接对账不清理仍在 prepare 的 run.start（facts 已写、尚未 spawn）', async () => {
    const home = homeFor()
    await seedHome(home)
    const body = '# 项目上下文\n预算结论：8 万\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000955',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const snapshotId = '01905f7c-0000-7000-8000-000000000965'
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b3-inflight').digest('hex')
    const headerText = '[project-context:0123456789abcdef]\n- 预算结论'
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, entry.entryId), body)
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    let prepareStarted!: () => void
    const started = new Promise<void>((resolve) => {
      prepareStarted = resolve
    })
    const store = new MemoryRunTerminalCleanupStore()
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => {
          prepareStarted()
          await prepareGate
          return {
            runId: RUN_ID,
            dir: ctxDir,
            snapshotId,
            snapshotDigest,
            headerText,
            headerDigest,
            entries: [entry],
          }
        },
      },
    })
    const starting = h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    await started
    // facts 已落（启动对账可见），但 spawn 尚未发生：首次连接后的启动清扫
    // 绝不能把它当“上次进程遗留的孤儿”。
    expect(store.getFacts(RUN_ID)?.entryCount).toBe(1)
    expect(h.manager.startTerminalCleanup()).toBe(0)
    expect(store.get(RUN_ID)).toBeUndefined()
    expect(existsSync(ctxDir)).toBe(true)
    expect(existsSync(join(home, 'spill'))).toBe(true)
    expect(existsSync(join(home, 'sessions', 'project', 'session-1', 'session.jsonl'))).toBe(true)

    releasePrepare()
    await starting
    expect(h.runtimes).toHaveLength(1)
    expect(h.sentFrames().findLast((frame) => frame.type === 'command.ack')?.payload).toMatchObject(
      {
        accepted: true,
      },
    )
    expect(existsSync(ctxDir)).toBe(true)
  })

  it('启动对账遇到未 ack 的 run.start 不清理：Hub 按同一 commandId 重投后仍能终态清理', async () => {
    const home = homeFor()
    await seedHome(home)
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000957',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const snapshotId = '01905f7c-0000-7000-8000-000000000967'
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b3-unacked').digest('hex')
    const headerText = '[project-context:0123456789abcdef]'
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, entry.entryId), body)
    const store = new MemoryRunTerminalCleanupStore()
    store.putFacts(
      {
        runId: RUN_ID,
        homePath: home,
        entryCount: 1,
        ownsHome: true,
        sessionReady: false,
        dshSessionId: null,
      },
      '2026-11-03T00:00:00.000Z',
    )
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => ({
          runId: RUN_ID,
          dir: ctxDir,
          snapshotId,
          snapshotDigest,
          headerText,
          headerDigest,
          entries: [entry],
        }),
      },
    })
    const frame = runStartFrame(h.workspaceId, {
      projectContext: {
        snapshotId,
        digest: snapshotDigest,
        headerText,
        headerDigest,
        manifest: [entry],
      },
    })
    // 上一进程在 prepare 中崩溃：command 仍在 spool、未 ack；Hub outbox 会重投。
    h.commandStore.record({
      commandId: COMMAND_ID,
      runId: RUN_ID,
      type: 'run.start',
      payload: (frame as { payload: unknown }).payload,
    })

    expect(h.manager.startTerminalCleanup()).toBe(0)
    expect(store.get(RUN_ID)).toBeUndefined()
    expect(existsSync(ctxDir)).toBe(true)
    expect(existsSync(join(home, 'spill'))).toBe(true)

    await h.manager.handleFrame(frame)
    expect(h.runtimes).toHaveLength(1)
    h.runtimes[0]!.emitStdout(terminatedFrame())
    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      '重投后的 Run 未完成终态清理（done 行毒化）',
    )
    expect(existsSync(ctxDir)).toBe(false)
  })

  it('已有 done 清理行的 Run 重新收到 run.start 时重开任务', async () => {
    const home = homeFor()
    await seedHome(home)
    const store = new MemoryRunTerminalCleanupStore()
    store.schedule({
      runId: RUN_ID,
      homePath: home,
      entryCount: 0,
      ownsHome: true,
      sessionReady: true,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-02T00:00:00.000Z',
    })
    store.markDone(RUN_ID, '2026-11-02T00:00:01.000Z')
    const h = await makeHarness({ managerDeps: { terminalCleanupStore: store } })

    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    // 上一生命周期的 done 行必须让位给这次 run.start，否则终态登记永远 no-op。
    expect(store.get(RUN_ID)).toBeUndefined()
    h.runtimes[0]!.emitStdout(terminatedFrame())
    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      '重开的清理任务未完成',
    )
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
  })

  it('tick 遇到仍在 prepare 的 run.start 只 deferred，不删已有任务副本', async () => {
    const home = homeFor()
    await seedHome(home)
    const body = '# 项目上下文\n'
    const entry: RunProjectContextManifestEntry = {
      entryId: '01905f7c-0000-7000-8000-000000000958',
      kind: 'decision',
      title: '预算结论',
      revisionId: null,
      businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
      digest: createHash('sha256').update(body).digest('hex'),
      byteSize: Buffer.byteLength(body, 'utf8'),
      snapshotAuthorizationGeneration: null,
    }
    const snapshotId = '01905f7c-0000-7000-8000-000000000968'
    const snapshotDigest = createHash('sha256').update('snapshot-pc05b3-tick').digest('hex')
    const headerText = '[project-context:0123456789abcdef]'
    const headerDigest = createHash('sha256').update(headerText).digest('hex')
    const ctxDir = join(root, 'runtime-context', RUN_ID)
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, entry.entryId), body)
    const store = new MemoryRunTerminalCleanupStore()
    store.schedule({
      runId: RUN_ID,
      homePath: home,
      entryCount: 1,
      ownsHome: true,
      sessionReady: false,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-02T00:00:00.000Z',
    })
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    let prepareStarted!: () => void
    const started = new Promise<void>((resolve) => {
      prepareStarted = resolve
    })
    const h = await makeHarness({
      managerDeps: {
        terminalCleanupStore: store,
        terminalCleanupRetryMs: 3_600_000,
        runtimeContextDirFor: () => ctxDir,
        prepareProjectContext: async () => {
          prepareStarted()
          await prepareGate
          return {
            runId: RUN_ID,
            dir: ctxDir,
            snapshotId,
            snapshotDigest,
            headerText,
            headerDigest,
            entries: [entry],
          }
        },
      },
    })
    const starting = h.manager.handleFrame(
      runStartFrame(h.workspaceId, {
        projectContext: {
          snapshotId,
          digest: snapshotDigest,
          headerText,
          headerDigest,
          manifest: [entry],
        },
      }),
    )
    await started
    expect(h.manager.runTerminalCleanupTick()).toBe(0)
    expect(store.get(RUN_ID)).toMatchObject({ state: 'deferred' })
    expect(existsSync(ctxDir)).toBe(true)
    expect(existsSync(join(home, 'spill'))).toBe(true)

    releasePrepare()
    await starting
    expect(h.runtimes).toHaveLength(1)
    expect(existsSync(ctxDir)).toBe(true)
  })

  it('生产 SQLite 队列接线：终态 + Runtime 退出后 done，重开队列仍保持 done', async () => {
    const home = homeFor()
    await seedHome(home)
    const dbPath = join(root, 'terminal-cleanup.sqlite')
    const store = new SqliteRunTerminalCleanupStore(dbPath)
    const h = await makeHarness({ managerDeps: { terminalCleanupStore: store } })
    await h.manager.handleFrame(runStartFrame(h.workspaceId))
    h.runtimes[0]!.emitStdout(terminatedFrame())
    h.runtimes[0]!.emitExit(0, null)
    await waitForValue(
      () => (store.get(RUN_ID)?.state === 'done' ? true : undefined),
      '真实 SQLite 队列未完成终态清理',
    )
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)

    const reopened = new SqliteRunTerminalCleanupStore(dbPath)
    expect(reopened.get(RUN_ID)?.state).toBe('done')
    expect(reopened.notDone()).toEqual([])
  })

  it('新 manager 用同一 SQLite 库启动清扫，删除上次进程遗留的任务', async () => {
    const home = homeFor()
    await seedHome(home)
    const dbPath = join(root, 'terminal-cleanup.sqlite')
    const seeded = new SqliteRunTerminalCleanupStore(dbPath)
    seeded.schedule({
      runId: RUN_ID,
      homePath: home,
      entryCount: 0,
      ownsHome: true,
      sessionReady: true,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-03T23:59:59.000Z',
    })
    const h = await makeHarness({
      workspaceName: 'ws-restarted',
      managerDeps: { terminalCleanupStore: new SqliteRunTerminalCleanupStore(dbPath) },
    })
    expect(h.manager.startTerminalCleanup()).toBe(1)
    const reopened = new SqliteRunTerminalCleanupStore(dbPath)
    expect(reopened.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
  })

  it('Node 启动清扫忽略 due_at，删除上次进程遗留的未完成任务', async () => {
    const home = homeFor()
    await seedHome(home)
    const store = new MemoryRunTerminalCleanupStore()
    store.schedule({
      runId: RUN_ID,
      homePath: home,
      entryCount: 0,
      ownsHome: true,
      sessionReady: true,
      runTerminalAt: '2026-11-02T00:00:00.000Z',
      dueAt: '2026-11-03T23:59:59.000Z',
    })
    const h = await makeHarness({ managerDeps: { terminalCleanupStore: store } })
    expect(h.manager.startTerminalCleanup()).toBe(1)
    expect(store.get(RUN_ID)?.state).toBe('done')
    expect(existsSync(join(home, 'spill'))).toBe(false)
    expect(existsSync(join(home, 'quarantine'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(true)
  })
})
