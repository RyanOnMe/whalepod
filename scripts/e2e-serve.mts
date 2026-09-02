#!/usr/bin/env tsx
/**
 * e2e 环境引导（P1-07 验收场景；P1-19 扩展全链与恢复场景；配合
 * scripts/lib/ephemeral-postgres.mts 使用）。
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
 * 4. 双端就绪后把环境清单（Hub origin、Setup Token 路径、控制面端口与一次性
 *    Token）写到临时清单文件，供 playwright spec 读取；Token 明文不进 git、不进日志；
 * 5. （P1-19）控制面 HTTP（仅 127.0.0.1，Bearer 一次性 Token）：
 *    - Node 子进程生命周期：start（真配对 + e2e-node.mts）/ stop（TERM/KILL）/
 *      restart / 到 Node 内部控制口的代理（故障注入：拔线、吞 ack、切快照；观测：
 *      真 pid、输入清单、spool 水位）；
 *    - Hub 进程生命周期：kill + restart（同端口同库——R1/R8 真进程重启语义）；
 *    - 脱敏 DB 事实：按 Run 的白名单列快照（判定/取证用，凭据列绝不出）；
 *    - harness.seed：Plugin Pack 行种子（P1-18 既有验收惯例——Pack 管理流不在
 *      E2E 复跑，replay overlay 经环境变量验收缝进 Runtime）；
 *    - 日志尾（redactText 归约后出仓，失败证据用）。
 * 进程退出/收到 SIGTERM/SIGINT 时清理子进程与容器。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { EphemeralPostgres } from './lib/ephemeral-postgres.mts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { schema } from '@project311/db'
import { digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import { redactText } from './lib/phase1/events.js'

const HUB_PORT = 18080
const WEB_PORT = 5173
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
const ENV_FILE = join(tmpdir(), 'project311-e2e-env.json')
const NODE_STATE_ROOT = join(tmpdir(), 'project311-e2e-node')
// Artifact store：Hub 默认落在 ./data（仓库目录，E2E 不该污染）；固定 tmp 路径让
// Hub 重启前后 blob 连续，启动时整体清空。
const HUB_ARTIFACT_STORE = join(tmpdir(), 'project311-e2e-hub-artifacts')
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 400
const NODE_READY_TIMEOUT_MS = 60_000
const TAIL_LIMIT = 120_000

const log = (message: string): void => console.error(`[e2e-serve] ${message}`)

function fail(message: string): never {
  log(`FAIL ${message}`)
  process.exit(1)
}

// 环形日志尾（内存）：证据采集经控制面取回（redact 后），不落本机散文件。
class Tail {
  private text = ''
  append(chunk: string): void {
    this.text += chunk
    if (this.text.length > TAIL_LIMIT) this.text = this.text.slice(-TAIL_LIMIT / 2)
  }
  get capped(): string {
    return this.text
  }
}

const hubStderr = new Tail()
const hubStdout = new Tail()
const viteStderr = new Tail()
const nodeStdout = new Tail()
const nodeStderr = new Tail()

let hub: ChildProcess | undefined
let hubIntentional = false

async function spawnHub(databaseUrl: string, setupTokenPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/hub/src/server.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PROJECT311_PUBLIC_ORIGIN: WEB_ORIGIN,
      PROJECT311_SETUP_TOKEN_PATH: setupTokenPath,
      PROJECT311_ARTIFACT_STORE_DIR: HUB_ARTIFACT_STORE,
      HOST: '127.0.0.1',
      PORT: String(HUB_PORT),
      // info 级结构化日志（allowlist 字段，产品侧已脱敏）——失败证据的 hub 层来源。
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => hubStdout.append(chunk))
  child.stderr?.on('data', (chunk: string) => hubStderr.append(chunk))
  child.on('exit', (code, signal) => {
    if (!hubIntentional && !shuttingDown) {
      log(`Hub 提前退出 code=${code} signal=${signal}\n${redactText(hubStderr.capped.slice(-2000))}`)
      void shutdown()
      process.exit(1)
    }
  })
  return child
}

let postgres: EphemeralPostgres | undefined
let shuttingDown = false
const viteChild: ChildProcess[] = []

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stopNodeChild('SIGKILL')
  hubIntentional = true
  if (hub !== undefined && hub.exitCode === null && hub.signalCode === null) hub.kill('SIGTERM')
  for (const child of viteChild) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  await postgres?.stop()
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('exit', () => void shutdown())

async function waitReady(url: string, label: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
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
  fail(`${label} 在 ${timeoutMs}ms 内未就绪：${url}`)
}

async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/setup/status`, { signal: AbortSignal.timeout(500) })
    } catch {
      // 连接拒绝 = 端口空；超时类错误也再试。
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
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
// 自愈（P1-19）：上一轮 SIGKILL 残留的 e2e-node / replay Runtime 孙进程按专属
// cmdline 特征清理（本仓库路径 + --run-id/--nonce 判别），不碰无关进程。
for (const pattern of ['project311/scripts/e2e-node.mts', 'project311/apps/runtime/src/bin.ts']) {
  try {
    await execFileAsync('pkill', ['-f', pattern])
  } catch {
    // 无残留（pkill 退出码 1）是常态。
  }
}
postgres = await startEphemeralPostgres()
const databaseUrl = postgres.databaseUrl
{
  const { rm } = await import('node:fs/promises')
  await rm(HUB_ARTIFACT_STORE, { recursive: true, force: true })
}

// ---- 1. 迁移（真实迁移路径；与 Q2 同一 applyMigrations 公开导出） ----
const { applyMigrations, createDatabase } = await import('../packages/db/src/index.js')
const database = createDatabase({ connectionString: databaseUrl })
await applyMigrations(database)
log('迁移已应用')

// ---- 2. Hub（生产入口子进程） ----
const setupDir = await mkdtemp(join(tmpdir(), 'project311-e2e-hub-'))
const setupTokenPath = join(setupDir, 'setup-token')
hub = await spawnHub(databaseUrl, setupTokenPath)

// ---- 3. Web dev server（vite，同源反代） ----
const viteServer = spawn(
  'pnpm',
  ['--filter', '@project311/web', 'exec', 'vite', '--port', String(WEB_PORT), '--strictPort'],
  {
    env: { ...process.env, PROJECT311_HUB_ORIGIN: `http://127.0.0.1:${HUB_PORT}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
viteChild.push(viteServer)
viteServer.stderr?.setEncoding('utf8')
viteServer.stderr?.on('data', (chunk: string) => viteStderr.append(chunk))
viteServer.on('exit', (code, signal) => {
  if (!shuttingDown) {
    log(`vite 提前退出 code=${code} signal=${signal}\n${redactText(viteStderr.capped.slice(-2000))}`)
    void shutdown()
    process.exit(1)
  }
})

// ---- 4. 就绪等待 + 控制面 ----
await waitReady(`http://127.0.0.1:${HUB_PORT}/api/v1/setup/status`, 'Hub')
await waitReady(`http://localhost:${WEB_PORT}/`, 'Web')

const setupToken = (await readFile(setupTokenPath, 'utf8')).trim()
const controlToken = randomUUID()

// ---- Node 子进程管理（P1-19：真 Runtime 全链与 R4/R5/R9 生命周期） ----
interface NodeHandle {
  child: ChildProcess
  controlPort: number
  controlToken: string
  deviceId: string
  workspaceId: string
  stateDir: string
  configDir: string
}
let nodeHandle: NodeHandle | undefined

function stopNodeChild(signal: 'SIGTERM' | 'SIGKILL'): { stopped: boolean } {
  if (nodeHandle === undefined) return { stopped: false }
  const child = nodeHandle.child
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  nodeHandle = undefined
  return { stopped: true }
}

async function startNodeChild(pairingCode: string | undefined): Promise<NodeHandle> {
  if (nodeHandle !== undefined) fail('node already running')
  const { mkdir, rm } = await import('node:fs/promises')
  // 每轮 start 全新 state/config 目录（除非 restart 传入既有路径——由调用方决定）。
  const base = NODE_STATE_ROOT
  const stateDir = join(base, 'state')
  const configDir = join(base, 'config')
  await rm(stateDir, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
  await mkdir(stateDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  const args = ['scripts/e2e-node.mts', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--state-dir', stateDir, '--config-dir', configDir]
  if (pairingCode !== undefined) args.push('--pair-code', pairingCode)
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  const handlePromise = new Promise<NodeHandle>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error('e2e-node READY 超时')), NODE_READY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: string) => {
      nodeStdout.append(chunk)
      buffered += chunk
      const match = /E2E_NODE_READY (\{.*\})/.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        try {
          const info = JSON.parse(match[1]) as {
            controlPort: number
            controlToken: string
            deviceId: string
            workspaceId: string
          }
          resolve({ child, ...info, stateDir, configDir })
        } catch (error) {
          reject(error)
        }
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`e2e-node 提前退出 code=${code} signal=${signal}: ${redactText(nodeStderr.capped.slice(-1500))}`))
    })
  })
  child.stderr?.on('data', (chunk: string) => nodeStderr.append(chunk))
  const handle = await handlePromise
  nodeHandle = handle
  log(`e2e-node 就绪 deviceId=${handle.deviceId.slice(0, 8)} workspace=${handle.workspaceId.slice(0, 8)}`)
  return handle
}

async function restartNodeChild(): Promise<NodeHandle> {
  if (nodeHandle === undefined) fail('node not running; nothing to restart')
  const { configDir, stateDir } = nodeHandle
  stopNodeChild('SIGKILL')
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/e2e-node.mts', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--state-dir', stateDir, '--config-dir', configDir],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => nodeStderr.append(chunk))
  const handle = await new Promise<NodeHandle>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error('e2e-node restart READY 超时')), NODE_READY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: string) => {
      nodeStdout.append(chunk)
      buffered += chunk
      const match = /E2E_NODE_READY (\{.*\})/.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        try {
          resolve({ child, ...(JSON.parse(match[1]) as Omit<NodeHandle, 'child' | 'stateDir' | 'configDir'>), stateDir, configDir })
        } catch (error) {
          reject(error)
        }
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`e2e-node 重启失败 code=${code} signal=${signal}`))
    })
  })
  nodeHandle = handle
  log(`e2e-node 重启就绪（同 state/config）deviceId=${handle.deviceId.slice(0, 8)}`)
  return handle
}

async function proxyToNode(path: string, body: unknown): Promise<unknown> {
  if (nodeHandle === undefined) throw new Error('node not running')
  const res = await fetch(`http://127.0.0.1:${nodeHandle.controlPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-e2e-node-control': nodeHandle.controlToken },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) throw new Error(`node control ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

// ---- 控制面 HTTP（127.0.0.1 + 一次性 Token） ----
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const controlServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    void handleControl(req, res, chunks).catch((error: unknown) => {
      json(res, 500, { error: error instanceof Error ? redactText(error.message) : 'internal' })
    })
  })
})

async function handleControl(req: IncomingMessage, res: ServerResponse, chunks: Buffer[]): Promise<void> {
  if (req.headers['x-e2e-control'] !== controlToken) return json(res, 401, { error: 'unauthorized' })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const body = (chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {}) as Record<string, unknown>
  const route = `${req.method} ${url.pathname}`

  if (route === 'POST /control/plugin-pack/seed') {
    // P1-18 既有验收惯例：Pack 管理流不在 E2E 复跑，行级种子 + 事件留痕。
    const ownerUserId = String(body['ownerUserId'] ?? '')
    const existing = await database.db
      .select({ id: schema.pluginPacks.id })
      .from(schema.pluginPacks)
      .where(eq(schema.pluginPacks.name, 'e2e-pack'))
    if (existing[0] !== undefined) return json(res, 200, { pluginPackId: existing[0].id })
    const id = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id,
      name: 'e2e-pack',
      installations: [],
      // digest 必须与空 entries 复算一致（GET /plugin-packs 的 fail-closed 视图会核）；
      // replay overlay 经环境变量验收缝进 Runtime，Pack 内容为空恰是 E2E 语义。
      packDigest: digestPluginPack({ schemaVersion: 1, packages: [] }),
      createdBy: ownerUserId,
    })
    log('harness.seed: plugin pack')
    return json(res, 200, { pluginPackId: id })
  }

  if (route === 'POST /control/node/start') {
    const pairingCode = body['pairingCode']
    if (typeof pairingCode !== 'string') return json(res, 400, { error: 'pairingCode required' })
    const handle = await startNodeChild(pairingCode)
    return json(res, 200, {
      deviceId: handle.deviceId,
      workspaceId: handle.workspaceId,
      workspaceDir: join(handle.stateDir, 'workspace'),
    })
  }
  if (route === 'POST /control/node/stop') {
    const signal = body['signal'] === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
    return json(res, 200, stopNodeChild(signal))
  }
  if (route === 'POST /control/node/restart') {
    const handle = await restartNodeChild()
    return json(res, 200, {
      deviceId: handle.deviceId,
      workspaceId: handle.workspaceId,
      workspaceDir: join(handle.stateDir, 'workspace'),
    })
  }
  if (route === 'POST /control/node/proxy') {
    const path = String(body['path'] ?? '')
    if (!path.startsWith('/')) return json(res, 400, { error: 'proxy path must start with /' })
    const result = await proxyToNode(path, body['body'])
    return json(res, 200, result)
  }

  if (route === 'POST /control/hub/restart') {
    // R1/R8：真进程重启——同端口、同库、同 Setup Token 文件；Node/Browser 自动重连。
    const signal = body['signal'] === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
    const stayDownMs = Number(body['stayDownMs'] ?? 0)
    const t0 = Date.now()
    hubIntentional = true
    if (hub !== undefined && hub.exitCode === null && hub.signalCode === null) hub.kill(signal)
    await new Promise<void>((resolve) => {
      if (hub === undefined) return resolve()
      hub.once('exit', () => resolve())
    })
    await waitForPortFree(HUB_PORT)
    if (stayDownMs > 0) await new Promise((r) => setTimeout(r, stayDownMs))
    hub = await spawnHub(databaseUrl, setupTokenPath)
    await waitReady(`http://127.0.0.1:${HUB_PORT}/api/v1/setup/status`, 'Hub(restart)')
    return json(res, 200, { downMs: Date.now() - t0, hubOrigin: `http://127.0.0.1:${HUB_PORT}` })
  }

  if (route.startsWith('GET /control/db/run/')) {
    const runId = url.pathname.slice('/control/db/run/'.length)
    const fact = await readRunFact(runId)
    return json(res, 200, fact)
  }

  if (route === 'GET /control/tails') {
    // redactText 源头归约（#73）：repo/tmp/home → 占位符；证据可出机。
    // Node stdout 是 E2E_NODE_READY 交接通道（含控制 Token）——绝不进证据尾。
    return json(res, 200, {
      hubTail: redactText(`${hubStdout.capped}\n${hubStderr.capped}`),
      nodeTail: redactText(nodeStderr.capped),
      viteTail: redactText(viteStderr.capped),
    })
  }

  return json(res, 404, { error: 'not found' })
}

async function readRunFact(runId: string): Promise<unknown> {
  const [run] = await database.db
    .select({
      id: schema.runs.id,
      status: schema.runs.status,
      failureCode: schema.runs.failureCode,
      failureSummary: schema.runs.failureSummary,
      ownerUserId: schema.runs.ownerUserId,
      rerunOfRunId: schema.runs.rerunOfRunId,
      startedAt: schema.runs.startedAt,
      finishedAt: schema.runs.finishedAt,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
  const runEvents = await database.db
    .select({ seq: schema.runEvents.seq, type: schema.runEvents.type, audience: schema.runEvents.audience })
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
    .orderBy(schema.runEvents.seq)
  const approvals = await database.db
    .select({ id: schema.approvals.id, status: schema.approvals.status, toolName: schema.approvals.toolName, decidedBy: schema.approvals.decidedBy })
    .from(schema.approvals)
    .where(eq(schema.approvals.runId, runId))
  const artifacts = await database.db
    .select({ id: schema.artifacts.id, status: schema.artifacts.status, sha256: schema.artifacts.sha256, title: schema.artifacts.title, ownerUserId: schema.artifacts.ownerUserId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.runId, runId))
  const outbox = await database.db
    .select({ type: schema.dispatchOutbox.type, attempts: schema.dispatchOutbox.attemptCount, ackedAt: schema.dispatchOutbox.ackedAt, failedAt: schema.dispatchOutbox.failedAt })
    .from(schema.dispatchOutbox)
    .where(sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`)
  return {
    run: run ?? null,
    runEvents,
    approvals,
    artifacts,
    outbox: outbox.map((o) => ({ type: o.type, attempts: o.attempts, acked: o.ackedAt !== null, failed: o.failedAt !== null })),
  }
}

await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', () => resolve()))
const controlAddress = controlServer.address()
if (controlAddress === null || typeof controlAddress === 'string') fail('控制面无端口')
const controlPort = controlAddress.port

await writeFile(
  ENV_FILE,
  JSON.stringify({
    hubOrigin: `http://127.0.0.1:${HUB_PORT}`,
    webOrigin: WEB_ORIGIN,
    setupTokenPath,
    setupToken,
    controlPort,
    controlToken,
  }),
  { mode: 0o600 },
)
log(`环境清单：${ENV_FILE}（Token 明文只在 0600 文件与清单中，不进 git/日志）`)
log('e2e 环境就绪，保持运行直至父进程退出')
setInterval(() => {}, 60_000) // 保活，等待 playwright webServer 结束本进程
