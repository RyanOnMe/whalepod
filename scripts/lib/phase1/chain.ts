/**
 * P1-18 六原语 harness —— 全链路装配（drive 的承载面）。
 *
 * 从 apps/node/tests/integration/run-projection-chain.integration.spec.ts 的
 * setupChain 上升而来：真链路全要素，无一环 mock——
 *   Browser(ws) ⇄ 真 Hub（buildApp + listen + 真 PG + 真 OutboxWorker）
 *   ⇄ 真 Node 会话（session.ts + RunManager + RuntimeSupervisor + DshRuntimeDriver）
 *   ⇄ 真 Runtime 子进程（apps/runtime bin + DSH + replay overlay，无外部模型）。
 *
 * 相对测试版新增的三件事：
 * 1. 观测缝：HTTP/outbox/Node 帧/Runtime stdout/Browser 帧全部接 Phase1Recorder，
 *    形成 component 分层的统一结构化事件流（六原语·观测）。
 * 2. 故障注入面：breakHub / stopNodeSession / 关闭 Browser / 换 Runtime 入口，
 *    供 phase1-drive --fault 做「打断任一层 verify 必须 FAIL」的自证。
 * 3. 可独立复跑：不依赖 vitest，scripts/phase1-drive.mts 与集成测试共用本装配。
 *
 * 驱动路径纪律：除 plugin pack 行（P1-17 不可变 Pack 的管理流，此处按既有
 * 验收惯例 DB 种子并记 harness.seed 事件）外，一切实体都走真人 HTTP 路径创建。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { WebSocket } from 'ws'
import { Outbox, schema } from '@project311/db'
import type { Database } from '@project311/db'
import { parseClientFrame } from '@project311/protocol'
import type { ClientFrame, NodeDownstream } from '@project311/protocol'
import {
  apiInject,
  createTestApp,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from '../../../apps/hub/tests/helpers.js'
import { OutboxWorker } from '../../../apps/hub/src/modules/run/index.js'
import type { DeviceGateway } from '../../../apps/hub/src/modules/run/device-gateway.js'
import { WsDeviceGateway } from '../../../apps/hub/src/modules/device/index.js'
import { WorkspaceRegistry } from '../../../apps/node/src/workspace/registry.js'
import { SecretStore } from '../../../apps/node/src/secret/store.js'
import { CommandStore } from '../../../apps/node/src/spool/command-store.js'
import { EventStore } from '../../../apps/node/src/spool/event-store.js'
import { RuntimeSupervisor } from '../../../apps/node/src/supervisor/runtime-supervisor.js'
import { DshRuntimeDriver } from '../../../apps/node/src/runtime-driver.js'
import { RunManager } from '../../../apps/node/src/run/run-manager.js'
import { startDeviceSession } from '../../../apps/node/src/gateway/session.js'
import type {
  RuntimeDriver,
  RuntimeHandle,
  RuntimeSpawnContext,
  RuntimeStartSpec,
} from '../../../apps/node/src/runtime-driver.js'
import { ArtifactInputsManager } from '../../../apps/node/src/artifact/inputs.js'
import { ArtifactCollector } from '../../../apps/node/src/artifact/collect.js'
import { uploadArtifactCandidate } from '../../../apps/node/src/artifact/upload-client.js'
import { Phase1Recorder } from './events.js'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// 子进程 cwd 是临时 workspace（无 node_modules）：--import 必须用绝对路径，
// 与 Q3 stdio 探针同形态但 cwd 无关。
export const TSX_LOADER = createRequire(import.meta.url).resolve('tsx')
export const RUNTIME_BIN = join(REPO_ROOT, 'apps/runtime/src/bin.ts')
export const REPLAY_PATCH = join(REPO_ROOT, 'packages/runtime-dsh/config/replay.yml')

export const FIXTURE_BASIC = join(
  REPO_ROOT,
  'packages/runtime-dsh/tests/dsh-contract/fixtures/basic/session.jsonl',
)
export const FIXTURE_SECRETS = join(
  REPO_ROOT,
  'packages/runtime-dsh/tests/dsh-contract/fixtures/secrets/session.jsonl',
)
export const FIXTURE_APPROVAL = join(
  REPO_ROOT,
  'packages/runtime-dsh/tests/dsh-contract/fixtures/tool-approval/session.jsonl',
)

export const TAKE_TIMEOUT_MS = 90_000

const silence = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface BrowserClient {
  readonly frames: ClientFrame[]
  take(n: number, timeoutMs?: number): Promise<ClientFrame[]>
  close(): void
}

/** 从下行帧提取命令/Run 标识（只取标识，不取负载）。 */
function frameIds(frame: NodeDownstream): { type: string; commandId?: string; runId?: string } {
  const payload = frame.payload as Record<string, unknown>
  const commandId = typeof payload['commandId'] === 'string' ? payload['commandId'] : undefined
  const runId = typeof payload['runId'] === 'string' ? payload['runId'] : undefined
  return {
    type: frame.type,
    ...(commandId === undefined ? {} : { commandId }),
    ...(runId === undefined ? {} : { runId }),
  }
}

/** Browser 帧里的 runId（index 归属用）：persistent run.event 在 payload，live 帧在顶层。 */
function browserFrameRunId(frame: ClientFrame): string | undefined {
  if (frame.kind === 'live') return frame.runId
  if (frame.kind !== 'persistent' || frame.event.type !== 'run.event') return undefined
  const runId = (frame.event.payload as { runId?: unknown } | undefined)?.['runId']
  return typeof runId === 'string' ? runId : undefined
}

export interface ChainAssemblyOptions {
  database: Database
  /** DSH replay snapshot（fixtures 目录下各场景的 session.jsonl）。 */
  fixture: string
  /** 观测缝；缺省 = 落在临时目录（等同无观测，既有集成测试形态）。 */
  recorder?: Phase1Recorder
  /** fault=runtime：Runtime 入口换成必崩 stub。 */
  runtimeEntry?: string
  nodeArgs?: readonly string[]
  /** OutboxWorker 手动挡（R1 用例先装配后启动）。缺省立即启动。 */
  startWorker?: boolean
  /** Agent 数量：1 = 仅 Builder；2 = Builder + Reviewer（standard 场景）。 */
  agents: 1 | 2
  /** 额外的 workspace 预置（tool-approval fixture 需要 out/report.md 真实存在）。 */
  workspaceSetup?: (workspaceDir: string) => void
}

export interface ChainAssembly {
  readonly ctx: TestApp
  readonly alice: Session
  readonly bob: Session
  readonly deviceId: string
  readonly workspaceId: string
  readonly taskId: string
  readonly builderAgentId: string
  readonly reviewerAgentId?: string
  readonly httpBase: string
  readonly nodeStateDir: string
  readonly workspaceDir: string
  readonly supervisor: RuntimeSupervisor
  readonly database: Database
  readonly recorder: Phase1Recorder
  startWorker(): void
  connectBrowser(as: Session): Promise<BrowserClient>
  /** 收掉当前全部 Browser 连接（fault=browser 注入点）。 */
  closeBrowsers(): void
  /** 关 Hub listener（OutboxWorker 继续跑——进程级连接注册表照常工作，R1 语义）。 */
  closeHub(): Promise<void>
  /** closeHub + 停 OutboxWorker + 记 fault 事件（fault=hub 注入点）。 */
  breakHub(): Promise<void>
  /** 停 Node 会话（fault=node 注入点；spool/RunManager 存活，上行出口关闭）。 */
  stopNodeSession(): void
  /** 同端口重启 Hub（R1 语义保留）。 */
  listenAgain(): Promise<TestApp>
  cleanup(): Promise<void>
}

/**
 * 完整链路装配；返回驱动句柄。Node 侧全是真组件（与 cli.ts 同配方）。
 * 调用方负责 finally 调 cleanup()；装配中途抛错时已建资源在内部回收后重抛。
 */
export async function assembleChain(options: ChainAssemblyOptions): Promise<ChainAssembly> {
  const { database, fixture } = options
  const cleanups: Array<() => void | Promise<void>> = []
  const tempDirs: string[] = []
  const mktemp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }
  const runCleanups = async (): Promise<void> => {
    for (const fn of cleanups.splice(0)) await fn()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    delete process.env['DSH_SNAPSHOT_FILE']
    delete process.env['PROJECT311_RUNTIME_EXTRA_PATCH_FILES']
  }

  try {
    const recorder =
      options.recorder ??
      (() => {
        // 无观测调用方（既有测试形态）：事件落到临时目录，cleanup 一并收走。
        const dir = mktemp('p311-chain-events-')
        return new Phase1Recorder(dir, `noop-${randomUUID()}`)
      })()

    await resetDatabase(database)
    process.env['DSH_SNAPSHOT_FILE'] = fixture
    process.env['PROJECT311_RUNTIME_EXTRA_PATCH_FILES'] = REPLAY_PATCH

    const ctx = await createTestApp(database)
    await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const address = ctx.app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no listen port')
    const port = address.port
    const httpBase = `http://127.0.0.1:${port}`
    const browserBase = `ws://127.0.0.1:${port}/ws/v1/client`
    // 幂等 close：R1 会提前关一次 Hub。正常收尾不记 hub.down（它不是故障信号；
    // verify 对 Hub 存亡的判定只看真实 HTTP 探活事实）。
    let ctxClosed = false
    const closeCtx = async (): Promise<void> => {
      if (ctxClosed) return
      ctxClosed = true
      await ctx.close()
    }
    cleanups.push(() => closeCtx())
    recorder.event('hub.http', 'hub.listening', { httpBase })

    const alice = await driveSetup(ctx)
    recorder.event('hub.http', 'http.setup', { user: 'alice', status: 201 })
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    recorder.event('hub.http', 'http.invite.accept', { user: 'bob', status: 201 })

    // Agent：provider replay（Q3 overlay 适配器），凭据槽 default。
    // Pack 行按既有验收惯例 DB 种子（P1-17 管理流不在本链路复跑），记 seed 事件。
    const pluginPackId = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id: pluginPackId,
      name: `pack-${pluginPackId.slice(0, 8)}`,
      installations: [],
      packDigest: 'a'.repeat(64),
      createdBy: alice.userId,
    })
    recorder.event('harness.seed', 'seed.plugin-pack', { pluginPackId })

    const createAgentViaHttp = async (name: string): Promise<string> => {
      const res = await apiInject(ctx, alice, {
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name,
          persona: 'You replay fixtures.',
          provider: 'replay',
          model: 'replay-model',
          credentialSlot: 'default',
          pluginPackId,
        },
      })
      if (res.statusCode !== 201) {
        throw new Error(`POST /agents ${name} 失败：${res.statusCode} ${res.body}`)
      }
      const body = res.json() as { data: { id: string } }
      recorder.event('hub.http', 'http.agent.created', { agentId: body.data.id, name })
      return body.data.id
    }
    const builderAgentId = await createAgentViaHttp('builder')
    const reviewerAgentId = options.agents === 2 ? await createAgentViaHttp('reviewer') : undefined

    // Project/Task 走真人 HTTP 路径；责任人 Alice 自接受（G2-03 同型）。
    const projectRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'chain' },
    })
    if (projectRes.statusCode !== 201) {
      throw new Error(`POST /projects 失败：${projectRes.statusCode} ${projectRes.body}`)
    }
    const projectId = (projectRes.json() as { data: { id: string } }).data.id
    const taskRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'chain task', assigneeUserId: alice.userId },
    })
    if (taskRes.statusCode !== 201) {
      throw new Error(`POST /tasks 失败：${taskRes.statusCode} ${taskRes.body}`)
    }
    const taskId = (taskRes.json() as { data: { id: string } }).data.id
    const acceptRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    if (acceptRes.statusCode !== 200 && acceptRes.statusCode !== 201) {
      throw new Error(`POST /tasks/:id/accept 失败：${acceptRes.statusCode} ${acceptRes.body}`)
    }
    recorder.event('hub.http', 'http.task.ready', { projectId, taskId, assignment: 'accepted' })

    // 配对设备（HTTP 真人路径）。
    const codeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': randomUUID() },
      payload: {},
    })
    const claimRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: codeRes.json().data.code,
        name: 'chain-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    const claimBody = claimRes.json().data as { deviceId: string; deviceToken: string }
    const deviceId = claimBody.deviceId
    // Device Token 只进 Node 本地会话配置（生产是 mode 0600 config）；
    // 本装配不把它写入任何返回值或证据文件（红线：Token 不进证据）。
    recorder.event('hub.http', 'http.device.paired', { deviceId })

    // ---- Node 侧真装配（与 cli.ts runStart 同配方；仅测试注入点不同）----
    const nodeStateDir = mktemp('p311-chain-node-state-')
    const workspaceDir = mktemp('p311-chain-ws-')
    // P1-15：桥内 publish_artifact 校验已接线（realpath/边界/size）——tool-approval
    // fixture 的候选 out/report.md 必须是工作区内真实文件，否则工具以失败结果
    // 回给模型、链路等不到 tool.finished succeeded（与 replay-runtime 探针同补法）。
    if (fixture === FIXTURE_APPROVAL) {
      mkdirSync(join(workspaceDir, 'out'), { recursive: true })
      writeFileSync(join(workspaceDir, 'out', 'report.md'), '# chain report\n')
    }
    options.workspaceSetup?.(workspaceDir)

    const registry = new WorkspaceRegistry(join(nodeStateDir, 'workspace-registry.sqlite'))
    const registered = await registry.register(workspaceDir, { name: 'chain-ws' })
    const workspaceId = registered.id
    // Hub 投影行：与 Node registry 同一 id（生产由 inventory 上报建立，P1-12）。
    await database.db.insert(schema.workspaces).values({
      id: workspaceId,
      deviceId,
      ownerUserId: alice.userId,
      name: 'chain-ws',
      kind: 'directory',
      capabilities: { read: true, write: true },
      available: true,
    })

    const secrets = new SecretStore(join(nodeStateDir, 'secrets.json'))
    await secrets.set('replay', 'default', 'replay-key-dummy')
    const eventStore = new EventStore(join(nodeStateDir, 'events.sqlite'))
    const supervisor = new RuntimeSupervisor({
      // stderr 观测缝（evidence-map：Runtime stderr tail 是 runtime 层一等证据）：
      // 包装 DshRuntimeDriver，在 driver 的 onStderr 回调上接 recorder（脱敏后）。
      driver: new StderrRecordingDriver(
        new DshRuntimeDriver({
          runtimeEntry: options.runtimeEntry ?? RUNTIME_BIN,
          // TS 源直跑需要 tsx loader（子进程 cwd 是临时 workspace，裸名解析不到）；
          // fault=runtime 的 .mjs stub 由调用方显式传 [] 覆盖。
          nodeArgs: [...(options.nodeArgs ?? ['--import', TSX_LOADER])],
        }),
        recorder,
      ),
      registry,
      secrets,
      stateDbPath: join(nodeStateDir, 'supervisor.sqlite'),
      capacity: 2,
      runtimeTimeoutMs: 300_000,
      // 验收缝：replay overlay 变量显式列入白名单（生产 cli 为空）。
      runtimeEnvPassthrough: ['DSH_SNAPSHOT_FILE', 'PROJECT311_RUNTIME_EXTRA_PATCH_FILES'],
      // stdout 行 → RunManager 投影管线（与 cli.ts 同配方；runManager 后构造，
      // 闭包在 spawn 回调时才被调用，TDZ 安全）。
      onStdoutLine: (runId, line) => {
        recordRuntimeLine(recorder, runId, line)
        runManager.handleStdoutLine(runId, line)
      },
    })
    cleanups.push(async () => {
      for (const runId of supervisor.activeRunIds()) await supervisor.cancel(runId)
    })

    let sessionSend: (frame: string) => void = () => {}
    // P1-15 缝（与 cli.ts 同配方）：候选采集上传 + Reviewer 输入准备/清理。
    // artifact 日志接观测缝（component=node.artifact），内容只有事实与计数。
    const artifactLog = (
      level: 'info' | 'warn' | 'error',
      msg: string,
      context?: Record<string, unknown>,
    ): void => {
      recorder.event('node.artifact', msg, { level, ...(context ?? {}) })
    }
    const artifactInputs = new ArtifactInputsManager({
      hubUrl: httpBase,
      deviceToken: claimBody.deviceToken,
      inputsRoot: join(nodeStateDir, 'runtime-inputs'),
      log: artifactLog,
    })
    const artifactCollector = new ArtifactCollector({
      stagingDir: join(nodeStateDir, 'artifact-staging'),
      upload: (runId, payload, body) =>
        uploadArtifactCandidate(httpBase, claimBody.deviceToken, runId, payload, body, {
          idempotencyKey: randomUUID(),
          log: artifactLog,
        }),
      log: artifactLog,
    })
    const runManager = new RunManager({
      supervisor,
      registry,
      commandStore: new CommandStore(join(nodeStateDir, 'commands.sqlite')),
      eventStore,
      send: (frame) => {
        recordUplink(recorder, frame)
        sessionSend(frame)
      },
      runtimeHomeFor: (runId) => mktemp(`p311-chain-home-${runId.slice(0, 8)}-`),
      // 语料第 5 件（/Users/bob/...）依赖 homeDir 归约：固定注入，与本机真实 home 无关。
      homeDir: '/Users/bob',
      stateDir: nodeStateDir,
      packsRoot: join(nodeStateDir, 'plugin-packs'),
      artifactCollector,
      prepareArtifactInputs: (runId, taskId) => artifactInputs.prepare(runId, taskId),
      cleanupArtifactInputs: (runId) => artifactInputs.cleanup(runId),
      deviceId,
      dshDistributionVersion: '0.1.0-rc.8',
      log: (level, msg, context) => {
        recorder.event('node.run', msg, { level, ...(context ?? {}) })
      },
    })
    const session = startDeviceSession({
      config: { hubUrl: httpBase, deviceId, deviceToken: claimBody.deviceToken },
      facts: {
        nodeVersion: process.version,
        platform: 'darwin',
        architecture: 'arm64',
        dshDistributionVersion: '0.1.0-rc.8',
        pluginPackDigests: [],
      },
      onRevoked: () => {},
      exit: (code, message) => {
        throw new Error(`node session exit ${code}: ${message}`)
      },
      onFrame: (frame) => {
        const ids = frameIds(frame)
        recorder.event('node.gateway', 'node.frame.received', ids, ids.runId)
        void runManager.handleFrame(frame)
      },
      onConnected: () => {
        recorder.fact('node.gateway', 'session.connected', {})
        runManager.onReconnect()
      },
      heartbeatFacts: () => runManager.heartbeatFacts(),
      WebSocketImpl: WebSocket as never,
      heartbeatMs: 60_000,
      baseDelayMs: 100,
      maxDelayMs: 300,
    })
    sessionSend = session.send
    cleanups.push(() => session.stop())

    // OutboxWorker：生产 250ms 循环的测试手动挡（真 gateway → 进程级连接注册表 →
    // 真 WS 下行；Hub 重启后新连接在同一注册表，worker 照常工作——R1 依赖这点）。
    const worker = new OutboxWorker({
      outbox: new Outbox(database),
      gateway: recordGateway(new WsDeviceGateway(), recorder),
    })
    let workerTimer: ReturnType<typeof setInterval> | undefined
    const startWorker = (): void => {
      if (workerTimer !== undefined) return
      workerTimer = setInterval(() => {
        void worker.dispatchOnce().catch(() => {})
      }, 100)
      cleanups.push(() => clearInterval(workerTimer))
    }
    if (options.startWorker !== false) startWorker()

    // 等 hello 落库（路由的 DEVICE_OFFLINE 判据）再允许 create。
    const helloDeadline = Date.now() + 10_000
    for (;;) {
      const [row] = await database.db
        .select({ v: schema.devices.dshDistributionVersion })
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      if (row?.v !== null && row !== undefined) break
      if (Date.now() > helloDeadline) throw new Error('node hello did not land in time')
      await silence(50)
    }
    recorder.event('hub.db', 'device.hello', { deviceId })

    const openBrowsers = new Set<BrowserClient>()
    const connectBrowser = (as: Session): Promise<BrowserClient> =>
      new Promise((resolve, reject) => {
        const who: 'alice' | 'bob' = as.userId === alice.userId ? 'alice' : 'bob'
        const socket = new WebSocket(`${browserBase}?cursor=0`, {
          headers: { cookie: as.cookie, origin: ctx.origin },
        })
        const frames: ClientFrame[] = []
        const client: BrowserClient = {
          frames,
          take: async (n, timeoutMs = TAKE_TIMEOUT_MS) => {
            const deadline = Date.now() + timeoutMs
            while (frames.length < n) {
              if (Date.now() >= deadline) {
                throw new Error(
                  `timeout waiting ${n} browser frames; got ${frames.length}: ${JSON.stringify(frames.map((f) => (f.kind === 'persistent' ? f.event.type : f.kind)))}`,
                )
              }
              await silence(25)
            }
            return frames.slice(0, n)
          },
          close: () => {
            socket.close()
            openBrowsers.delete(client)
            recorder.browserFact(who, 'browser.socket.closed')
          },
        }
        socket.on('message', (data) => {
          const frame = parseClientFrame(JSON.parse(data.toString()))
          frames.push(frame)
          recorder.browserFrame(who, frame)
          recorder.event('browser', 'browser.frame', { who }, browserFrameRunId(frame))
        })
        socket.once('open', () => {
          recorder.browserFact(who, 'browser.socket.open')
          openBrowsers.add(client)
          cleanups.push(() => socket.close())
          resolve(client)
        })
        socket.once('error', reject)
      })

    // 同端口原地重启（同一 PG）——R1 的「Hub 进程重启」语义。
    const listenAgain = async (): Promise<TestApp> => {
      const fresh = await createTestApp(database)
      await fresh.app.listen({ host: '127.0.0.1', port })
      cleanups.push(() => fresh.close())
      return fresh
    }

    const cleanup = async (): Promise<void> => {
      for (const fn of cleanups.splice(0)) await fn()
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
      delete process.env['DSH_SNAPSHOT_FILE']
      delete process.env['PROJECT311_RUNTIME_EXTRA_PATCH_FILES']
    }

    return {
      ctx,
      alice,
      bob,
      deviceId,
      workspaceId,
      taskId,
      builderAgentId,
      ...(reviewerAgentId === undefined ? {} : { reviewerAgentId }),
      httpBase,
      nodeStateDir,
      workspaceDir,
      supervisor,
      database,
      recorder,
      startWorker,
      connectBrowser,
      closeBrowsers: () => {
        for (const client of [...openBrowsers]) client.close()
      },
      closeHub: () => closeCtx(),
      breakHub: async () => {
        if (workerTimer !== undefined) clearInterval(workerTimer)
        workerTimer = undefined
        await closeCtx()
        recorder.event('hub.http', 'fault.injected', {
          fault: 'hub',
          detail: 'hub listener closed',
        })
        recorder.fact('hub.http', 'hub.down', { via: 'breakHub' })
      },
      stopNodeSession: () => {
        session.stop()
        recorder.event('node.gateway', 'fault.injected', {
          fault: 'node',
          detail: 'device session stopped',
        })
        recorder.fact('node.gateway', 'session.stopped', { via: 'stopNodeSession' })
      },
      listenAgain,
      cleanup,
    }
  } catch (error) {
    await runCleanups()
    throw error
  }
}

// ---------- 观测缝（模块级纯函数） ----------

/**
 * Runtime stderr 观测缝：包装 driver，把 onStderr chunk（脱敏后）记入事件流。
 * stderr 是 runtime 层的一等证据（evidence-map「runtime.bridge/dsh.agent」行）；
 * 绝对路径按 secret-scan 模式归约（/Users/<name>/ → <home>/），保证证据可出包。
 */
class StderrRecordingDriver implements RuntimeDriver {
  constructor(
    private readonly inner: RuntimeDriver,
    private readonly recorder: Phase1Recorder,
  ) {}

  async spawn(
    spec: RuntimeStartSpec,
    ctx: RuntimeSpawnContext & {
      onStdout: (line: string) => void
      onStderr: (chunk: string) => void
      onExit: (code: number | null, signal: string | null) => void
    },
  ): Promise<RuntimeHandle> {
    return this.inner.spawn(spec, {
      ...ctx,
      onStderr: (chunk) => {
        this.recorder.event(
          'runtime.bridge',
          'runtime.stderr',
          { runId: spec.runId, tail: redactHome(chunk).slice(0, 2_000) },
          spec.runId,
        )
        ctx.onStderr(chunk)
      },
    })
  }

  async terminate(handle: RuntimeHandle): Promise<void> {
    await this.inner.terminate(handle)
  }

  async forceKill?(handle: RuntimeHandle): Promise<void> {
    await this.inner.forceKill?.(handle)
  }
}

/** secret-scan 模式归约：本机用户目录前缀一律归约成 <home>/（证据可出包）。 */
function redactHome(text: string): string {
  return text.replace(/\/Users\/[^/]+(?=\/)/g, '<home>')
}

/**
 * Outbox 派发观测缝：包一层记录 gateway（不动 WsDeviceGateway 本体）。
 * 注意 WsDeviceGateway.send 对离线设备不抛错（静默丢帧），「派发了」≠「送达了」；
 * 送达事实以 Node 侧收到帧 + outbox ackedAt（DB）为准。
 */
function recordGateway(inner: DeviceGateway, recorder: Phase1Recorder): DeviceGateway {
  return {
    async send(deviceId, frame) {
      const ids = frameIds(frame)
      recorder.event('hub.outbox', 'outbox.dispatch', { deviceId, ...ids }, ids.runId)
      const ack = await inner.send(deviceId, frame)
      recorder.event(
        'hub.outbox',
        'outbox.dispatch.sent',
        { deviceId, type: ids.type, sentAt: ack.sentAt.toISOString() },
        ids.runId,
      )
      return ack
    },
  }
}

/** Node 上行帧观测缝：全文进 node-events.jsonl（已脱敏），标识进事件流。 */
function recordUplink(recorder: Phase1Recorder, raw: string): void {
  try {
    const frame = JSON.parse(raw) as Record<string, unknown>
    recorder.nodeUplink(frame)
    const payload = frame['payload'] as Record<string, unknown> | undefined
    const runId = typeof payload?.['runId'] === 'string' ? payload['runId'] : undefined
    const type = typeof frame['type'] === 'string' ? frame['type'] : 'unknown'
    recorder.event('node.gateway', 'node.uplink', { type }, runId)
  } catch {
    recorder.event('node.gateway', 'node.uplink.unparsable', {})
  }
}

/** Runtime stdout 观测缝：只记协议 type 与字节长度（文本不出 Runtime 层）。 */
function recordRuntimeLine(recorder: Phase1Recorder, runId: string, line: string): void {
  try {
    const frame = JSON.parse(line) as { type?: unknown }
    const type = typeof frame['type'] === 'string' ? frame['type'] : 'unknown'
    recorder.runtimeFrame(type, Buffer.byteLength(line, 'utf8'))
    recorder.event('runtime.bridge', 'runtime.stdout', { type }, runId)
  } catch {
    // stdout 纯净性破坏（非 JSON 行）：记事实不打断——Q3 契约门管这个红线。
    recorder.runtimeFrame('non-json', Buffer.byteLength(line, 'utf8'))
    recorder.event('runtime.bridge', 'runtime.stdout.nonjson', { byteLength: line.length }, runId)
  }
}
