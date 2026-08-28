/**
 * Node CLI（02 Task 9 Step 3/5）。
 *   project311-node pair --hub <url> --code <code> [--name <n>] ...
 *   project311-node start
 *
 * 零三方依赖（node:util parseArgs）。pair 写本地配置（mode 0600）；
 * start 持有出站连接 + 心跳循环 + 退避重连，收到 node.token_revoked 时清理本地 Token。
 */
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { claimDevice } from './pairing/client.js'
import { DEFAULT_CONFIG_DIR, loadConfig, saveConfig } from './config.js'
import type { HelloFacts } from './gateway/hub-socket.js'
import { startDeviceSession } from './gateway/session.js'
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
  // P1-12 由 runtime 装配给出真实版本）。pluginPackDigests 恒 []：第一阶段不安装插件包。
  const facts: HelloFacts = {
    nodeVersion: process.version,
    platform: detectPlatform(),
    architecture: process.arch,
    dshDistributionVersion: dshVersion ?? process.env.PROJECT311_DSH_VERSION ?? 'unmanaged',
    pluginPackDigests: [],
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

  mkdirSync(stateDir, { recursive: true })
  const registry = new WorkspaceRegistry(join(stateDir, 'workspace-registry.sqlite'))
  const secrets = new SecretStore(join(stateDir, 'secrets.json'))
  // Runtime 入口：@project311/runtime 的 bin 产物（部署包内 resolve；P1-20 安装门兜底）。
  const runtimeEntry = createRequire(import.meta.url).resolve('@project311/runtime/dist/bin.js')
  const supervisor = new RuntimeSupervisor({
    driver: new DshRuntimeDriver({ runtimeEntry }),
    registry,
    secrets,
    stateDbPath: join(stateDir, 'supervisor.sqlite'),
    capacity: 2,
    runtimeTimeoutMs: 6 * 60 * 60 * 1000, // 单 Run wall-clock 上限（02 约束）
    onStdoutLine: (runId, line) => runManager.handleStdoutLine(runId, line),
  })
  supervisor.onLost((runId, reason) => {
    // 丢失语义（RUNTIME_LOST/lost）是 P1-16 的活；这里只留结构化痕迹。
    process.stderr.write(`${JSON.stringify({ level: 'error', component: 'node.supervisor', msg: 'runtime lost', runId, reason })}\n`)
  })
  // Node 重启：孤儿三重匹配处理后交人工重跑（不自动复活 Run）。
  await supervisor.recoverOrphans()

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
    log: (level, msg, context) => {
      process.stderr.write(`${JSON.stringify({ level, component: 'node.run', msg, ...context })}\n`)
    },
  })
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
    await runStart(
      values['dsh-version'],
      values['state-dir'] ?? join(DEFAULT_CONFIG_DIR, 'state'),
    )
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
