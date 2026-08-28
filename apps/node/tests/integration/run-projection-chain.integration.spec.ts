/**
 * P1-13 G4-04/G4-05/R1 全链路验收（04 §6.3/§6.4 的机器证据）。
 *
 * 真链路全要素，无一环 mock：
 *   Browser(ws) ⇄ 真 Hub（buildApp + listen + 真 PG + 真 OutboxWorker）
 *   ⇄ 真 Node 会话（session.ts + RunManager + RuntimeSupervisor + DshRuntimeDriver）
 *   ⇄ 真 Runtime 子进程（apps/runtime bin + DSH + replay overlay，无外部模型）。
 *
 * 覆盖：
 *   G4-04  owner/member 两个 Browser 连接的 frame diff（owner 全文 vs member
 *          缩水流），live delta 只到 owner；
 *   G4-05  owner 流上最后一条 assistant 内容先于 run.completed（flush 顺序）；
 *   R1     Hub 进程重启（Node 不动）→ Node 重连自动补发，Hub 侧 seq 连续无缺口；
 *   语料   04 §6.4 六件秘密语料在 Hub DB 与两个 Browser 帧流中都零出现，
 *          且 owner 文本呈现脱敏标记（证明是「脱了敏」，不是「没内容」）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { WebSocket } from 'ws'
import { insertProject, insertTask, Outbox, schema } from '@project311/db'
import type { Database } from '@project311/db'
import { parseClientFrame } from '@project311/protocol'
import type { ClientFrame } from '@project311/protocol'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  type Session,
  type TestApp,
} from '../../../hub/tests/helpers.js'
import { OutboxWorker } from '../../../hub/src/modules/run/index.js'
import { WsDeviceGateway } from '../../../hub/src/modules/device/index.js'
import { WorkspaceRegistry } from '../../src/workspace/registry.js'
import { SecretStore } from '../../src/secret/store.js'
import { CommandStore } from '../../src/spool/command-store.js'
import { EventStore } from '../../src/spool/event-store.js'
import { RuntimeSupervisor } from '../../src/supervisor/runtime-supervisor.js'
import { DshRuntimeDriver } from '../../src/runtime-driver.js'
import { RunManager } from '../../src/run/run-manager.js'
import { startDeviceSession } from '../../src/gateway/session.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
// 子进程 cwd 是临时 workspace（无 node_modules）：--import 必须用绝对路径，
// 与 Q3 stdio 探针同形态但 cwd 无关。
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx')
const RUNTIME_BIN = join(REPO_ROOT, 'apps/runtime/src/bin.ts')
const REPLAY_PATCH = join(REPO_ROOT, 'packages/runtime-dsh/config/replay.yml')
const FIXTURE_BASIC = join(
  REPO_ROOT,
  'packages/runtime-dsh/tests/dsh-contract/fixtures/basic/session.jsonl',
)
const FIXTURE_SECRETS = join(
  REPO_ROOT,
  'packages/runtime-dsh/tests/dsh-contract/fixtures/secrets/session.jsonl',
)

const TAKE_TIMEOUT_MS = 90_000

/** 04 §6.4 六件秘密语料：任何一件的原样出现 = Q7 失败。 */
const CORPUS = [
  'Authorization: Bearer test-secret-123',
  'DEEPSEEK_API_KEY=sk-test-abcdef',
  'npm_xxx_fake_token',
  '-----BEGIN PRIVATE KEY-----',
  '/Users/bob/private/project',
  'https://example.com/path?token=secret#fragment',
] as const

const silence = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface BrowserClient {
  readonly frames: ClientFrame[]
  take(n: number, timeoutMs?: number): Promise<ClientFrame[]>
  close(): void
}

const cleanups: Array<() => void | Promise<void>> = []
const tempDirs: string[] = []

function mktemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('P1-13 全链路（真 Hub + 真 Node + 真 Runtime/replay）', () => {
  let database: Database

  beforeAll(async () => {
    database = await createTestDatabase()
  }, 180_000)

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    delete process.env['DSH_SNAPSHOT_FILE']
    delete process.env['PROJECT311_RUNTIME_EXTRA_PATCH_FILES']
  })

  afterAll(async () => {
    await database.close()
  })

  /** 完整链路装配；返回驱动句柄。Node 侧全是真组件（与 cli.ts 同配方）。 */
  async function setupChain(
    fixture: string,
    opts: { startWorker?: boolean } = {},
  ): Promise<{
    ctx: TestApp
    alice: Session
    bob: Session
    deviceId: string
    workspaceId: string
    taskId: string
    agentId: string
    httpBase: string
    nodeStateDir: string
    workspaceDir: string
    supervisor: RuntimeSupervisor
    startWorker: () => void
    connectBrowser: (as: Session) => Promise<BrowserClient>
    closeHub: () => Promise<void>
    listenAgain: () => Promise<TestApp>
  }> {
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
    // 幂等 close：R1 会提前关一次 Hub。
    let ctxClosed = false
    cleanups.push(async () => {
      if (!ctxClosed) {
        ctxClosed = true
        await ctx.close()
      }
    })

    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })

    // Agent：provider replay（Q3 overlay 适配器），凭据槽 default。
    const agentId = randomUUID()
    const revisionId = randomUUID()
    const pluginPackId = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id: pluginPackId,
      name: `pack-${agentId.slice(0, 8)}`,
      installations: [],
      packDigest: 'a'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db
      .insert(schema.agents)
      .values({ id: agentId, name: 'replay-agent', createdBy: alice.userId })
    await database.db.insert(schema.agentProfileRevisions).values({
      id: revisionId,
      agentId,
      revision: 1,
      persona: 'You replay fixtures.',
      provider: 'replay',
      model: 'replay-model',
      credentialSlot: 'default',
      pluginPackId,
      profileDigest: 'c'.repeat(64),
      createdBy: alice.userId,
    })
    await database.db
      .update(schema.agents)
      .set({ currentRevisionId: revisionId })
      .where(eq(schema.agents.id, agentId))

    const projectId = randomUUID()
    const taskId = randomUUID()
    await insertProject(database.db, { id: projectId, name: 'chain', createdBy: alice.userId })
    await insertTask(database.db, {
      id: taskId,
      projectId,
      title: 'chain task',
      assigneeUserId: alice.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: alice.userId,
    })

    // 配对设备（HTTP 真人路径）。
    const codeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    const claimRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code: codeRes.json().data.code,
        name: 'chain-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    const { deviceId, deviceToken } = claimRes.json().data as {
      deviceId: string
      deviceToken: string
    }

    // ---- Node 侧真装配（与 cli.ts runStart 同配方；仅测试注入点不同）----
    const nodeStateDir = mktemp('p311-chain-node-state-')
    const workspaceDir = mktemp('p311-chain-ws-')
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
      driver: new DshRuntimeDriver({
        runtimeEntry: RUNTIME_BIN,
        nodeArgs: ['--import', TSX_LOADER],
      }),
      registry,
      secrets,
      stateDbPath: join(nodeStateDir, 'supervisor.sqlite'),
      capacity: 2,
      runtimeTimeoutMs: 300_000,
      // 验收缝：replay overlay 变量显式列入白名单（生产 cli 为空）。
      runtimeEnvPassthrough: ['DSH_SNAPSHOT_FILE', 'PROJECT311_RUNTIME_EXTRA_PATCH_FILES'],
      // stdout 行 → RunManager 投影管线（与 cli.ts 同配方；runManager 后构造，
      // 闭包在 spawn 回调时才被调用，TDZ 安全）。
      onStdoutLine: (runId, line) => runManager.handleStdoutLine(runId, line),
    })
    cleanups.push(async () => {
      for (const runId of supervisor.activeRunIds()) await supervisor.cancel(runId)
    })

    let sessionSend: (frame: string) => void = () => {}
    const runManager = new RunManager({
      supervisor,
      registry,
      commandStore: new CommandStore(join(nodeStateDir, 'commands.sqlite')),
      eventStore,
      send: (frame) => sessionSend(frame),
      runtimeHomeFor: (runId) => mktemp(`p311-chain-home-${runId.slice(0, 8)}-`),
      // 语料第 5 件（/Users/bob/...）依赖 homeDir 归约：固定注入，与本机真实 home 无关。
      homeDir: '/Users/bob',
      log: () => {},
    })
    const session = startDeviceSession({
      config: { hubUrl: httpBase, deviceId, deviceToken },
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
        void runManager.handleFrame(frame)
      },
      onConnected: () => runManager.onReconnect(),
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
      gateway: new WsDeviceGateway(),
    })
    let workerTimer: ReturnType<typeof setInterval> | undefined
    const startWorker = () => {
      if (workerTimer !== undefined) return
      workerTimer = setInterval(() => {
        void worker.dispatchOnce().catch(() => {})
      }, 100)
      cleanups.push(() => clearInterval(workerTimer))
    }
    if (opts.startWorker !== false) startWorker()

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

    const connectBrowser = (as: Session): Promise<BrowserClient> =>
      new Promise((resolve, reject) => {
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
          close: () => socket.close(),
        }
        socket.on('message', (data) => {
          frames.push(parseClientFrame(JSON.parse(data.toString())))
        })
        socket.once('open', () => {
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

    void httpBase
    void workspaceDir
    void runManager
    return {
      ctx,
      alice,
      bob,
      deviceId,
      nodeStateDir,
      workspaceId,
      taskId,
      agentId,
      supervisor,
      startWorker,
      connectBrowser,
      closeHub: async () => {
        if (!ctxClosed) {
          ctxClosed = true
          await ctx.close()
        }
      },
      listenAgain,
    }
  }

  function startRun(chain: {
    ctx: TestApp
    alice: Session
    taskId: string
    agentId: string
    deviceId: string
    workspaceId: string
  }): Promise<string> {
    return chain.ctx.app
      .inject({
        method: 'POST',
        url: `/api/v1/tasks/${chain.taskId}/runs`,
        headers: {
          origin: chain.ctx.origin,
          cookie: chain.alice.cookie,
          'idempotency-key': idemKey(),
        },
        payload: {
          agentId: chain.agentId,
          deviceId: chain.deviceId,
          workspaceId: chain.workspaceId,
          prompt: 'hello replay',
        },
      })
      .then((res) => {
        expect(res.statusCode).toBe(201)
        return res.json().data.id as string
      })
  }

  /** 等 Hub 侧某 run 的 run_event 出现 predicate 命中的行（轮询 PG，超时红）。 */
  async function waitForRunEvent(
    runId: string,
    predicate: (
      rows: Array<{ seq: number; type: string; audience: string; payload: unknown }>,
    ) => boolean,
    timeoutMs = TAKE_TIMEOUT_MS,
  ): Promise<Array<{ seq: number; type: string; audience: string; payload: unknown }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const rows = await database.db
        .select()
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId))
        .orderBy(schema.runEvents.seq)
      if (predicate(rows)) return rows
      if (Date.now() > deadline) {
        const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
        const outbox = await database.db.select().from(schema.dispatchOutbox)
        throw new Error(
          `run events not satisfied; have: ${JSON.stringify(rows.map((r) => [r.seq, r.audience, r.type]))}; run=${JSON.stringify({ status: run?.status, failureCode: run?.failureCode, failureSummary: run?.failureSummary })}; outbox=${JSON.stringify(outbox.map((o) => ({ type: o.type, acked: o.ackedAt !== null, attempts: o.attemptCount })))}`,
        )
      }
      await silence(100)
    }
  }

  it('G4-04/G4-05：owner 全文+直播 vs member 缩水流；flush 顺序 completed 收尾', async () => {
    const chain = await setupChain(FIXTURE_BASIC)
    const aliceWs = await chain.connectBrowser(chain.alice)
    const bobWs = await chain.connectBrowser(chain.bob)
    const runId = await startRun(chain)

    // Hub 落库到 completed（双受众各一行）。
    const rows = await waitForRunEvent(runId, (rs) =>
      rs.some((r) => r.type === 'run.completed' && r.audience === 'owner'),
    )
    const ownerRows = rows.filter((r) => r.audience === 'owner')
    const projectRows = rows.filter((r) => r.audience === 'project')

    // G4-05：owner 侧 assistant.message 全部先于 run.completed（seq 有序）。
    const completedSeq = ownerRows.find((r) => r.type === 'run.completed')?.seq ?? -1
    for (const row of ownerRows.filter((r) => r.type === 'assistant.message')) {
      expect(row.seq).toBeLessThan(completedSeq)
    }
    // owner 完整最终文本；project 行是确定性摘要（同事实，收缩呈现）。
    const ownerCompleted = ownerRows.find((r) => r.type === 'run.completed')
    expect(JSON.stringify(ownerCompleted?.payload)).toContain('Hello from replay.')
    expect(projectRows.length).toBeGreaterThan(0)
    for (const row of projectRows) expect(row.audience).toBe('project')

    // Browser 侧 frame diff：等 alice 收到 run.completed 持久帧。
    const aliceDeadline = Date.now() + TAKE_TIMEOUT_MS
    while (
      !aliceWs.frames.some(
        (f) =>
          f.kind === 'persistent' &&
          f.event.type === 'run.event' &&
          JSON.stringify(f.event.payload).includes('"run.completed"'),
      )
    ) {
      if (Date.now() > aliceDeadline) throw new Error('alice never saw run.completed')
      await silence(50)
    }
    const aliceRunEvents = aliceWs.frames.filter(
      (f) => f.kind === 'persistent' && f.event.type === 'run.event',
    )
    const bobRunEvents = bobWs.frames.filter(
      (f) => f.kind === 'persistent' && f.event.type === 'run.event',
    )
    // owner 见 owner 行（含 assistant.message 全文）；member 只见 project 行。
    expect(aliceRunEvents.some((f) => JSON.stringify(f).includes('Hello from replay.'))).toBe(true)
    expect(bobRunEvents.length).toBeGreaterThan(0)
    for (const frame of bobRunEvents) {
      expect(JSON.stringify(frame)).not.toContain('"audience":"owner"')
    }
    // 受众差异的硬核证据：assistant.message 是 owner-only 事件（03 §8）——
    // member 的帧流里一条都不出现；owner 流里必有。
    const isAssistantMessage = (f: ClientFrame) =>
      f.kind === 'persistent' &&
      f.event.type === 'run.event' &&
      JSON.stringify(f.event.payload).includes('"assistant.message"')
    expect(aliceRunEvents.some(isAssistantMessage)).toBe(true)
    expect(bobRunEvents.some(isAssistantMessage)).toBe(false)
    // live delta 只到 owner。
    const aliceLive = aliceWs.frames.filter((f) => f.kind === 'live')
    const bobLive = bobWs.frames.filter((f) => f.kind === 'live')
    expect(aliceLive.length).toBeGreaterThan(0)
    expect(bobLive).toHaveLength(0)
    expect(aliceLive.map((f) => (f.kind === 'live' ? f.delta.text : '')).join('')).toContain(
      'Hello from replay.',
    )
  }, 120_000)

  it('R1：Hub 重启（Node 不动）→ 重连自动补发，Hub 侧 seq 连续完整', async () => {
    // 确定性时序：等 Node 侧 runtime 真的在跑 → 关 Hub → 等 runtime 跑完
    // （Node 侧视角：activeRunIds 清空 = 全部事件已产出并落 spool、上行丢弃）
    // → 同端口重启 Hub → Node 自动重连 → onConnected 全量 drain 补发。
    const chain = await setupChain(FIXTURE_BASIC)
    const runId = await startRun(chain)

    const startDeadline = Date.now() + 30_000
    while (!chain.supervisor.activeRunIds().includes(runId)) {
      if (Date.now() > startDeadline) throw new Error('runtime never started on node')
      await silence(50)
    }
    await chain.closeHub()
    // 完成信号 = spool 里出现 run.completed（runtime 完成后子进程驻留等待
    // shutdown——activeRunIds 不是完成信号）。直读 spool sqlite（WAL 允许并发读）。
    const spool = new DatabaseSync(join(chain.nodeStateDir, 'events.sqlite'), { readOnly: true })
    cleanups.push(() => spool.close())
    const doneDeadline = Date.now() + 60_000
    for (;;) {
      const row = spool
        .prepare(
          "select seq from spooled_event where run_id = ? and instr(payload, 'run.completed') > 0",
        )
        .get(runId)
      if (row !== undefined) break
      if (Date.now() > doneDeadline) throw new Error('run.completed never reached node spool')
      await silence(100)
    }

    await chain.listenAgain()

    const rows = await waitForRunEvent(runId, (rs) => rs.some((r) => r.type === 'run.completed'))
    // 全量补发：seq 空间跨受众共享（每行一个 seq；03 §8）——全行集合
    // 从 1 连续无缺口，且双受众都在（dedup 幂等 = 恰好一次应用）。
    const seqs = [...new Set(rows.map((r) => r.seq))].sort((a, b) => a - b)
    expect(seqs, 'run seq space contiguous').toEqual(
      Array.from({ length: seqs.length }, (_, i) => i + 1),
    )
    expect(rows.some((r) => r.audience === 'owner')).toBe(true)
    expect(rows.some((r) => r.audience === 'project')).toBe(true)
    // 终态落地：Hub 侧 run 行转 completed（终态禁复活的正向面）。
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('completed')
  }, 120_000)

  it('秘密语料：六件语料在 Hub DB 与两个 Browser 帧流零出现，脱敏标记在', async () => {
    const chain = await setupChain(FIXTURE_SECRETS)
    const aliceWs = await chain.connectBrowser(chain.alice)
    const bobWs = await chain.connectBrowser(chain.bob)
    const runId = await startRun(chain)

    const rows = await waitForRunEvent(runId, (rs) =>
      rs.some((r) => r.type === 'run.completed' && r.audience === 'owner'),
    )
    // 等 alice 的直播帧到齐（completed 之前的 live delta）。
    await silence(500)

    // 1) Hub DB：六件语料零出现。
    const dbText = JSON.stringify(rows)
    for (const item of CORPUS) {
      expect(dbText, `DB must not contain: ${item}`).not.toContain(item)
    }
    // 2) Browser 帧流：零出现。
    for (const item of CORPUS) {
      expect(JSON.stringify(aliceWs.frames), `alice frames: ${item}`).not.toContain(item)
      expect(JSON.stringify(bobWs.frames), `bob frames: ${item}`).not.toContain(item)
    }
    // 3) 脱敏标记在（证明脱了敏而非没内容）：owner 完成行含 <redacted> 与 <home>。
    const ownerCompleted = rows.find((r) => r.type === 'run.completed' && r.audience === 'owner')
    const finalText = JSON.stringify(ownerCompleted?.payload)
    expect(finalText).toContain('<redacted>')
    expect(finalText).toContain('<home>/private/project')
    expect(finalText).toContain('https://example.com/path')
    expect(finalText).toContain('done.')
  }, 120_000)
})
