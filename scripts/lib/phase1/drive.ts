/**
 * P1-18 六原语 harness —— 驱动（drive）原语。
 *
 * phase1-drive 的本体：把主链场景（Task→Run→Approval→Artifact→Reviewer）
 * 用真链路装配跑一遍，把各层观测落成证据目录；它只负责「触发 + 采集」，
 * 不下结论——判定与归因是 phase1-verify 的事（触发/判定分离，可换通道单跑）。
 *
 * 故障注入（--fault）：hub / node / runtime / browser 四个注入点各打断一层，
 * drive 照常采集——verify 必须对每次注入 FAIL 且归因到被打断的那层
 * （05 §4 P1-18 验收标准；注入点实现见 chain.ts 的故障注入面）。
 *
 * 证据目录（artifacts/evidence/，gitignore）：JSONL 均为追加写；密码、Token、
 * Cookie、原始 Runtime 帧、绝对路径不进任何文件（runtime 层只记帧型与字节
 * 长度，04 §9）；node/browser/db 侧文本均已过 Node 投影脱敏。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { schema } from '@project311/db'
import type { Database } from '@project311/db'
import { assembleChain, FIXTURE_APPROVAL, FIXTURE_BASIC, FIXTURE_SECRETS } from './chain.js'
import type { BrowserClient } from './chain.js'
import { Phase1Recorder, buildIndex, redactText, type FaultKind } from './events.js'
import { createTestDatabase } from '../../../apps/hub/tests/helpers.js'
import { startEphemeralPostgres } from '../../lib/ephemeral-postgres.mts'

export type Phase1Scenario = 'minimal' | 'standard' | 'secrets'

export const SCENARIOS: readonly Phase1Scenario[] = ['minimal', 'standard', 'secrets']

const SCENARIO_FIXTURES: Record<Phase1Scenario, string> = {
  minimal: FIXTURE_BASIC,
  standard: FIXTURE_APPROVAL,
  secrets: FIXTURE_SECRETS,
}

/** 标准（绿）路径各步等待上限；fault 注入后的收尾等待用 stallWindowMs。 */
const STEP_TIMEOUT_MS = 120_000
const DEFAULT_STALL_WINDOW_MS = 20_000
const POLL_MS = 100

export interface DriveOptions {
  scenario: Phase1Scenario
  fault: FaultKind
  /** 证据目录（本 attempt 独占）。 */
  attemptDir: string
  /** 注入数据库（集成测试共享 with-test-postgres 的 PG）；缺省自起一次性容器。 */
  database?: Database
  /** fault 注入后的收尾观察窗口。 */
  stallWindowMs?: number
}

export interface DriveResult {
  attemptDir: string
  traceId: string
  scenario: Phase1Scenario
  fault: FaultKind
  runIds: string[]
  /** drive 完成了采集（≠ 链路判定；判定看 verify）。 */
  captured: boolean
  error?: string
}

export interface DriveMeta {
  traceId: string
  attemptId: string
  scenario: Phase1Scenario
  fault: FaultKind
  startedAt: string
  endedAt: string
  captured: boolean
  runIds: string[]
  gitCommit: string
  dshVersion: string
  protocolVersion: number
  platform: string
  nodeVersion: string
  error?: string
}

/** git commit（短 hash）；失败给 'unknown'（不阻塞取证）。 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

function dshVersion(): string {
  try {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'dsh.lock.json'), 'utf8')) as {
      packages: Record<string, { version: string }>
    }
    const dsh = lock.packages['@deepseek-ai/dsh-base']
    return dsh?.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

interface RunRowLike {
  id: string
  status: string
  failureCode: string | null
  finishedAt: Date | null
}

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'lost'])

export class DriveError extends Error {}

/**
 * 跑一个场景并把证据写进 attemptDir。exit 语义由 CLI 层定：
 * captured=true → 0（判定是 verify 的事）；装配/驱动建立失败 → 抛 DriveError。
 */
export async function drivePhase1(options: DriveOptions): Promise<DriveResult> {
  const { scenario, fault, attemptDir } = options
  const attemptId = `${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..+$/, 'Z')}-${randomUUID().slice(0, 8)}`
  const traceId = `phase1-${scenario}-${attemptId}`
  const startedAt = new Date().toISOString()
  const runIds: string[] = []
  const stallWindowMs = options.stallWindowMs ?? DEFAULT_STALL_WINDOW_MS

  // 自管 PG（CLI 形态）与注入 PG（测试形态）统一到这里；注入的 DB 归调用方关。
  let ownedPostgres: Awaited<ReturnType<typeof startEphemeralPostgres>> | undefined
  let database: Database
  if (options.database !== undefined) {
    database = options.database
  } else {
    const postgres = await startEphemeralPostgres()
    ownedPostgres = postgres
    const previousUrl = process.env['DATABASE_URL']
    process.env['DATABASE_URL'] = postgres.databaseUrl
    try {
      database = await createTestDatabase()
    } catch (error) {
      await postgres.stop()
      if (previousUrl === undefined) delete process.env['DATABASE_URL']
      else process.env['DATABASE_URL'] = previousUrl
      throw error
    }
  }

  // fault=runtime：Runtime 入口换成必崩 stub（node 入口，exit 7，零协议帧）。
  // stub 是工具不是证据：放临时目录并在收尾删除，绝不进证据目录。
  let runtimeStubDir: string | undefined
  const runtimeEntryOverride = (): string | undefined => {
    if (fault !== 'runtime') return undefined
    runtimeStubDir = mkdtempSync(join(tmpdir(), 'p311-phase1-runtime-stub-'))
    const stub = join(runtimeStubDir, 'runtime-entry.mjs')
    writeFileSync(stub, 'process.exit(7)\n')
    return stub
  }

  const recorder = new Phase1Recorder(attemptDir, traceId)
  recorder.event('harness.drive', 'drive.started', { scenario, fault })
  let captured = true
  let driveError: string | undefined
  // hub 探活：真 TCP loopback fetch（inject 绕过 listener，不能用来判 Hub 存亡）。
  let probing = true
  const probeHub = async (httpBase: string): Promise<void> => {
    try {
      const res = await fetch(`${httpBase}/api/v1/auth/session`, {
        method: 'GET',
        signal: AbortSignal.timeout(2_000),
      })
      recorder.fact('hub.http', 'hub.probe', { ok: true, status: res.status })
    } catch (error) {
      recorder.fact('hub.http', 'hub.probe', {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  let assembly: Awaited<ReturnType<typeof assembleChain>> | undefined
  try {
    const runtimeStub = fault === 'runtime' ? runtimeEntryOverride() : undefined
    assembly = await assembleChain({
      database,
      fixture: SCENARIO_FIXTURES[scenario],
      recorder,
      agents: scenario === 'standard' ? 2 : 1,
      ...(runtimeStub === undefined ? {} : { runtimeEntry: runtimeStub, nodeArgs: [] }),
    })
    const asm = assembly
    const probeTimer = setInterval(() => {
      if (probing) void probeHub(asm.httpBase)
    }, 250)
    try {
      // 双 Browser 连接（两个独立会话；P1-19 之前的 Browser 层真身）。
      const browsers = {
        alice: await asm.connectBrowser(asm.alice),
        bob: await asm.connectBrowser(asm.bob),
      }

      // fault=node：在派发前停掉 Node 会话（spool 存活，上行出口关闭）。
      if (fault === 'node') asm.stopNodeSession()

      const runId1 = await startRun(asm, {
        agentId: asm.builderAgentId,
        prompt: 'hello replay',
      })
      runIds.push(runId1)
      recorder.event('harness.drive', 'milestone', { name: 'run1.created', runId: runId1 })

      if (fault === 'browser') asm.closeBrowsers()

      if (fault === 'hub') {
        // 确定性触发：Runtime 真起来之后再断 Hub（Node 不动）——事件滞留 Node 侧。
        await waitUntil(
          () => asm.supervisor.activeRunIds().includes(runId1),
          30_000,
          'runtime never started on node (fault=hub trigger)',
        )
        await asm.breakHub()
        recorder.event('harness.drive', 'milestone', { name: 'fault.triggered', fault })
      }

      if (fault === 'none' && scenario === 'standard') {
        // Approval 腿：等 pending 卡出现 → owner 经 HTTP 决策。
        const approval = await waitForPendingApproval(asm, runId1, STEP_TIMEOUT_MS)
        const decided = await decideApproval(asm, approval.id, 'allowed_once')
        recorder.event('hub.http', 'http.approval.decided', {
          approvalId: approval.id,
          decision: decided,
        })
      }

      // 归因面等待窗：只有 hub/node 断层时链路真的会停滞（stall 窗收口）；
      // browser/runtime 断层下链路其余部分健康，必须等正常终态——否则等待窗
      // 先于终态收口会把 fault=browser 误判成 Node（评审修正 2）。
      const endWaitMs = fault === 'hub' || fault === 'node' ? stallWindowMs : STEP_TIMEOUT_MS
      await waitForRunEnd(asm, runId1, endWaitMs)
      // Browser 沉降：Hub 终态落库与 WS 扇出之间有毫秒级时差，采集必须在
      // 扇出帧落袋后再收口（否则把扇出时差误判成断层）。Hub 已断/连接已断时
      // 帧不可能再来，短等即可。
      const settleMs = fault === 'browser' || fault === 'hub' ? 2_000 : 30_000
      await settleBrowsers(asm, browsers, runId1, settleMs)

      if (fault === 'none' && scenario === 'standard') {
        // Artifact 腿：candidate 落库 → owner 发布 → Reviewer Run 消费。
        const artifact = await waitForCandidateArtifact(asm, runId1, STEP_TIMEOUT_MS)
        await publishArtifact(asm, artifact.id)
        recorder.event('hub.http', 'http.artifact.published', { artifactId: artifact.id })
        const runId2 = await startRun(asm, {
          agentId: asm.reviewerAgentId ?? asm.builderAgentId,
          prompt: 'review the published report',
        })
        runIds.push(runId2)
        recorder.event('harness.drive', 'milestone', { name: 'run2.created', runId: runId2 })
        // Reviewer Run 复用同一 replay fixture（会再次触发 publish_artifact ask）：
        // 同一真人决策路径再走一遍，Reviewer 才能继续执行到终态。
        const reviewerApproval = await waitForPendingApproval(asm, runId2, STEP_TIMEOUT_MS)
        await decideApproval(asm, reviewerApproval.id, 'allowed_once')
        recorder.event('hub.http', 'http.approval.decided', {
          approvalId: reviewerApproval.id,
          decision: 'allowed_once',
        })
        await waitForRunEnd(asm, runId2, STEP_TIMEOUT_MS)
        await settleBrowsers(asm, browsers, runId2, 30_000)
      }
    } finally {
      probing = false
      clearInterval(probeTimer)
    }
    recorder.event('harness.drive', 'drive.capture-end', { runIds })
  } catch (error) {
    captured = false
    // 错误消息可能内嵌本机绝对路径（spawn/ENOENT/HTTP 体）：源头归约一次，
    // drive.error 事件、meta.json 与 CLI 输出全部走归约后的文本（#73）。
    driveError = redactText(error instanceof Error ? error.message : String(error))
    recorder.event('harness.drive', 'drive.error', { error: driveError })
  } finally {
    // 证据收尾：DB 快照、跨层索引、meta（cleanup 前写，时序事实不被收尾污染）。
    if (assembly !== undefined) {
      try {
        await writeDbSnapshot(assembly, runIds)
      } catch (error) {
        recorder.event('harness.drive', 'snapshot.error', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const dbRunEvents = await database.db
        .select({ runId: schema.runEvents.runId, receivedAt: schema.runEvents.receivedAt })
        .from(schema.runEvents)
      writeFileSync(
        join(attemptDir, 'index.json'),
        `${JSON.stringify(
          buildIndex({
            recorder,
            scenario,
            fault,
            dbRunEvents: dbRunEvents.map((row) => ({
              runId: row.runId,
              ts: row.receivedAt?.toISOString(),
            })),
          }),
          null,
          2,
        )}\n`,
      )
      const meta: DriveMeta = {
        traceId,
        attemptId,
        scenario,
        fault,
        startedAt,
        endedAt: new Date().toISOString(),
        captured,
        runIds,
        gitCommit: gitCommit(),
        dshVersion: dshVersion(),
        protocolVersion: 1,
        platform: `${process.platform}-${process.arch}`,
        nodeVersion: process.version,
        ...(driveError === undefined ? {} : { error: driveError }),
      }
      writeFileSync(join(attemptDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
      await assembly.cleanup()
    } else {
      // 装配都没建起来：也要留 meta（最少证据），便于排查。
      const meta: DriveMeta = {
        traceId,
        attemptId,
        scenario,
        fault,
        startedAt,
        endedAt: new Date().toISOString(),
        captured,
        runIds,
        gitCommit: gitCommit(),
        dshVersion: dshVersion(),
        protocolVersion: 1,
        platform: `${process.platform}-${process.arch}`,
        nodeVersion: process.version,
        ...(driveError === undefined ? {} : { error: driveError }),
      }
      writeFileSync(join(attemptDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    }
    if (runtimeStubDir !== undefined) rmSync(runtimeStubDir, { recursive: true, force: true })
    if (ownedPostgres !== undefined) {
      await database.close()
      await ownedPostgres.stop()
      delete process.env['DATABASE_URL']
    }
  }
  return {
    attemptDir,
    traceId,
    scenario,
    fault,
    runIds,
    captured,
    ...(driveError === undefined ? {} : { error: driveError }),
  }
}

// ---------- 场景步骤（全走真人 HTTP 路径 + DB 事实轮询） ----------

async function startRun(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  run: { agentId: string; prompt: string },
): Promise<string> {
  const res = await api(assembly, assembly.alice, {
    method: 'POST',
    url: `/api/v1/tasks/${assembly.taskId}/runs`,
    payload: {
      agentId: run.agentId,
      deviceId: assembly.deviceId,
      workspaceId: assembly.workspaceId,
      prompt: run.prompt,
    },
  })
  if (res.status !== 201) {
    throw new DriveError(`POST /tasks/:id/runs 失败：${res.status} ${res.body}`)
  }
  const body = JSON.parse(res.body) as { data: { id: string } }
  return body.data.id
}

async function waitForPendingApproval(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  runId: string,
  timeoutMs: number,
): Promise<{ id: string; toolName: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await assembly.database.db
      .select({ id: schema.approvals.id, toolName: schema.approvals.toolName })
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, runId))
    if (row !== undefined) return row
    if (Date.now() > deadline) {
      throw new DriveError('approval never became pending within timeout')
    }
    await sleep(POLL_MS)
  }
}

async function decideApproval(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  approvalId: string,
  decision: 'allowed_once' | 'rejected',
): Promise<string> {
  const res = await api(assembly, assembly.alice, {
    method: 'POST',
    url: `/api/v1/approvals/${approvalId}/decisions`,
    payload: { decision },
  })
  if (res.status !== 200) {
    throw new DriveError(`POST /approvals/:id/decisions 失败：${res.status} ${res.body}`)
  }
  return decision
}

async function waitForCandidateArtifact(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  runId: string,
  timeoutMs: number,
): Promise<{ id: string; sha256: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await assembly.database.db
      .select({ id: schema.artifacts.id, sha256: schema.artifacts.sha256 })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, runId))
    if (row !== undefined) return row
    if (Date.now() > deadline) {
      throw new DriveError('artifact candidate never landed within timeout')
    }
    await sleep(POLL_MS)
  }
}

async function publishArtifact(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  artifactId: string,
): Promise<void> {
  const res = await api(assembly, assembly.alice, {
    method: 'POST',
    url: `/api/v1/artifacts/${artifactId}/publish`,
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new DriveError(`POST /artifacts/:id/publish 失败：${res.status} ${res.body}`)
  }
}

/** 等 Run 到终态；fault 场景等不到就到 stall 窗口为止（capture 完整即可）。 */
async function waitForRunEnd(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  runId: string,
  timeoutMs: number,
): Promise<RunRowLike | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await assembly.database.db
      .select({
        id: schema.runs.id,
        status: schema.runs.status,
        failureCode: schema.runs.failureCode,
        finishedAt: schema.runs.finishedAt,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    if (row !== undefined && TERMINAL_RUN_STATES.has(row.status)) {
      assembly.recorder.event('hub.db', 'run.terminal', {
        runId,
        status: row.status,
        failureCode: row.failureCode,
      })
      return row
    }
    if (Date.now() > deadline) {
      assembly.recorder.event('harness.drive', 'drive.stall', {
        runId,
        waitedMs: timeoutMs,
        lastStatus: row?.status ?? 'absent',
      })
      return row
    }
    await sleep(POLL_MS)
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new DriveError(message)
    await sleep(50)
  }
}

/** 真 HTTP（不走 inject）：场景步骤统一入口，留请求/响应事实（无头无凭据）。 */
async function api(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  session: { cookie: string },
  opts: { method: 'GET' | 'POST'; url: string; payload?: unknown },
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${assembly.httpBase}/api/v1${opts.url.replace(/^\/api\/v1/, '')}`, {
    method: opts.method,
    headers: {
      origin: assembly.ctx.origin,
      cookie: session.cookie,
      'idempotency-key': randomUUID(),
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.payload !== undefined ? { body: JSON.stringify(opts.payload) } : {}),
    signal: AbortSignal.timeout(30_000),
  })
  assembly.recorder.event('hub.http', 'http.request', {
    method: opts.method,
    url: opts.url,
    status: res.status,
  })
  return { status: res.status, body: await res.text() }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Browser 沉降：等两个 Browser 连接收齐该 run 的 run.completed 扇出帧（或
 * 超时——沉降不是判定，等不到照常采集，由 verify 归因）。fault=browser 时
 * 连接已被注入关闭，短等即可（帧不会再来）。
 */
async function settleBrowsers(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  browsers: { alice: BrowserClient; bob: BrowserClient },
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const hasCompleted = (client: BrowserClient): boolean =>
    client.frames.some(
      (f) =>
        f.kind === 'persistent' &&
        f.event.type === 'run.event' &&
        JSON.stringify(f.event.payload).includes('"run.completed"') &&
        JSON.stringify(f.event.payload).includes(runId),
    )
  for (;;) {
    if (hasCompleted(browsers.alice) && hasCompleted(browsers.bob)) {
      assembly.recorder.event('harness.drive', 'milestone', { name: 'browsers.settled', runId })
      return
    }
    if (Date.now() > deadline) {
      assembly.recorder.event('harness.drive', 'browsers.settle-timeout', { runId, timeoutMs })
      return
    }
    await sleep(200)
  }
}

// ---------- 证据收尾 ----------

/** DB 快照：显式列清单——Token hash、Cookie、凭据列一律不进快照。 */
async function writeDbSnapshot(
  assembly: Awaited<ReturnType<typeof assembleChain>>,
  runIds: string[],
): Promise<void> {
  const db = assembly.database.db
  const runs = await db
    .select({
      id: schema.runs.id,
      taskId: schema.runs.taskId,
      ownerUserId: schema.runs.ownerUserId,
      agentId: schema.runs.agentId,
      profileRevisionId: schema.runs.profileRevisionId,
      deviceId: schema.runs.deviceId,
      workspaceId: schema.runs.workspaceId,
      status: schema.runs.status,
      failureCode: schema.runs.failureCode,
      failureSummary: schema.runs.failureSummary,
      rerunOfRunId: schema.runs.rerunOfRunId,
      profileDigest: schema.runs.profileDigest,
      pluginPackDigest: schema.runs.pluginPackDigest,
      createdAt: schema.runs.createdAt,
      startedAt: schema.runs.startedAt,
      finishedAt: schema.runs.finishedAt,
    })
    .from(schema.runs)
  const runEvents = await db
    .select({
      runId: schema.runEvents.runId,
      seq: schema.runEvents.seq,
      type: schema.runEvents.type,
      audience: schema.runEvents.audience,
      payload: schema.runEvents.payload,
      occurredAt: schema.runEvents.occurredAt,
    })
    .from(schema.runEvents)
    .orderBy(schema.runEvents.runId, schema.runEvents.seq)
  const approvals = await db
    .select({
      id: schema.approvals.id,
      runId: schema.approvals.runId,
      callId: schema.approvals.callId,
      toolName: schema.approvals.toolName,
      reason: schema.approvals.reason,
      preview: schema.approvals.preview,
      status: schema.approvals.status,
      requestedAt: schema.approvals.requestedAt,
      decidedBy: schema.approvals.decidedBy,
      decidedAt: schema.approvals.decidedAt,
    })
    .from(schema.approvals)
  const artifacts = await db
    .select({
      id: schema.artifacts.id,
      taskId: schema.artifacts.taskId,
      runId: schema.artifacts.runId,
      ownerUserId: schema.artifacts.ownerUserId,
      title: schema.artifacts.title,
      mediaType: schema.artifacts.mediaType,
      byteSize: schema.artifacts.byteSize,
      sha256: schema.artifacts.sha256,
      storageKey: schema.artifacts.storageKey,
      sourceRelativePath: schema.artifacts.sourceRelativePath,
      status: schema.artifacts.status,
      createdAt: schema.artifacts.createdAt,
      publishedAt: schema.artifacts.publishedAt,
    })
    .from(schema.artifacts)
  const outbox = await db
    .select({
      id: schema.dispatchOutbox.id,
      deviceId: schema.dispatchOutbox.deviceId,
      type: schema.dispatchOutbox.type,
      payload: schema.dispatchOutbox.payload,
      attempts: schema.dispatchOutbox.attemptCount,
      availableAt: schema.dispatchOutbox.nextAttemptAt,
      ackedAt: schema.dispatchOutbox.ackedAt,
      failedAt: schema.dispatchOutbox.failedAt,
    })
    .from(schema.dispatchOutbox)
  const devices = await db
    .select({
      id: schema.devices.id,
      name: schema.devices.name,
      platform: schema.devices.platform,
      architecture: schema.devices.architecture,
    })
    .from(schema.devices)
  // blob 存在性（内容寻址；不取内容）。
  const artifactStoreDir = assembly.ctx.config.artifactStoreDir
  const artifactBlobs = artifacts.map((a) => ({
    artifactId: a.id,
    blobPresent: existsSync(join(artifactStoreDir, a.storageKey)),
  }))
  writeFileSync(
    join(assembly.recorder.dir, 'db-snapshot.json'),
    `${JSON.stringify({ runIds, runs, runEvents, approvals, artifacts, artifactBlobs, outbox, devices }, null, 2)}\n`,
  )
}
