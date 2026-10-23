import { checkPreparation } from './workspace/preparation.js'
/**
 * Node CLI（02 Task 9 Step 3/5）。
 *   whalepod-node pair --hub <url> --code <code> [--name <n>] ...
 *   whalepod-node start
 *
 * 零三方依赖（node:util parseArgs）。pair 写本地配置（mode 0600）；
 * start 持有出站连接 + 心跳循环 + 退避重连，收到 node.token_revoked 时清理本地 Token。
 */
import { parseArgs } from 'node:util'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { claimDevice } from './pairing/client.js'
import { DEFAULT_CONFIG_DIR, loadConfig, saveConfig } from './config.js'
import { startDeviceSession } from './gateway/session.js'
import {
  createHelloFacts,
  detectPlatformKind,
  refreshHelloAfterPreflight,
} from './gateway/hello-facts.js'
import { installedPackDigests } from './plugin/runtime-config.js'
import { resolveDshVersionFacts } from './plugin/dsh-version-probe.js'
import type { PluginFetch } from './plugin/installer.js'
import { registryFileRevision, WorkspaceRegistry } from './workspace/registry.js'
import { WorkspaceInventory } from './workspace/inventory.js'
import { SecretStore } from './secret/store.js'
import { runWorkspaceCommand, runSecretSet, readHiddenLine } from './workspace/cli-commands.js'

interface PairArgs {
  hub: string
  code: string
  name: string
  platform: 'darwin' | 'linux' | 'win32'
  architecture: string
  nodeVersion: string
  nodeAppVersion: string
}

async function runPair(args: PairArgs): Promise<void> {
  const result = await claimDevice(
    args.hub,
    args.code,
    {
      name: args.name,
      platform: args.platform,
      architecture: args.architecture,
      nodeVersion: args.nodeVersion,
      nodeAppVersion: args.nodeAppVersion,
    },
    { idempotencyKey: randomUUID() },
  )
  const path = await saveConfig({
    hubUrl: args.hub,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
  })
  process.stdout.write(`paired: deviceId=${result.deviceId}\nconfig saved to ${path}\n`)
  // 明文 Token 仅在 stderr 出现一次供运维记录；pair 成功后不回显到 stdout 日志流。
  process.stderr.write(`device token (shown once): ${result.deviceToken}\n`)
}

async function runStart(dshVersion: string | undefined, stateDir: string): Promise<void> {
  const config = await loadConfig()
  if (config === undefined) {
    process.stderr.write('no local config: run `whalepod-node pair` first\n')
    process.exit(1)
  }
  // Runtime 入口：@whalepod/runtime 的 bin 产物（部署包内 resolve；P1-20 安装门兜底）。
  // #97：按 runtime 包 exports 声明的公开子路径解析（原先解 './dist/bin.js'
  // 深路径，未 exports ⟹ ERR_PACKAGE_PATH_NOT_EXPORTED，start 启动即死）。
  const createRequire = (await import('node:module')).createRequire
  const runtimeEntry = createRequire(import.meta.url).resolve('@whalepod/runtime/bin')
  // #288：「敏感不兼容禁启动」的左侧操作数——本机真实 DSH 版本由 Runtime 自报
  //（唯一允许 import @deepseek-ai/* 的一侧），不再由操作者声明。探针失败 → probed
  // 为 null：上报照旧走显式参数/环境变量/'unmanaged' 的诚实兜底，而 pack 兼容闸
  // fail-closed 拒绝。两个消费者（hello 上报、preflight 闸）共用这一次装配。
  const dshVersionFacts = await resolveDshVersionFacts(runtimeEntry, {
    declared: dshVersion,
    env: process.env.WHALEPOD_DSH_VERSION,
  })
  if (dshVersionFacts.probed === null) {
    // 探针失败在 Node 日志里要看得见（否则只在某次 Run 被拒时间接暴露）。
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        component: 'node.plugin',
        msg: 'dsh version probe failed; plugin pack compatibility gate will refuse non-core packs',
        reported: dshVersionFacts.reported,
      })}\n`,
    )
  }
  // #352：hello 事实不再冻结在启动时刻——进程/平台/架构是常量，但**pack 目录**会随
  // preflight 安装/重建变化、**DSH 版本**会在本机换版后变化。组装成函数：
  // 每条连接重算 + preflight 装包后经 session.refreshHello() 会话内刷新，
  // 设备视图（Hub 的 node.hello 事实列）不必等 Node 重启。
  // #352：hello 事实按连接重算（实现与判据在 gateway/hello-facts.ts，与 E2E harness 共用）。
  const helloFacts = createHelloFacts({
    stateDir,
    runtimeEntry,
    startupDshVersion: dshVersionFacts.reported,
  })

  // ---- P1-13 运行会话层装配（02 Task 13）----
  const { mkdirSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { CommandStore } = await import('./spool/command-store.js')
  const { EventStore } = await import('./spool/event-store.js')
  const { RuntimeSupervisor } = await import('./supervisor/runtime-supervisor.js')
  const { DshRuntimeDriver } = await import('./runtime-driver.js')
  const { RunManager } = await import('./run/run-manager.js')
  const { PackageStore } = await import('./plugin/package-store.js')
  const { PluginInstaller, DEFAULT_ALLOWED_HOSTS, DEFAULT_MAX_TARBALL_BYTES, readCappedBody } =
    await import('./plugin/installer.js')
  const { PluginPackPreflight } = await import('./plugin/plugin-preflight.js')
  const { fetchPluginPackDescriptor } = await import('./run/pack-descriptor-client.js')
  // P1-15：Artifact 采集与 Reviewer 输入准备。
  const { ArtifactCollector } = await import('./artifact/collect.js')
  const { uploadArtifactCandidate } = await import('./artifact/upload-client.js')
  const { ArtifactInputsManager } = await import('./artifact/inputs.js')
  const { OfficePreviewGenerator } = await import('./artifact/preview.js')
  const { uploadArtifactPreview, reportArtifactPreviewFailure } =
    await import('./artifact/preview-upload-client.js')

  const artifactLog = (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => {
    process.stderr.write(`${JSON.stringify({ level, msg, ...context })}\n`)
  }
  const artifactInputs = new ArtifactInputsManager({
    hubUrl: config.hubUrl,
    deviceToken: config.deviceToken,
    inputsRoot: join(stateDir, 'runtime-inputs'),
    log: artifactLog,
  })
  // #431：Office 只读预览。转换工具默认取 PATH 上的 soffice，部署侧可用
  // WHALEPOD_SOFFICE 指向具体二进制；缺失时只登记预览失败，不影响原件交付。
  const officePreview = new OfficePreviewGenerator({
    stagingDir: join(stateDir, 'artifact-previews'),
    ...(process.env.WHALEPOD_SOFFICE === undefined
      ? {}
      : { sofficePath: process.env.WHALEPOD_SOFFICE }),
    upload: (artifactId, metadata, body) =>
      uploadArtifactPreview(config.hubUrl, config.deviceToken, artifactId, metadata, body, {
        log: artifactLog,
      }),
    reportFailure: (artifactId, report) =>
      reportArtifactPreviewFailure(config.hubUrl, config.deviceToken, artifactId, report, {
        log: artifactLog,
      }),
    log: artifactLog,
  })
  const artifactCollector = new ArtifactCollector({
    stagingDir: join(stateDir, 'artifact-staging'),
    // 幂等键每次 collect 生成一次（客户端对瞬时失败用同一 key 重试 → Hub 回执幂等）。
    upload: (runId, payload, body) =>
      uploadArtifactCandidate(config.hubUrl, config.deviceToken, runId, payload, body, {
        idempotencyKey: randomUUID(),
        log: artifactLog,
      }),
    preview: officePreview,
    log: artifactLog,
  })

  mkdirSync(stateDir, { recursive: true })
  const registry = new WorkspaceRegistry(join(stateDir, 'workspace-registry.sqlite'))
  const secrets = new SecretStore(join(stateDir, 'secrets.json'))
  // #89：inventory 事实源（本地真值：registry.resolve preflight + secrets slot 名）。
  const inventory = new WorkspaceInventory(registry, secrets)

  // ---- P1-17 插件 pack preflight 装配（02 Task 17 Step 5；先于 RunManager）----
  const packsRoot = join(stateDir, 'plugin-packs')
  const pluginStore = new PackageStore(join(stateDir, 'plugin-store'))
  // 生产 tarball fetch：全局 fetch（redirect: 'manual'——重定向由 installer 层
  // 逐跳跟随且每跳过 host 白名单，M3）；body 流式边读边计数，超限即中止（M4：
  // 不把无界 body 收满进内存）。3xx 不透传 body（installer 只看 Location 头）。
  const pluginFetch: PluginFetch = async (url) => {
    const response = await fetch(url, { redirect: 'manual' })
    const location = response.headers.get('location') ?? undefined
    if (response.status >= 300 && response.status < 400) {
      return location === undefined
        ? { status: response.status, body: Buffer.alloc(0) }
        : { status: response.status, location, body: Buffer.alloc(0) }
    }
    try {
      const body = await readCappedBody(response.body, DEFAULT_MAX_TARBALL_BYTES)
      return { status: response.status, body }
    } catch (error) {
      // 超限/读失败：中止下载释放连接，再以原错误上抛（installer 折算 wire 码）。
      await response.body?.cancel().catch(() => {})
      throw error
    }
  }
  const preflight = new PluginPackPreflight({
    packsRoot,
    store: pluginStore,
    installer: new PluginInstaller({
      store: pluginStore,
      fetchImpl: pluginFetch,
      allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
      maxTarballBytes: DEFAULT_MAX_TARBALL_BYTES,
    }),
    fetchDescriptor: (packDigest) =>
      fetchPluginPackDescriptor(config.hubUrl, config.deviceToken, packDigest),
    // #288：本机 DSH 版本是启动时探针的常量（升级 DSH 要重启 Node——升级流程
    // 本来就要求重启）。探针失败时这里恒为 null：兼容闸 fail-closed 拒绝 pack。
    localDshVersion: () => Promise.resolve(dshVersionFacts.probed),
    log: (level, msg, context) => {
      process.stderr.write(
        `${JSON.stringify({ level, component: 'node.plugin', msg, ...context })}\n`,
      )
    },
  })

  // #118：sessionSend 的 let 必须先于 RunManager 构造与 recoverOrphans() 执行——
  // 否则「RunManager send 闭包（L190 形态）在 TDZ 内求值 sessionSend」，有孤儿
  // 时启动即崩（alpha.2 狗食实录：一孤儿一崩）。no-op 默认值正是为会话建立前
  // 的这段窗口准备的，但 TDZ 会让默认值根本来不及生效。
  let sessionSend: (frame: string) => void = () => {}
  const supervisor = new RuntimeSupervisor({
    // #356：spawn 时把本进程探针到的 DSH 版本记进 active_runtime——Node 重启后
    // 据此区分「换过版本（升级/回滚）」与「进程丢了」。probed 未知（探针失败）时
    // 记 null：那时宁可报通用的 RUNTIME_LOST，也不谎报换版。
    dshDistributionVersion: dshVersionFacts.probed,
    driver: new DshRuntimeDriver({ runtimeEntry }),
    registry,
    secrets,
    stateDbPath: join(stateDir, 'supervisor.sqlite'),
    capacity: 2,
    runtimeTimeoutMs: 6 * 60 * 60 * 1000, // 单 Run wall-clock 上限（02 约束）
    onStdoutLine: (runId, line) => runManager.handleStdoutLine(runId, line),
  })
  // ---- P1-16 运行会话层装配（取消升级 / 退出归因 / lost 上报）----
  // RunManager 必须先于 recoverOrphans 就绪：孤儿处理产生的 lost(RUNTIME_LOST)
  // 快照由它缓冲到重连补发（R9），cli 只留结构化痕迹。
  const runManager = new RunManager({
    supervisor,
    registry,
    commandStore: new CommandStore(join(stateDir, 'commands.sqlite')),
    eventStore: new EventStore(join(stateDir, 'events.sqlite')),
    send: (frame) => sessionSend(frame),
    runtimeHomeFor: (runId) => {
      const dir = join(stateDir, 'runtime-home', runId)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    homeDir: homedir(),
    // 脱敏上下文（P1-17 红线）：自定义 --state-dir 在 home 之外时，pack overlay
    // 绝对路径会经 runtime.fatal summary 进团队投影，投影前必须归约。
    stateDir,
    packsRoot,
    // #352：preflight 成功后（非 core-empty）补发一次 hello——设备视图在本连接内收敛。
    pluginPackPreflight: (packDigest) =>
      refreshHelloAfterPreflight({
        ensure: (digest) => preflight.ensure(digest),
        refreshHello: () => deviceSession?.refreshHello(),
      })(packDigest),
    // P1-15：候选采集 + Reviewer 输入准备/清理。
    artifactCollector,
    prepareArtifactInputs: (runId, taskId) => artifactInputs.prepare(runId, taskId),
    cleanupArtifactInputs: (runId) => artifactInputs.cleanup(runId),
    deviceId: config.deviceId,
    // Run 固化面用**启动时**的探针值（#288 口径：一次装配、多次消费）；#352 刷新的是
    // hello 事实列（设备视图），不动 Runs 的固化语义。
    dshDistributionVersion: dshVersionFacts.reported,
    // 取消升级节奏（03 §3.2：15s 未确认强杀 + 5s SIGTERM 宽限）走默认值。
    log: (level, msg, context) => {
      process.stderr.write(`${JSON.stringify({ level, component: 'node.run', msg, ...context })}\n`)
    },
  })
  supervisor.onLost((runId, reason) => {
    // lost 事实已由 RunManager 归因上报（snapshot lost）；这里只留审计痕迹。
    process.stderr.write(
      `${JSON.stringify({ level: 'error', component: 'node.supervisor', msg: 'runtime lost', runId, reason })}\n`,
    )
  })
  // Node 重启：孤儿三重匹配处理后交人工重跑（不自动复活 Run）。
  await supervisor.recoverOrphans()

  // #352：preflight 装/重建 pack 后要能补发 hello，而 session 在 runManager 之后创建——
  // 用可变句柄在闭包间传递（不改变装配次序）。
  let deviceSession: { refreshHello: () => void } | undefined
  const session = startDeviceSession({
    config,
    helloFacts,
    onRevoked: () => {
      // 删本地 Token；保留 Workspace/Artifact 数据。
      void revokeLocalConfig()
    },
    onFrame: (frame) => {
      void runManager.handleFrame(frame).catch((error: unknown) => {
        process.stderr.write(
          `${JSON.stringify({ level: 'error', component: 'node.run', msg: 'downstream frame handling failed', error: error instanceof Error ? error.message : String(error) })}\n`,
        )
      })
    },
    onConnected: () => runManager.onReconnect(),
    // #89：连接建立后上报 inventory（Hub 的 Workspace 投影唯一来源；此前生产
    // 链路一帧不发，真实用户 RunLauncher 选不到任何 Workspace）。
    inventoryFacts: () => inventory.build(),
    preparationCheck: (request) => checkPreparation(request, { registry, secrets }),
    // #94：变化时重报——registry 文件指纹随心跳节拍探测，`workspace add/remove`
    // （独立短进程写库）无需重启 node 即收敛到 Hub 投影。
    inventoryRevision: () => registryFileRevision(join(stateDir, 'workspace-registry.sqlite')),
    onInventoryError: (error) => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          component: 'node.gateway',
          msg: 'inventory report failed',
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      )
    },
    heartbeatFacts: () => runManager.heartbeatFacts(),
    // #103：心跳事实采集失败（SQLite 等）只 warn 不掀进程——与 inventory 同构。
    onHeartbeatError: (error) => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          component: 'node.gateway',
          msg: 'heartbeat facts failed',
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      )
    },
    exit: (code, message) => {
      process.stderr.write(`${message}\n`)
      process.exit(code)
    },
  })
  // #352：句柄落地——此后 preflight 装/重建 pack 会经它刷新 hello（事实变了才发）。
  deviceSession = session
  sessionSend = session.send
}

async function revokeLocalConfig(): Promise<void> {
  const fs = await import('node:fs/promises')
  const { DEFAULT_CONFIG_DIR } = await import('./config.js')
  const { join } = await import('node:path')
  try {
    await fs.unlink(join(DEFAULT_CONFIG_DIR, 'config.json'))
  } catch {
    // 已删则忽略。
  }
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      hub: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string', default: 'whalepod-node' },
      platform: { type: 'string' },
      architecture: { type: 'string', default: process.arch },
      'node-version': { type: 'string', default: process.version },
      'node-app-version': { type: 'string', default: '0.1.0' },
      'dsh-version': { type: 'string' },
      'state-dir': { type: 'string' },
    },
    allowPositionals: true,
  })
  const command = positionals[0]
  if (command === 'pair') {
    if (values.hub === undefined || values.code === undefined) {
      process.stderr.write('usage: whalepod-node pair --hub <url> --code <code>\n')
      process.exit(2)
    }
    await runPair({
      hub: values.hub,
      code: values.code,
      name: values.name ?? 'whalepod-node',
      platform: (values.platform as 'darwin' | 'linux' | 'win32') ?? detectPlatformKind(),
      architecture: values.architecture ?? process.arch,
      nodeVersion: values['node-version'] ?? process.version,
      nodeAppVersion: values['node-app-version'] ?? '0.1.0',
    })
    return
  }
  if (command === 'start') {
    await runStart(values['dsh-version'], values['state-dir'] ?? join(DEFAULT_CONFIG_DIR, 'state'))
    return
  }
  if (command === 'workspace' || command === 'secret') {
    const stateDir = values['state-dir'] ?? join(DEFAULT_CONFIG_DIR, 'state')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(stateDir, { recursive: true })
    const { join: joinPath } = await import('node:path')
    const deps = {
      registry: new WorkspaceRegistry(joinPath(stateDir, 'workspace-registry.sqlite')),
      secrets: new SecretStore(joinPath(stateDir, 'secrets.json')),
      write: (text: string) => process.stdout.write(text),
    }
    if (command === 'workspace') {
      const sub = positionals[1] ?? ''
      await runWorkspaceCommand(deps, sub, {
        path: positionals[2],
        name: values.name,
        id: positionals[2],
      })
      return
    }
    // 参数序以 usage 与权威规格（02 计划）为准：secret set <provider> <slot>。
    // 实现曾把 'set' 当 provider 解析并要求 'set' 在末尾——照文档敲必 EXIT=2
    // 不落盘（PR #121 评审实录；workspace-cli.spec.ts 绕过 main() 层所以从未暴露）。
    if (positionals[1] !== 'set') {
      process.stderr.write('usage: whalepod-node secret set <provider> <slot>\n')
      process.exit(2)
    }
    const provider = positionals[2]
    const slot = positionals[3]
    if (provider === undefined || slot === undefined) {
      process.stderr.write('usage: whalepod-node secret set <provider> <slot>\n')
      process.exit(2)
    }
    await runSecretSet(deps, provider, slot, readHiddenLine)
    return
  }
  process.stderr.write('usage: whalepod-node <pair|start> [options]\n')
  process.exit(2)
}

/**
 * 顶层调用（#95）：`package.json` 的 `bin.whalepod-node` 指向本模块的编译产物，
 * 因此**被作为脚本直接执行时**必须调用 `main`——此前文件到函数定义就结束，
 * 装好的 CLI 加载、定义、exit 0 静默退出，任何子命令都是空操作。
 *
 * 保护条件：被 `import` 时（单测直接调 `main`、或他人复用装配）绝不能自动执行，
 * 否则 import 即产生副作用（打 usage 并 exit 2）。判据用 realpath 比对，同时兼容
 * bin 跑 `.js` 与 tsx 直跑 `.ts` 两种入口形态。
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // argv[1] 不可解析（不存在的入口路径等）：按「不是直接执行」处理，绝不误跑。
    return false
  }
}

if (invokedAsScript()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // 归因纪律：未预期失败必须有结构化出口（component=node.cli），不许静默成功。
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        component: 'node.cli',
        msg: 'fatal',
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    )
    process.exit(1)
  })
}
