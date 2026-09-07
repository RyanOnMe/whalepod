/**
 * Node CLI（02 Task 9 Step 3/5）。
 *   project311-node pair --hub <url> --code <code> [--name <n>] ...
 *   project311-node start
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
import type { HelloFacts } from './gateway/hub-socket.js'
import { startDeviceSession } from './gateway/session.js'
import { installedPackDigests } from './plugin/runtime-config.js'
import type { PluginFetch } from './plugin/installer.js'
import { WorkspaceRegistry } from './workspace/registry.js'
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

function detectPlatform(): 'darwin' | 'linux' | 'win32' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin'
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
    process.stderr.write('no local config: run `project311-node pair` first\n')
    process.exit(1)
  }
  // dsh 发行版版本：显式参数 > 环境变量 > 'unmanaged'（本机未托管 DSH 运行时的诚实标注；
  // P1-12 由 runtime 装配给出真实版本）。pluginPackDigests：本地已就绪 pack 目录
  // （P1-17；marker 校验通过才上报，半途/损坏目录不上报）。
  const facts: HelloFacts = {
    nodeVersion: process.version,
    platform: detectPlatform(),
    architecture: process.arch,
    dshDistributionVersion: dshVersion ?? process.env.PROJECT311_DSH_VERSION ?? 'unmanaged',
    pluginPackDigests: installedPackDigests(join(stateDir, 'plugin-packs')),
  }

  // ---- P1-13 运行会话层装配（02 Task 13）----
  const { mkdirSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
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
  const artifactCollector = new ArtifactCollector({
    stagingDir: join(stateDir, 'artifact-staging'),
    // 幂等键每次 collect 生成一次（客户端对瞬时失败用同一 key 重试 → Hub 回执幂等）。
    upload: (runId, payload, body) =>
      uploadArtifactCandidate(config.hubUrl, config.deviceToken, runId, payload, body, {
        idempotencyKey: randomUUID(),
        log: artifactLog,
      }),
    log: artifactLog,
  })

  mkdirSync(stateDir, { recursive: true })
  const registry = new WorkspaceRegistry(join(stateDir, 'workspace-registry.sqlite'))
  const secrets = new SecretStore(join(stateDir, 'secrets.json'))

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
    log: (level, msg, context) => {
      process.stderr.write(
        `${JSON.stringify({ level, component: 'node.plugin', msg, ...context })}\n`,
      )
    },
  })

  // Runtime 入口：@project311/runtime 的 bin 产物（部署包内 resolve；P1-20 安装门兜底）。
  // #97：按 runtime 包 exports 声明的公开子路径解析（原先解 './dist/bin.js'
  // 深路径，未 exports ⟹ ERR_PACKAGE_PATH_NOT_EXPORTED，start 启动即死）。
  const runtimeEntry = createRequire(import.meta.url).resolve('@project311/runtime/bin')
  const supervisor = new RuntimeSupervisor({
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
    pluginPackPreflight: (packDigest) => preflight.ensure(packDigest),
    // P1-15：候选采集 + Reviewer 输入准备/清理。
    artifactCollector,
    prepareArtifactInputs: (runId, taskId) => artifactInputs.prepare(runId, taskId),
    cleanupArtifactInputs: (runId) => artifactInputs.cleanup(runId),
    deviceId: config.deviceId,
    dshDistributionVersion: facts.dshDistributionVersion,
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

  let sessionSend: (frame: string) => void = () => {}
  const session = startDeviceSession({
    config,
    facts,
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
    heartbeatFacts: () => runManager.heartbeatFacts(),
    exit: (code, message) => {
      process.stderr.write(`${message}\n`)
      process.exit(code)
    },
  })
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
      name: { type: 'string', default: 'project311-node' },
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
      process.stderr.write('usage: project311-node pair --hub <url> --code <code>\n')
      process.exit(2)
    }
    await runPair({
      hub: values.hub,
      code: values.code,
      name: values.name ?? 'project311-node',
      platform: (values.platform as 'darwin' | 'linux' | 'win32') ?? detectPlatform(),
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
    const provider = positionals[1]
    const slot = positionals[2]
    if (provider === undefined || slot === undefined) {
      process.stderr.write('usage: project311-node secret set <provider> <slot>\n')
      process.exit(2)
    }
    if (positionals[3] !== 'set') {
      process.stderr.write('usage: project311-node secret set <provider> <slot>\n')
      process.exit(2)
    }
    await runSecretSet(deps, provider, slot, readHiddenLine)
    return
  }
  process.stderr.write('usage: project311-node <pair|start> [options]\n')
  process.exit(2)
}

/**
 * 顶层调用（#95）：`package.json` 的 `bin.project311-node` 指向本模块的编译产物，
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
