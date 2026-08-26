/**
 * Node CLI（02 Task 9 Step 3/5）。
 *   project311-node pair --hub <url> --code <code> [--name <n>] ...
 *   project311-node start
 *
 * 零三方依赖（node:util parseArgs）。pair 写本地配置（mode 0600）；
 * start 持有出站连接 + 心跳循环 + 退避重连，收到 node.token_revoked 时清理本地 Token。
 */
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { claimDevice } from './pairing/client.js'
import { loadConfig, saveConfig } from './config.js'
import type { HelloFacts } from './gateway/hub-socket.js'
import { startDeviceSession } from './gateway/session.js'

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

async function runStart(dshVersion: string | undefined): Promise<void> {
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
  startDeviceSession({
    config,
    facts,
    onRevoked: () => {
      // 删本地 Token；保留 Workspace/Artifact 数据。
      void revokeLocalConfig()
    },
    exit: (code, message) => {
      process.stderr.write(`${message}\n`)
      process.exit(code)
    },
  })
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
    await runStart(values['dsh-version'])
    return
  }
  process.stderr.write('usage: project311-node <pair|start> [options]\n')
  process.exit(2)
}
