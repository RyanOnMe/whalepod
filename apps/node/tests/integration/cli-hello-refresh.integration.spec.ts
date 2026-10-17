/**
 * #352 组合根验收：本地装/重建 pack 后**设备事实列不重启 Node 就刷新**。
 *
 * 为什么必须打在组合根（#89 的同一教训，`cli-inventory.integration.spec.ts` 已立先例）：
 * 修法拆成三片——`gateway/hello-facts.ts` 的重算语义、`session.ts` 的按连接重算/刷新、
 * 以及 **cli.ts 的接线**（`refreshHelloAfterPreflight` 包住 preflight.ensure 并在会话
 * 句柄上刷新 hello）。前两片各有单测，第三片（忘了包一层）只有真 cli 走一遍才暴露。
 *
 * 真要素：真 Hub（createTestApp + 真 PG + 真 OutboxWorker 派发）+ **真 cli 子进程**
 * （`node --import tsx apps/node/src/cli.ts start`，HOME 重定向，绝不碰真实
 * ~/.whalepod-node）+ 真 preflight（`PluginPackPreflight` 的**本地命中**路径，零网络）。
 *
 * 用户路径与判据顺序（每一步都是真人会走的）：
 *   ① 配对（HTTP）→ 写 config.json；`workspace add`（真 registry）→ 起 cli；
 *   ② 等 hello 落库（设备事实列非空）——此刻本机**什么都没装**，digests 为空；
 *   ③ 本机装 pack：往 stateDir/plugin-packs/<digest>/pack.json 写有效 marker
 *      （dshCompatibility 取 hello 自报的真版本值——同一事实源，不手抄版本号）；
 *   ④ 真人 HTTP 路径建 Agent/Project/Task 并起 Run（POST /tasks/:id/runs）——Hub 派发
 *      run.start，Node 的 preflight 本地命中 → **会话内刷新 hello**；
 *   ⑤ 判据：设备事实列的 pluginPackDigests 出现该 digest；cli 进程从未退出（同一进程 =
 *      「不重启 Node」）且 **Node 侧连接建立次数恰为 1**（vi.spyOn 观测缝）——后者把
 *      「重连时重算」这条旁路排掉：不注入断线时若有重连，刷新就不一定来自会话内刷新。
 *   ⑥ 判据的另一半：该 Run 以 MODEL_CREDENTIAL_UNAVAILABLE 收场（拒绝发生在 preflight
 *      **之后**、spawn **之前**，正是判据窗口）——不真起 Runtime、不留孤儿进程；这条
 *      把「前提」从声明升级成断言，前提被推翻（比如外部环境给了凭据）即红。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Outbox, schema } from '@whalepod/db'
import type { Database } from '@whalepod/db'
import { OutboxWorker } from '../../../hub/src/modules/run/index.js'
import { WsDeviceGateway } from '../../../hub/src/modules/device/index.js'
import { nodeConnections } from '../../../hub/src/modules/device/connection-registry.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  idemKey,
  resetDatabase,
  waitForValue,
  type Session,
  type TestApp,
} from '../../../hub/tests/helpers.js'
import { WorkspaceRegistry } from '../../src/workspace/registry.js'
import { PACK_MARKER_FILENAME } from '../../src/plugin/runtime-config.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'apps/node/src/cli.ts')
const POLL_DEADLINE_MS = 30_000
const POLL_INTERVAL_MS = 250
const silence = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 本机 pack 的 digest（Hub 侧 pack 行与 Node 侧目录同名——这正是 preflight 的对接面）。 */
const PACK_DIGEST = 'c'.repeat(64)
const TREE_DIGEST = 'd'.repeat(64)

async function httpBase(app: TestApp['app']): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no listen port')
  return `http://127.0.0.1:${address.port}`
}

describe('#352 生产 cli 组合根：装 pack 后设备事实列不重启 Node 刷新', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let home: string
  let child: ChildProcess | undefined

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx)
    home = mkdtempSync(join(tmpdir(), 'wp-hello-refresh-home-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    const running = child
    child = undefined
    if (running !== undefined && running.exitCode === null && running.signalCode === null) {
      running.kill('SIGKILL')
      await Promise.race([
        new Promise<void>((resolve) => running.once('exit', () => resolve())),
        silence(5_000),
      ])
    }
    await ctx.app.close()
    rmSync(home, { recursive: true, force: true })
  })
  afterAll(async () => {
    await database.close()
  })

  it('真 cli：起 Run 触发 preflight 本地命中 → 同一进程内设备 digests 刷新', async () => {
    const base = await httpBase(ctx.app)

    // ---- ① 配对（HTTP 真人路径）+ config.json + workspace add ----
    const codeRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: codeRes.json().data.code as string,
        name: 'hello-refresh-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: process.version,
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    const { deviceId, deviceToken } = claim.json().data as {
      deviceId: string
      deviceToken: string
    }
    const configDir = join(home, '.whalepod-node')
    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ hubUrl: base, deviceId, deviceToken }, null, 2),
      { mode: 0o600 },
    )
    const workspaceDir = join(home, 'repo')
    mkdirSync(workspaceDir, { recursive: true })
    const registry = new WorkspaceRegistry(join(stateDir, 'workspace-registry.sqlite'))
    const registered = await registry.register(workspaceDir, { name: 'refresh-ws' })
    registry.close()

    // 观测缝：记 Node 连接的建立次数（同进程模块单例，只读观测，不动产品路径）。
    // 用途见 ⑤ 的判据——「刷新」必须发生在**同一条连接**上，否则「重连时重算」这条
    // 旁路会让本用例在旧实现下也绿（评审 A 的 ④ 判据收紧）。
    const attachSpy = vi.spyOn(nodeConnections, 'attach')

    // ---- Hub 侧：pack 行 + Agent（P1-18 惯例：pack 管理流不在本用例复跑，行级种子；
    // 本用例判的是 Node 侧刷新，pack 行只需一个稳定 digest：digest 即 preflight 的对接面）----
    const packId = randomUUID()
    await database.db.insert(schema.pluginPacks).values({
      id: packId,
      name: 'hello-refresh-pack',
      installations: [],
      packDigest: PACK_DIGEST,
      createdBy: alice.userId,
    })
    const agentRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        name: 'builder',
        persona: 'You replay fixtures.',
        provider: 'replay',
        model: 'replay-model',
        credentialSlot: 'default',
        pluginPackId: packId,
      },
    })
    expect(agentRes.statusCode).toBe(201)
    const agentId = (agentRes.json() as { data: { id: string } }).data.id

    // ---- ② 起真 cli，等 hello 落库 ----
    // SecretStore 支持环境变量兜底（`WHALEPOD_DSH_SECRET_<PROVIDER>_<SLOT>`，store.ts）：
    // 显式抹掉本用例的槽位，否则「凭据缺失 → Run 被拒」的前提会被外部环境悄悄推翻
    // （那样会真起 Runtime，判据窗口与收尾面都变形）。
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home }
    delete childEnv['WHALEPOD_DSH_SECRET_REPLAY_DEFAULT']
    child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, 'start', '--state-dir', stateDir],
      { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderrTail = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).split('\n').slice(-40).join('\n')
    })
    child.stdout?.resume()
    const runningChild = child

    const readDevice = async (): Promise<typeof schema.devices.$inferSelect | undefined> => {
      const [row] = await database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
      return row
    }
    // jsonb 列在 drizzle 里是 unknown（协议侧才有 schema）：判据处显式收窄成数组。
    const digestsOf = (row: typeof schema.devices.$inferSelect): string[] =>
      Array.isArray(row.pluginPackDigests) ? (row.pluginPackDigests as string[]) : []
    const describeStderr = (): string => `\ncli stderr 尾部：\n${stderrTail}`
    /** 等待失败时带上**失败时刻**的 stderr 尾部（describe 串是等待开始前求值的快照，
     *  preflight/探针的日志都发生在轮询窗口内，必须重新取一次）。 */
    const withFreshStderr = async <T>(wait: Promise<T>): Promise<T> => {
      try {
        return await wait
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}${describeStderr()}`,
        )
      }
    }

    const firstHello = await withFreshStderr(
      waitForValue(
        async () => {
          if (runningChild.exitCode !== null) {
            throw new Error(
              `cli 子进程提前退出（code=${runningChild.exitCode}）。${describeStderr()}`,
            )
          }
          const row = await readDevice()
          return row !== undefined && row.dshDistributionVersion !== null ? row : undefined
        },
        'node.hello 未在超时内落到设备事实列',
        { timeoutMs: POLL_DEADLINE_MS, intervalMs: POLL_INTERVAL_MS },
      ),
    )
    // 起手基线：本机什么都没装 ⟹ digests 空。后半段出现的 digest 只能来自刷新。
    expect(digestsOf(firstHello)).toEqual([])
    const reportedDshVersion = firstHello.dshDistributionVersion
    // 'unmanaged' ⟹ Runtime 探针（--print-dsh-version）没答上来：本用例要求真发行版
    // （Q2 先 build 再跑；见 CI 的 "Build workspace packages" 步骤）。
    expect(
      reportedDshVersion,
      `Runtime 未自报 DSH 版本（build 缺失？）——preflight 兼容闸会对任何非 core-empty pack fail-closed。${describeStderr()}`,
    ).not.toBe('unmanaged')

    // ---- ③ 本机装 pack（marker + 包树），dshCompatibility 用 hello 自报的真版本值 ----
    const packsRoot = join(stateDir, 'plugin-packs')
    const packDir = join(packsRoot, PACK_DIGEST)
    mkdirSync(packDir, { recursive: true })
    writeFileSync(
      join(packDir, PACK_MARKER_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        packDigest: PACK_DIGEST,
        packages: [
          {
            name: '@whalepod/hello-refresh-pack',
            version: '0.1.0',
            entrypoint: 'index.js',
            treeDigest: TREE_DIGEST,
            dshCompatibility: reportedDshVersion,
          },
        ],
      }),
    )
    // 包树就位（本地命中只校验存在性；内容不在本用例射程）。
    mkdirSync(join(stateDir, 'plugin-store', 'sha256', TREE_DIGEST), { recursive: true })

    // ---- ④ 真人路径：等投影就绪 → 建 Task → 起 Run（Hub 派发 run.start）----
    await withFreshStderr(
      waitForValue(
        async () => {
          const res = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/workspaces' })
          const list = res.json().data as Array<Record<string, unknown>> | undefined
          const mine = list?.find((w) => w.workspaceId === registered.id && w.available === true)
          return mine
        },
        'Hub 未在超时内看到本机 Workspace 投影（起 Run 的前置）',
        { timeoutMs: POLL_DEADLINE_MS, intervalMs: POLL_INTERVAL_MS },
      ),
    )
    const projectRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'hello-refresh' },
    })
    expect(projectRes.statusCode).toBe(201)
    const projectId = (projectRes.json() as { data: { id: string } }).data.id
    const taskRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'hello refresh task', assigneeUserId: alice.userId },
    })
    expect(taskRes.statusCode).toBe(201)
    const taskId = (taskRes.json() as { data: { id: string } }).data.id
    const acceptRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect([200, 201]).toContain(acceptRes.statusCode)
    const runRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId,
        deviceId,
        workspaceId: registered.id,
        prompt: 'hello refresh replay',
      },
    })
    expect(runRes.statusCode, `起 Run 被拒：${runRes.body}`).toBe(201)
    const runId = (runRes.json() as { data: { id: string } }).data.id

    // ④b：驱动 Outbox（生产是 250ms 循环；本测试手动挡——真正的 WS 连接注册表在
    // 同进程内，WsDeviceGateway 直达配对的那条真连接）。
    const worker = new OutboxWorker({
      outbox: new Outbox(database),
      gateway: new WsDeviceGateway(),
    })

    // ---- ⑤ 判据：设备事实列刷新，且 cli 进程从未退出（不重启 Node）----
    const refreshed = await withFreshStderr(
      waitForValue(
        async () => {
          if (runningChild.exitCode !== null) {
            throw new Error(
              `cli 子进程在处理 Run 期间退出（code=${runningChild.exitCode}）——判据不成立。`,
            )
          }
          await worker.dispatchOnce()
          const row = await readDevice()
          return row !== undefined && digestsOf(row).includes(PACK_DIGEST) ? row : undefined
        },
        '本地装 pack 后设备事实列未在不重启 Node 的情况下刷新（#352）',
        { timeoutMs: POLL_DEADLINE_MS, intervalMs: POLL_INTERVAL_MS },
      ),
    )
    expect(digestsOf(refreshed)).toEqual([PACK_DIGEST])
    // 同一进程：起手记录的就是它，判据期间也未退出（上面每拍都在查 exitCode）。
    expect(runningChild.exitCode).toBeNull()
    // 同一连接：全程只有一条（把「重连重算」这条旁路排掉——本用例不注入断线，
    // 若这里 >1，说明 cli 自己重连过，刷新就不一定来自会话内刷新这条路径）。
    expect(
      attachSpy.mock.calls.filter(([connection]) => connection.deviceId === deviceId),
      'Node 侧发生了重连——判据退化（重连时的按连接重算也能让 digests 出现）',
    ).toHaveLength(1)

    // ---- ⑥ 判据的另一半（评审 B）：Run 的拒绝命运落在凭据闸上 —— 这同时证明
    // 「preflight 之后、spawn 之前」的窗口设定成立（真起 Runtime 会留孤儿，且判据窗口变形）。
    const failedRun = await withFreshStderr(
      waitForValue(
        async () => {
          await worker.dispatchOnce()
          const res = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/runs/${runId}` })
          const run = res.json().data as
            | { status?: string; failureCode?: string | null }
            | undefined
          return run !== undefined && run.failureCode !== null && run.failureCode !== undefined
            ? run
            : undefined
        },
        'Run 未在超时内以凭据缺失被拒——本用例的前提（不真起 Runtime）不成立',
        { timeoutMs: POLL_DEADLINE_MS, intervalMs: POLL_INTERVAL_MS },
      ),
    )
    expect(failedRun.failureCode).toBe('MODEL_CREDENTIAL_UNAVAILABLE')
  }, 150_000) // 四段 waitForValue 各 30s：单段触顶时仍要走完其余段与断言，别先撞 vitest 超时（#360 同教训）
})
