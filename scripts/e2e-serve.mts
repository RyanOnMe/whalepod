#!/usr/bin/env tsx
/**
 * e2e 环境引导（P1-07 验收场景；配合 scripts/with-test-postgres.mts 使用）。
 *
 * 用法: tsx scripts/e2e-serve.mts（playwright webServer 直接拉起——本进程必须是
 * playwright 的直接子进程，SIGTERM 才能到达，容器与子进程的清理才可保证）
 *
 * 职责：
 * 0. 经 scripts/lib/ephemeral-postgres.mts 启动一次性 PostgreSQL（退出时删除）；
 * 1. 应用 packages/db 迁移（applyMigrations，公开导出）；
 * 2. 以生产入口拉起真实 Hub 子进程（apps/hub/src/server.ts，含 OutboxWorker/租约循环），
 *    PROJECT311_PUBLIC_ORIGIN 指向 Web dev origin（同源反代部署形态，03 §4）；
 * 3. 拉起 apps/web 的 vite dev server（5173，/api/v1、/ws/v1 反代到 Hub）；
 * 4. 双端就绪后把环境清单（Hub origin、Setup Token 路径）写到临时清单文件，
 *    供 playwright spec 读取；Token 明文不进 git、不进日志。
 * 进程退出/收到 SIGTERM/SIGINT 时清理子进程。
 */
import { spawn } from 'node:child_process'
import type { EphemeralPostgres } from './lib/ephemeral-postgres.mts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HUB_PORT = 18080
const WEB_PORT = 5173
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
const ENV_FILE = join(tmpdir(), 'project311-e2e-env.json')
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 400

const log = (message: string): void => console.error(`[e2e-serve] ${message}`)

function fail(message: string): never {
  log(`FAIL ${message}`)
  process.exit(1)
}

const children: Array<ReturnType<typeof spawn>> = []
let postgres: EphemeralPostgres | undefined
let shuttingDown = false

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
  }
  await postgres?.stop()
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('exit', () => void shutdown())

async function waitReady(url: string, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        log(`${label} 就绪：${url}`)
        return
      }
    } catch {
      // 未就绪，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  fail(`${label} 在 ${READY_TIMEOUT_MS}ms 内未就绪：${url}`)
}

// ---- 0. 一次性 PostgreSQL（与 Q2 同一容器实现） ----
const { startEphemeralPostgres } = await import('./lib/ephemeral-postgres.mts')
// 自愈：playwright 对 webServer 的终止可能是 SIGKILL（handler 不会跑），
// 上一次运行的残留容器在本进程启动前按专属 label 清掉，不碰无关容器。
const { execFile: execFileCb } = await import('node:child_process')
const { promisify } = await import('node:util')
const execFileAsync = promisify(execFileCb)
try {
  const stale = await execFileAsync('docker', [
    'ps',
    '-q',
    '--filter',
    'label=project311.e2e-postgres=true',
  ])
  const ids = stale.trim().split('\n').filter(Boolean)
  if (ids.length > 0) {
    await execFileAsync('docker', ['rm', '-f', ...ids])
    log(`自愈：清理上一次残留容器 ${ids.length} 个`)
  }
} catch {
  // Docker 暂不可用等情况交由 startEphemeralPostgres 报错。
}
postgres = await startEphemeralPostgres()
const databaseUrl = postgres.databaseUrl

// ---- 1. 迁移（真实迁移路径；与 Q2 同一 applyMigrations 公开导出） ----
const { applyMigrations, createDatabase } = await import('../packages/db/src/index.js')
const database = createDatabase({ connectionString: databaseUrl })
await applyMigrations(database)
await database.close()
log('迁移已应用')

// ---- 2. Hub（生产入口子进程） ----
const setupDir = await mkdtemp(join(tmpdir(), 'project311-e2e-hub-'))
const setupTokenPath = join(setupDir, 'setup-token')
const hub = spawn(process.execPath, ['--import', 'tsx', 'apps/hub/src/server.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PROJECT311_PUBLIC_ORIGIN: WEB_ORIGIN,
    PROJECT311_SETUP_TOKEN_PATH: setupTokenPath,
    HOST: '127.0.0.1',
    PORT: String(HUB_PORT),
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
children.push(hub)
let hubStderr = ''
hub.stderr?.on('data', (chunk: Buffer) => {
  hubStderr += chunk.toString()
  if (hubStderr.length > 16_000) hubStderr = hubStderr.slice(-8000)
})
hub.on('exit', (code, signal) => {
  if (!shuttingDown) {
    log(`Hub 提前退出 code=${code} signal=${signal}\n${hubStderr.slice(-2000)}`)
    void shutdown()
    process.exit(1)
  }
})

// ---- 3. Web dev server（vite，同源反代） ----
const vite = spawn(
  'pnpm',
  ['--filter', '@project311/web', 'exec', 'vite', '--port', String(WEB_PORT), '--strictPort'],
  {
    env: { ...process.env, PROJECT311_HUB_ORIGIN: `http://127.0.0.1:${HUB_PORT}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
children.push(vite)
let viteStderr = ''
vite.stderr?.on('data', (chunk: Buffer) => {
  viteStderr += chunk.toString()
  if (viteStderr.length > 16_000) viteStderr = viteStderr.slice(-8000)
})
vite.on('exit', (code, signal) => {
  if (!shuttingDown) {
    log(`vite 提前退出 code=${code} signal=${signal}\n${viteStderr.slice(-2000)}`)
    void shutdown()
    process.exit(1)
  }
})

// ---- 4. 就绪等待 + 环境清单 ----
await waitReady(`http://127.0.0.1:${HUB_PORT}/api/v1/setup/status`, 'Hub')
await waitReady(`http://localhost:${WEB_PORT}/`, 'Web')

const { readFile } = await import('node:fs/promises')
const setupToken = (await readFile(setupTokenPath, 'utf8')).trim()
await writeFile(
  ENV_FILE,
  JSON.stringify({
    hubOrigin: `http://127.0.0.1:${HUB_PORT}`,
    webOrigin: WEB_ORIGIN,
    setupTokenPath,
    setupToken,
  }),
  { mode: 0o600 },
)
log(`环境清单：${ENV_FILE}（Token 明文只在 0600 文件与清单中，不进 git/日志）`)
log('e2e 环境就绪，保持运行直至父进程退出')
setInterval(() => {}, 60_000) // 保活，等待 playwright webServer 结束本进程
