#!/usr/bin/env tsx
/**
 * P1-19 E2E Node 子进程（Q5 浏览器门 · 基建 ①）。
 *
 * 「真 Runtime 在 E2E 里真跑」的载体：一个**独立 OS 进程**（不是测试近道），
 * 装配与 apps/node/src/cli.ts `start` 同一配方（WorkspaceRegistry / SecretStore /
 * CommandStore / EventStore / RuntimeSupervisor / DshRuntimeDriver / RunManager /
 * startDeviceSession），Runtime 是经 DSH replay overlay 的真子进程（apps/runtime
 * bin，无外部模型密钥）。相对生产 CLI 的差异只有三处，且全部是 harness 职责：
 *
 * 1. 验收缝（P1-18 既有惯例）：RuntimeSupervisor 的 runtimeEnvPassthrough 显式
 *    列入 DSH_SNAPSHOT_FILE / PROJECT311_RUNTIME_EXTRA_PATCH_FILES——replay
 *    overlay 是 04 文档契约探针的一等概念，生产 cli 该项为空；
 * 2. Workspace 投影上报：**无代偿**。#89 之前本进程自行拼 node.inventory 帧
 *    发出去遮掉了生产缺陷（cli 从不发帧 ⟹ 真实用户 RunLauncher 选不到
 *    Workspace）；#89 已把上报接线到 session 层（与 hello 同责，每条连接建立后
 *    一次），本进程只提供 `inventoryFacts` 事实源，与 cli 走同一条路径。
 *    若该缝再被需要（E2E 因投影缺失而红），说明产品上报路径又坏了——查
 *    session.ts 的 inventoryFacts 与 cli.ts 的注入，不要在这里补发帧。
 * 3. 故障注入与观测缝：进程内 127.0.0.1 控制口（drop=拔线模拟、ack-drop=吞
 *    command.ack、runtimes=真 pid、input-manifest=Reviewer 输入清单快照、
 *    fixture=切换 replay 快照）。控制口 Token 与 Device Token 都只进 0600 内存
 *    交接，不进日志。
 *
 * 生命周期：e2e-serve spawn/kill 本进程（SIGKILL 模拟 Node 崩溃，detached 的
 * Runtime 孙进程成为孤儿——R9 的真人路径）；重启后 supervisor.recoverOrphans
 * 三重匹配回收孤儿，RunManager 缓冲 lost 快照经重连补发。
 *
 * stdout 契约：首行就绪后输出一行 `E2E_NODE_READY <json>`（控制口/workspaceId/
 * deviceId）供 e2e-serve 解析；其余日志一律 stderr。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'
import type { NodeDownstream } from '@project311/protocol'
import { claimDevice } from '../apps/node/src/pairing/client.js'
import { loadConfig, saveConfig, type NodeConfig } from '../apps/node/src/config.js'
import { registryFileRevision, WorkspaceRegistry } from '../apps/node/src/workspace/registry.js'
import { WorkspaceInventory } from '../apps/node/src/workspace/inventory.js'
import { SecretStore } from '../apps/node/src/secret/store.js'
import { CommandStore } from '../apps/node/src/spool/command-store.js'
import { EventStore } from '../apps/node/src/spool/event-store.js'
import { RuntimeSupervisor } from '../apps/node/src/supervisor/runtime-supervisor.js'
import { DshRuntimeDriver, type RuntimeDriver } from '../apps/node/src/runtime-driver.js'
import type {
  RuntimeHandle,
  RuntimeSpawnContext,
  RuntimeStartSpec,
} from '../apps/node/src/runtime-driver.js'
import { RunManager } from '../apps/node/src/run/run-manager.js'
import { startDeviceSession } from '../apps/node/src/gateway/session.js'
import { ArtifactInputsManager } from '../apps/node/src/artifact/inputs.js'
import { ArtifactCollector } from '../apps/node/src/artifact/collect.js'
import { uploadArtifactCandidate } from '../apps/node/src/artifact/upload-client.js'

const REPO_ROOT = join(import.meta.dirname, '..')
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx')
const RUNTIME_BIN = join(REPO_ROOT, 'apps/runtime/src/bin.ts')
const REPLAY_PATCH = join(REPO_ROOT, 'packages/runtime-dsh/config/replay.yml')
const FIXTURES: Record<string, string> = {
  approval: join(
    REPO_ROOT,
    'packages/runtime-dsh/tests/dsh-contract/fixtures/tool-approval/session.jsonl',
  ),
  basic: join(REPO_ROOT, 'packages/runtime-dsh/tests/dsh-contract/fixtures/basic/session.jsonl'),
  secrets: join(
    REPO_ROOT,
    'packages/runtime-dsh/tests/dsh-contract/fixtures/secrets/session.jsonl',
  ),
  // G5-04 拒绝分支：同 tool-call 前置，收尾文本为被拒解释（replay 定序回放不随
  // 决定分支，语义诚实需要独立快照）。
  rejection: join(
    REPO_ROOT,
    'packages/runtime-dsh/tests/dsh-contract/fixtures/tool-rejection/session.jsonl',
  ),
}

const log = (msg: string, extra?: Record<string, unknown>): void => {
  process.stderr.write(
    `${JSON.stringify({ level: 'info', component: 'e2e-node', msg, ...(extra ?? {}) })}\n`,
  )
}

const { values: argv } = parseArgs({
  options: {
    hub: { type: 'string' },
    'state-dir': { type: 'string' },
    'config-dir': { type: 'string' },
    'pair-code': { type: 'string' },
  },
})
const hubUrl = argv['hub']
const stateDir = argv['state-dir']
const configDir = argv['config-dir']
if (hubUrl === undefined || stateDir === undefined || configDir === undefined) {
  process.stderr.write(
    'usage: e2e-node --hub <url> --state-dir <dir> --config-dir <dir> [--pair-code <code>]\n',
  )
  process.exit(2)
}

// ---- 配对（真人路径：与 cli pair 同一 claimDevice）或直接复用既有 config ----
let config: NodeConfig | undefined
if (argv['pair-code'] !== undefined) {
  const claim = await claimDevice(
    hubUrl,
    argv['pair-code'],
    {
      name: 'e2e-node',
      platform: process.platform === 'linux' ? 'linux' : 'darwin',
      architecture: process.arch,
      nodeVersion: process.version,
      nodeAppVersion: '0.1.0-e2e',
    },
    { idempotencyKey: randomUUID() },
  )
  await saveConfig(
    { hubUrl, deviceId: claim.deviceId, deviceToken: claim.deviceToken },
    { configDir },
  )
  config = { hubUrl, deviceId: claim.deviceId, deviceToken: claim.deviceToken }
} else {
  config = await loadConfig({ configDir })
}
if (config === undefined) {
  process.stderr.write('e2e-node: no config and no --pair-code\n')
  process.exit(1)
}

// ---- 本地状态与 workspace（真 registry；目录内容含 approval fixture 所需文件）----
mkdirSync(stateDir, { recursive: true })
const workspaceDir = join(stateDir, 'workspace')
mkdirSync(join(workspaceDir, 'out'), { recursive: true })
writeFileSync(
  join(workspaceDir, 'out', 'report.md'),
  '# e2e report\n\n内容摘要：E2E 验收交付物。\n',
)

const registry = new WorkspaceRegistry(join(stateDir, 'workspace-registry.sqlite'))
// restart（R9 崩溃重启）复用同一 state 目录：workspace 行已在册则复用（真人
// Node 重启同语义——registry 是持久状态，不重注册）。
let registered: Awaited<ReturnType<WorkspaceRegistry['register']>>
try {
  registered = await registry.register(workspaceDir, { name: 'e2e-ws' })
} catch (error) {
  if ((error as { code?: string }).code !== 'CONFLICT') throw error
  const existing = (await registry.list()).find((w) => w.name === 'e2e-ws')
  if (existing === undefined) throw error
  registered = existing
}
const secrets = new SecretStore(join(stateDir, 'secrets.json'))
await secrets.set('replay', 'default', 'e2e-replay-dummy-key')

// 进程环境：replay overlay 验收缝（默认 approval 快照；控制口可切换）。
process.env['PROJECT311_RUNTIME_EXTRA_PATCH_FILES'] = REPLAY_PATCH
process.env['DSH_SNAPSHOT_FILE'] = FIXTURES['approval'] as string

// ---- 观测记录（控制口查询用；不改变产品行为）----
const runtimePids = new Map<string, number>() // runId → 最近一次 spawn 的 pid
const spawnCounts = new Map<string, number>() // runId → spawn 次数（R7 判定：恒 1）
const inputManifests = new Map<
  string,
  { manifest: unknown; copiedFiles: string[]; manifestText: string }
>()
let ackDropRemaining = 0
const ackDropped: string[] = [] // 被吞掉的 ack 事实（取证）

// ---- Runtime driver（真 DshRuntimeDriver + pid 观测缝）----
class PidRecordingDriver implements RuntimeDriver {
  constructor(private readonly inner: RuntimeDriver) {}
  async spawn(
    spec: RuntimeStartSpec,
    ctx: RuntimeSpawnContext & {
      onStdout: (line: string) => void
      onStderr: (chunk: string) => void
      onExit: (code: number | null, signal: string | null) => void
    },
  ): Promise<RuntimeHandle> {
    const handle = await this.inner.spawn(spec, ctx)
    runtimePids.set(spec.runId, handle.pid)
    spawnCounts.set(spec.runId, (spawnCounts.get(spec.runId) ?? 0) + 1)
    return handle
  }
  async terminate(handle: RuntimeHandle): Promise<void> {
    await this.inner.terminate(handle)
  }
  async forceKill(handle: RuntimeHandle): Promise<void> {
    await this.inner.forceKill?.(handle)
  }
}

const supervisor = new RuntimeSupervisor({
  driver: new PidRecordingDriver(
    new DshRuntimeDriver({ runtimeEntry: RUNTIME_BIN, nodeArgs: ['--import', TSX_LOADER] }),
  ),
  registry,
  secrets,
  stateDbPath: join(stateDir, 'supervisor.sqlite'),
  // E2E 与生产同值（#88 已修：Run 终态即 runtime.shutdown 主动回收 + Hub 心跳
  // 收敛 admin run.cancel；supervisor 硬超时降为最后兜底）。单 Node 串行场景
  // 在 capacity 2 下可行，正是本修复的验收面之一。
  capacity: 2,
  runtimeTimeoutMs: 6 * 60 * 60 * 1000,
  // 验收缝（P1-18 惯例）：replay overlay 变量显式透传，生产 cli 此处为空。
  runtimeEnvPassthrough: ['DSH_SNAPSHOT_FILE', 'PROJECT311_RUNTIME_EXTRA_PATCH_FILES'],
  onStdoutLine: (runId, line) => runManager.handleStdoutLine(runId, line),
})

const artifactLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  context?: Record<string, unknown>,
) => {
  process.stderr.write(
    `${JSON.stringify({ level, component: 'e2e-node.artifact', msg, ...(context ?? {}) })}\n`,
  )
}
const artifactInputs = new ArtifactInputsManager({
  hubUrl: config.hubUrl,
  deviceToken: config.deviceToken,
  inputsRoot: join(stateDir, 'runtime-inputs'),
  log: artifactLog,
})
const artifactCollector = new ArtifactCollector({
  stagingDir: join(stateDir, 'artifact-staging'),
  upload: (runId, payload, body) =>
    uploadArtifactCandidate(config.hubUrl, config.deviceToken, runId, payload, body, {
      idempotencyKey: randomUUID(),
      log: artifactLog,
    }),
  log: artifactLog,
})

const eventStore = new EventStore(join(stateDir, 'events.sqlite'))

// ---- 会话与帧通路（含 R7 ack 吞帧故障缝）----
let sessionSend: (frame: string) => void = () => {}

function sendUplink(frame: string): void {
  try {
    const parsed = JSON.parse(frame) as { type?: unknown; payload?: { success?: unknown } }
    // R7 故障注入：吞掉接下来 N 条 command.ack（上行出口级——模拟 ack 丢失；
    // Hub 退避重发同一 commandId，Node 按 CommandStore 回旧 ack，绝不启第二 Runtime）。
    if (parsed.type === 'command.ack' && ackDropRemaining > 0) {
      ackDropRemaining -= 1
      ackDropped.push(frame.slice(0, 200))
      log('command.ack dropped (fault seam)', { remaining: ackDropped.length })
      return
    }
  } catch {
    // 非 JSON 帧不拦截，原样上行。
  }
  sessionSend(frame)
}

const runManager = new RunManager({
  supervisor,
  registry,
  commandStore: new CommandStore(join(stateDir, 'commands.sqlite')),
  eventStore,
  send: sendUplink,
  runtimeHomeFor: (runId) => {
    const dir = join(stateDir, 'runtime-home', runId)
    mkdirSync(dir, { recursive: true })
    return dir
  },
  homeDir: homedir(),
  stateDir,
  packsRoot: join(stateDir, 'plugin-packs'),
  artifactCollector,
  prepareArtifactInputs: async (runId, taskId) => {
    const inputs = await artifactInputs.prepare(runId, taskId)
    // 观测缝：记录本 Run 的输入清单（G6-07 判定「Reviewer 经清单消费、不继承 Builder
    // Workspace」的证据源；不改产品路径——prepare 照常执行）。
    inputManifests.set(runId, {
      manifest: inputs,
      copiedFiles: inputs.entries.map((entry) => entry.title),
      manifestText: JSON.stringify(inputs),
    })
    return inputs
  },
  cleanupArtifactInputs: (runId) => artifactInputs.cleanup(runId),
  deviceId: config.deviceId,
  dshDistributionVersion: '0.1.0-rc.8-e2e',
  log: (level, msg, context) => {
    process.stderr.write(
      `${JSON.stringify({ level, component: 'e2e-node.run', msg, ...(context ?? {}) })}\n`,
    )
  },
})

// （#87 已下沉产品侧：Hub reconcile 新生儿宽限（PR #122）+ Run 出生时间走
// 领域时钟。本文件原 monkey-patch（受理即补拍心跳 + activeRunIds 超集）已按
// 账体约定删除——E2E 直面真实 10s 心跳节奏，Q5 20× 连续绿是删后无回归的判据。）

// R9 语义：重启后先回收孤儿（recoverOrphans 内完成），再建立会话。
await supervisor.recoverOrphans()

// ---- WebSocket 故障缝：offline 窗口内连接尝试立即失败（模拟拔线——非 stop
// 语义，产品重连退避照常运转），存活连接 terminate() 直接摧毁。----
let offlineUntil = 0
const liveSockets = new Set<FaultWebSocket>()

const FORWARDED_EVENTS = ['open', 'message', 'close', 'error', 'unexpected-response'] as const

class FaultWebSocket extends (await import('node:events')).EventEmitter {
  private readonly real?: WebSocket

  constructor(url: string, options?: unknown) {
    super()
    if (Date.now() < offlineUntil) {
      // 拔线窗口：openHubSocket 同步挂好监听器后（nextTick）报 error + 1006 关闭
      // （非永久码 → session 退避重连继续；重连尝试在窗口内会继续失败）。
      process.nextTick(() => {
        this.emit('error', new Error('e2e simulated offline'))
        this.emit('close', 1006, Buffer.from('e2e offline'))
      })
      return
    }
    const real = new WebSocket(url, options as never)
    this.real = real
    liveSockets.add(this)
    for (const event of FORWARDED_EVENTS) {
      real.on(
        event as never,
        ((...args: unknown[]) => {
          if (event === 'close') liveSockets.delete(this)
          this.emit(event, ...args)
        }) as never,
      )
    }
  }

  get readyState(): number {
    // offline 桩件永不 OPEN；真实 socket 透传。
    return this.real === undefined ? 3 /* CLOSED */ : this.real.readyState
  }

  send(data: string): void {
    this.real?.send(data)
  }

  close(code?: number, reason?: string): void {
    this.real?.close(code, reason)
  }

  /** 供 destroyLiveSockets 的硬断（ws 语义：不完成关闭握手）。 */
  terminate(): void {
    if (this.real === undefined) return
    try {
      this.real.terminate()
    } catch {
      // 已断开。
    }
  }
}

function destroyLiveSockets(): void {
  for (const socket of [...liveSockets]) {
    socket.terminate()
  }
}

const facts = {
  nodeVersion: process.version,
  platform: (process.platform === 'linux' ? 'linux' : 'darwin') as 'darwin' | 'linux',
  architecture: process.arch,
  dshDistributionVersion: '0.1.0-rc.8-e2e',
  pluginPackDigests: [],
}

const inventory = new WorkspaceInventory(registry, secrets)

const session = startDeviceSession({
  config,
  facts,
  onRevoked: () => {},
  exit: (code, message) => {
    log(`session exit ${code}: ${message}`)
    process.exit(code)
  },
  onFrame: (frame: NodeDownstream) => {
    void runManager.handleFrame(frame).catch((error: unknown) => {
      log('frame handling failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  },
  onConnected: () => {
    runManager.onReconnect()
  },
  heartbeatFacts: () => runManager.heartbeatFacts(),
  // #89 后本进程与生产 cli 走同一条上报路径：只提供事实源，发帧由 session 层负责。
  inventoryFacts: () => inventory.build(),
  // #94：与 cli.ts 同一注入——registry 文件指纹随心跳探测，变化即重报。
  inventoryRevision: () => registryFileRevision(join(stateDir, 'workspace-registry.sqlite')),
  onInventoryError: (error: unknown) => {
    log('inventory build failed', { error: String(error) })
  },
  WebSocketImpl: FaultWebSocket as unknown as never,
})

sessionSend = session.send

// ---- 控制口（127.0.0.1；e2e-serve 代理，仅故障注入与观测）----
let controlServer: Server | undefined
const controlToken = randomUUID()

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers['x-e2e-node-control'] !== controlToken)
      return reply(401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body =
      chunks.length > 0
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
        : {}
    // e2e-serve 代理统一以 POST 转发（path + JSON body）；本服务只按路径分发。
    switch (url.pathname) {
      case '/fixture': {
        const name = String(body['name'] ?? '')
        const path = FIXTURES[name]
        if (path === undefined) return reply(400, { error: `unknown fixture ${name}` })
        process.env['DSH_SNAPSHOT_FILE'] = path
        return reply(200, { ok: true, fixture: name })
      }
      case '/drop': {
        const offlineMs = Number(body['offlineMs'] ?? 0)
        offlineUntil = Date.now() + offlineMs
        destroyLiveSockets()
        return reply(200, { ok: true, offlineMs })
      }
      case '/ack-drop': {
        ackDropRemaining += Number(body['count'] ?? 1)
        return reply(200, { ok: true, droppedSoFar: ackDropped.length })
      }
      case '/runtimes': {
        const runtimes = supervisor
          .activeRunIds()
          .map((runId) => ({ runId, pid: runtimePids.get(runId) ?? -1 }))
        return reply(200, { runtimes, spawnCounts: Object.fromEntries(spawnCounts) })
      }
      case '/input-manifest': {
        const runId = String(body['runId'] ?? url.searchParams.get('runId') ?? '')
        const recorded = inputManifests.get(runId)
        if (recorded === undefined)
          return reply(404, {
            error: 'no input manifest recorded for run',
            known: [...inputManifests.keys()],
          })
        return reply(200, { runId, ...recorded })
      }
      case '/workspace-path': {
        // G6-07 负断言数据源：canonical workspace 真实目录（127.0.0.1 控制口内
        // 观测缝，不进证据/git——红线判据要求「真实目录不出现」而非形态猜测）。
        return reply(200, { canonicalPath: registered.canonicalPath })
      }
      case '/state': {
        return reply(200, {
          activeRunIds: supervisor.activeRunIds(),
          pendingRunIds: eventStore.runIdsWithPending(),
          watermarks: eventStore.seqWatermarkByRun(),
          ackDropped: ackDropped.length,
        })
      }
      default:
        return reply(404, { error: 'not found' })
    }
  })
})
controlServer = server
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    process.stderr.write('e2e-node: no control port\n')
    process.exit(1)
  }
  // stdout 契约行（e2e-serve 解析；不含任何 Token）。
  process.stdout.write(
    `E2E_NODE_READY ${JSON.stringify({ controlPort: address.port, controlToken, deviceId: config.deviceId, workspaceId: registered.id })}\n`,
  )
})

const bye = (): void => {
  try {
    session.stop()
  } catch {
    // 已停。
  }
  try {
    controlServer?.close()
  } catch {
    // 已关。
  }
  process.exit(0)
}
process.on('SIGTERM', () => void bye())
process.on('SIGINT', () => void bye())
