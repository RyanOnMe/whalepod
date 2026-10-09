/**
 * Q8 短档判定库（#24/#109 裁决落地）。
 *
 * 定位（#109 裁决）：本门是**劣化检测短档**——负载窗内 p95 + RSS 斜率；
 * 04 §8 的 30min 空闲 RSS / 50Run 泄漏长档不在此（挂 release 手动档，
 * 原口径在 04 保留为「长档未覆盖」，不许悄悄蒸发）。
 *
 * 阈值全部抄 04 §8 原文（传播 <500ms / ingest <100ms），环境判据 =
 * 「4 CPU、8 GiB RAM、PostgreSQL 同机、Linux Docker」（04:222）——开发机
 * 数字**不得充当发布判据**：环境不合格 ⟹ 非零退出，绝无 SKIP 报绿
 * （反面教材是 secret-scan 的 SKIP+exit 0，见 #109）。
 */

export const PROPAGATION_P95_MAX_MS = 500
export const INGEST_P95_MAX_MS = 100
/** p95 最低样本量：30 是统计下限，短档实跑远超此数。 */
export const MIN_SAMPLES = 30
/**
 * 「无持续内存增长」的机检阈值（**负载后空闲段**斜率 < 1 MiB/min + 全程净增
 * < 96 MiB）。设计账（60s 预演实测后改的，不是拍脑袋）：负载窗内 RSS 斜率
 * 量的是分配速率+V8 堆扩张（实测 34MiB/min 纯伪影，RSS 分配后不回落），
 * 对它设严界只能把门设烂；泄漏的真代理是**空闲段仍在涨**——04 §8 用
 * "空闲 30 分钟"是同一逻辑，短档把窗缩到负载 60s + 空闲 30s，口径变更
 * 在 acceptance 文档有账（04 长档原口径保留为未覆盖）。
 */
export const IDLE_RSS_SLOPE_MAX_MIB_PER_MIN = 1
export const RSS_NET_GROWTH_MAX_MIB = 96 // 口径=空闲窗首尾差（非全程累计），台阶式扩张兜底
/** 环境判据（04:222 的机器可检形态）。 */
export const REQUIRED_CPUS = 4
export const REQUIRED_MEM_GIB = 8

export interface EnvFacts {
  platform: string
  cpus: number
  totalMemGiB: number
  docker: boolean
  /**
   * 是否跑在**共享 CPU 的 CI runner** 上（`GITHUB_ACTIONS=true`）。
   *
   * 为什么要单独标（2026-10-09，tag v0.1.0-alpha.5 取证实测）：GitHub runner 已从
   * 2 vCPU 升到 **4 vCPU / 16 GiB**——名义规格从此**达** 04 §8，环境闸于是把它当
   * 判据环境，一次 ingest p95=116.4ms 被判成「权威 FAIL」。但同一份度量在合格环境是
   * 14.9ms、在空闲 M4 本机是 24.8ms，而被 250ms 轮询节拍压住的传播 p95 三者几乎一样
   * （256.2 / 262.4 / 290.9）——被共享掉的只是**逐帧处理延迟**。这不是代码回归的形状，
   * 是共享 vCPU 的形状：名义达标 ≠ 可作判据（旧 runner 因规格不达标反而走了保守口径）。
   */
  sharedCi: boolean
  /**
   * 取值的**约束来源**（#114）：`os` = 进程视角（v8 沙箱外是宿主值），
   * `cgroup` = 容器配额更小、按配额判。写进报告是为了让「为什么这个环境被拒/放行」
   * 可复核——只看数字看不出它是不是被配额压过。
   */
  cpuSource: 'os' | 'cgroup'
  memSource: 'os' | 'cgroup'
}

export function assessEnvironment(f: EnvFacts): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (f.platform !== 'linux')
    reasons.push(`platform=${f.platform}（04 §8 判据环境为 Linux Docker）`)
  if (f.sharedCi)
    reasons.push(
      '共享 CI runner（CPU 是共享的：同一份度量里 ingest 是判据环境的 4.7–7.8x，' +
        '而节拍压住的传播几乎不变——名义规格达标也不作权威判，见 load-performance-acceptance 尺子账其六）',
    )
  if (f.cpus < REQUIRED_CPUS) reasons.push(`cpus=${f.cpus} < ${REQUIRED_CPUS}`)
  if (f.totalMemGiB < REQUIRED_MEM_GIB)
    reasons.push(`mem=${f.totalMemGiB.toFixed(1)}GiB < ${REQUIRED_MEM_GIB}GiB`)
  if (!f.docker) reasons.push('docker 不可用（PostgreSQL 同机容器是判据环境的一部分）')
  return { eligible: reasons.length === 0, reasons }
}

/**
 * cgroup 配额读取（#114 / #110 一审 B2）：`os.cpus()/totalmem()` 是**过程视角**——
 * 在配额限死的容器里会虚报宿主值，于是「假 eligible」方向存在（判据环境被骗过）。
 * 真值取 `/sys/fs/cgroup` 的配额与 os 值的较小者；读不到（非 Linux / v1 无配额 /
 * 值为哨兵 'max'）就退回 os 值，并在 EnvFacts 里标出来源。
 *
 * reader 注入是为了红测：模拟 cgroup 文件内容，不必真在容器里。
 */
export type ReadTextFile = (path: string) => string | undefined

export const CGROUP_PATHS = {
  v2CpuMax: '/sys/fs/cgroup/cpu.max',
  v2MemoryMax: '/sys/fs/cgroup/memory.max',
  v1CpuQuota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
  v1CpuPeriod: '/sys/fs/cgroup/cpu/cpu.cfs_period_us',
  v1MemoryLimit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
} as const

/** v1 的「无限制」是一个巨大哨兵值；≥ 1 TiB 一律视为无配额。 */
const V1_UNLIMITED_BYTES = 1024 ** 4

export interface CgroupQuota {
  cpus?: number
  memGiB?: number
}

export function readCgroupQuota(readText: ReadTextFile): CgroupQuota {
  const quota: CgroupQuota = {}
  // v2：cpu.max = "<quota|max> <period>"（微秒）。
  const cpuMax = readText(CGROUP_PATHS.v2CpuMax)?.trim()
  if (cpuMax !== undefined && cpuMax !== '') {
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/)
    const raw = Number(quotaRaw)
    const period = Number(periodRaw)
    if (
      quotaRaw !== 'max' &&
      Number.isFinite(raw) &&
      raw > 0 &&
      Number.isFinite(period) &&
      period > 0
    ) {
      quota.cpus = raw / period
    }
  }
  if (quota.cpus === undefined) {
    const raw = Number(readText(CGROUP_PATHS.v1CpuQuota)?.trim())
    const period = Number(readText(CGROUP_PATHS.v1CpuPeriod)?.trim())
    // v1 无限制写作 -1。
    if (Number.isFinite(raw) && raw > 0 && Number.isFinite(period) && period > 0) {
      quota.cpus = raw / period
    }
  }
  const memMax = readText(CGROUP_PATHS.v2MemoryMax)?.trim()
  if (memMax !== undefined && memMax !== '' && memMax !== 'max') {
    const bytes = Number(memMax)
    if (Number.isFinite(bytes) && bytes > 0) quota.memGiB = bytes / 1024 ** 3
  } else if (memMax === undefined || memMax === '') {
    const bytes = Number(readText(CGROUP_PATHS.v1MemoryLimit)?.trim())
    if (Number.isFinite(bytes) && bytes > 0 && bytes < V1_UNLIMITED_BYTES) {
      quota.memGiB = bytes / 1024 ** 3
    }
  }
  return quota
}

/** 最近秩法取真实样本点（不插值——判据要能对得上原始数据）。 */
export function p95(samples: number[]): { value: number; n: number } {
  if (samples.length < MIN_SAMPLES) {
    throw new Error(
      `样本不足：p95 需 ≥${MIN_SAMPLES}，实得 ${samples.length}（缺数据必须失败，不得外推）`,
    )
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length) - 1
  return { value: sorted[rank] ?? sorted[sorted.length - 1]!, n: sorted.length }
}

export interface XY {
  x: number
  y: number
}

/** 最小二乘斜率（MiB/min 换算在调用方）。 */
export function regressionSlope(points: XY[]): { slope: number; n: number } {
  if (points.length < 10) throw new Error(`采样不足：斜率需 ≥10 点，实得 ${points.length}`)
  const n = points.length
  const sx = points.reduce((a, p) => a + p.x, 0)
  const sy = points.reduce((a, p) => a + p.y, 0)
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0)
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0)
  const denom = n * sxx - sx * sx
  if (denom === 0) throw new Error('采样 x 全同，斜率不可判')
  return { slope: (n * sxy - sx * sy) / denom, n }
}

export interface LoadSampleInput {
  /** Team Event 传播延迟样本（ms，浏览器可见帧口径，t0=上行发出）。 */
  propagation: number[]
  /** Run Event ingest 延迟样本（ms，发出→ack，合成恒速流）。 */
  ingest: number[]
  /** **空闲段** RSS 采样（负载结束后采样 30s，x=ms 相对起点，y=bytes）；
   *  少于 10 点直接红（缺数据不判）。净增按首尾差。 */
  idleRssSamples: XY[]
  /** 被 4009/resync 踢掉的连接数——非零即 FAIL（缺样不得静默缩样）。 */
  droppedConnections?: number
  /** 真实 replay Run 活跃期的 live ingest 样本数（旁证产品链路真跑过）。 */
  liveSamples?: number
}

export interface LoadVerdict {
  verdict: 'PASS' | 'FAIL'
  failures: string[]
  metrics: {
    propagationP95Ms: number
    ingestP95Ms: number
    idleRssSlopeMiBPerMin: number
    rssNetGrowthMiB: number
    propagationN: number
    ingestN: number
  }
}

export function verdictLoadSample(input: LoadSampleInput): LoadVerdict {
  const failures: string[] = []
  const prop = p95(input.propagation)
  const ing = p95(input.ingest)
  const idle = regressionSlope(
    input.idleRssSamples.map((p) => ({ x: p.x / 60_000, y: p.y / (1024 * 1024) })),
  )
  const netGrowthMiB =
    (input.idleRssSamples[input.idleRssSamples.length - 1]!.y - input.idleRssSamples[0]!.y) /
    (1024 * 1024)
  if (prop.value >= PROPAGATION_P95_MAX_MS)
    failures.push(`传播 p95=${prop.value.toFixed(1)}ms ≥ ${PROPAGATION_P95_MAX_MS}ms 界`)
  if (ing.value >= INGEST_P95_MAX_MS)
    failures.push(`ingest p95=${ing.value.toFixed(1)}ms ≥ ${INGEST_P95_MAX_MS}ms 界`)
  if (idle.slope >= IDLE_RSS_SLOPE_MAX_MIB_PER_MIN)
    failures.push(
      `空闲段 RSS 斜率=${idle.slope.toFixed(2)}MiB/min ≥ ${IDLE_RSS_SLOPE_MAX_MIB_PER_MIN}（泄漏的空闲代理：不产事件还在涨）`,
    )
  if (netGrowthMiB > RSS_NET_GROWTH_MAX_MIB)
    failures.push(
      `空闲窗 RSS 净增=${netGrowthMiB.toFixed(1)}MiB > ${RSS_NET_GROWTH_MAX_MIB}（斜率平缓也兜不住的台阶式扩张）`,
    )
  if ((input.droppedConnections ?? 0) > 0)
    failures.push(
      `${input.droppedConnections} 条浏览器连接被 4009/resync 关闭（样本缺失=判据不成立）`,
    )
  if ((input.liveSamples ?? 0) <= 0)
    failures.push('无任何真实 replay Run 活跃期的 live ingest 样本——合成流不能独自作证产品链路')
  return {
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
    metrics: {
      propagationP95Ms: prop.value,
      ingestP95Ms: ing.value,
      idleRssSlopeMiBPerMin: idle.slope,
      rssNetGrowthMiB: netGrowthMiB,
      propagationN: prop.n,
      ingestN: ing.n,
    },
  }
}

// ---------- 执行器（跑在环境闸之后；判定数学在上方纯函数） ----------
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { cpus, totalmem, platform } from 'node:os'
import { WebSocket } from 'ws'
import { assembleChain } from './chain.js'

export function readEnvFacts(readText: ReadTextFile = defaultReadText): EnvFacts {
  const docker =
    spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status ===
    0
  const osCpus = cpus().length
  const osMemGiB = totalmem() / 1024 ** 3
  const quota = readCgroupQuota(readText)
  // 取较小者：容器配额只会让环境**更小**，不可能比宿主大（#114）。
  const useCgroupCpu = quota.cpus !== undefined && quota.cpus < osCpus
  const useCgroupMem = quota.memGiB !== undefined && quota.memGiB < osMemGiB
  return {
    platform: platform(),
    cpus: useCgroupCpu ? Math.round(quota.cpus! * 100) / 100 : osCpus,
    totalMemGiB: useCgroupMem ? quota.memGiB! : osMemGiB,
    docker,
    sharedCi: process.env.GITHUB_ACTIONS === 'true',
    cpuSource: useCgroupCpu ? 'cgroup' : 'os',
    memSource: useCgroupMem ? 'cgroup' : 'os',
  }
}

/** 默认 reader：读不到（无权限/不存在）一律 undefined，不抛。 */
function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 上行帧信封：与 hub-socket.ts:171-184 同形（形状错了 ack 就不来，无漂移风险）。 */
function runEventFrameJson(runId: string, seq: number): { text: string; key: string } {
  const iso = new Date().toISOString()
  return {
    text: JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: iso,
      type: 'run.event',
      payload: {
        runId,
        seq,
        occurredAt: iso,
        audience: 'owner',
        event: { type: 'run.phase', phase: 'tool' },
      },
    }),
    key: `${runId}:${seq}`,
  }
}

export interface LoadProfileOptions {
  durationMs: number
  streams: number
  ratePerStreamPerSec: number
  browserConnections: number
}

export async function runLoadProfile(
  opts: LoadProfileOptions,
): Promise<LoadVerdict & { report: Record<string, unknown> }> {
  const { startEphemeralPostgres } = await import('../ephemeral-postgres.mts')
  const postgres = await startEphemeralPostgres()
  const propagation: number[] = []
  const ingest: number[] = []
  const rssSamples: XY[] = []
  let dropped = 0
  try {
    const { createDatabase, applyMigrations } = await import('@whalepod/db')
    process.env.DATABASE_URL = postgres.databaseUrl // 与 drive.ts 同规：不留 env 依赖的暗雷
    const database = createDatabase({ connectionString: postgres.databaseUrl, max: 10 }) // 10 连接×250ms 轮询 ⟹ 池不能是默认 4（假瓶颈，调研坑 6）
    await applyMigrations(database) // 裸连接不自带迁移（drive 走 createTestDatabase 才隐性做了——这里第一次就踩实）
    const { FIXTURE_BASIC } = await import('./chain.js')
    const asm = await assembleChain({ database, fixture: FIXTURE_BASIC, agents: 1 })
    asm.startWorker()
    const headers = {
      'content-type': 'application/json',
      origin: asm.ctx.origin,
      cookie: asm.alice.cookie,
    }
    const post = async (
      url: string,
      payload: unknown,
      idem = true,
    ): Promise<{ status: number; body: string }> => {
      const h: Record<string, string> = { ...headers }
      if (idem) h['idempotency-key'] = randomUUID()
      const res = await fetch(`${asm.httpBase}/api/v1${url}`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(payload),
      })
      return { status: res.status, body: await res.text() }
    }
    // 两条真 Task/Run（真人 HTTP 路径；task2 腿现场建——chain 只建一条是设计使然）。
    const startRun = async (taskId: string): Promise<string> => {
      const r = await post(`/tasks/${taskId}/runs`, {
        agentId: asm.builderAgentId,
        deviceId: asm.deviceId,
        workspaceId: asm.workspaceId,
        prompt: 'q8 load',
      })
      if (r.status !== 201)
        throw new Error(`startRun ${taskId}: ${r.status} ${r.body.slice(0, 160)}`)
      return (JSON.parse(r.body) as { data: { id: string } }).data.id
    }
    const runIds = [await startRun(asm.taskId)]
    const proj = JSON.parse((await post('/projects', { name: 'q8' })).body) as {
      data: { id: string }
    }
    const task2 = JSON.parse(
      (
        await post(`/projects/${proj.data.id}/tasks`, {
          title: 'q8 task2',
          assigneeUserId: asm.alice.userId,
        })
      ).body,
    ) as { data: { id: string } }
    await post(`/tasks/${task2.data.id}/accept`, {})
    runIds.push(await startRun(task2.data.id))

    // 10 浏览器连接（owner 视角同 Cookie——产品内多标签页形态）。每帧收齐
    // browserConnections 份后清 t0；被 4009 踢 = 判 FAIL 的硬事实。
    const wsBase = asm.httpBase.replace(/^http/, 'ws')
    const t0map = new Map<string, { sent: number; left: number }>()
    const sockets: WebSocket[] = []
    for (let i = 0; i < opts.browserConnections; i++) {
      const sock = new WebSocket(`${wsBase}/ws/v1/client?cursor=0`, {
        headers: { cookie: asm.alice.cookie, origin: asm.ctx.origin },
      })
      sock.on('message', (raw: Buffer) => {
        const at = performance.now()
        const frame = JSON.parse(String(raw)) as {
          type?: string
          kind?: string
          event?: { type?: string; payload?: { runId?: string; seq?: number } }
        }
        if (frame.type === 'resync.required') {
          dropped += 1
          sock.close()
          return
        }
        if (frame.kind === 'persistent' && frame.event?.type === 'run.event') {
          const p = frame.event.payload
          const key = `${p?.runId}:${p?.seq}`
          const entry = t0map.get(key)
          if (entry !== undefined) {
            propagation.push(at - entry.sent)
            entry.left -= 1
            if (entry.left <= 0) t0map.delete(key)
          }
        }
      })
      sock.on('close', (code) => {
        if (code === 4009) dropped += 1
      })
      sockets.push(sock)
      await new Promise<void>((resolve, reject) => {
        sock.once('open', resolve)
        sock.once('error', reject)
      })
    }
    const realtime = asm.ctx.app.realtime as unknown as { activeSubscriptionCount(): number }
    const subDeadline = Date.now() + 10_000
    while (realtime.activeSubscriptionCount() !== opts.browserConnections) {
      if (Date.now() > subDeadline)
        throw new Error(
          `订阅数 ${realtime.activeSubscriptionCount()} ≠ ${opts.browserConnections}（连接没成实——判据环境不成立）`,
        )
      await new Promise((r) => setTimeout(r, 100))
    }

    // ack 水位配对（throughSeq 是连续水位 ⟹ seq<=throughSeq 的 pending 全部收表）。
    const pendingAck = new Map<string, Map<number, number>>()
    const off = asm.onNodeFrame((frame, at) => {
      if (frame.type !== 'run.event_ack') return
      const p = frame.payload as { runId?: string; throughSeq?: number }
      const m = p.runId !== undefined ? pendingAck.get(p.runId) : undefined
      if (m === undefined || typeof p.throughSeq !== 'number') return
      for (const [seq, sent] of [...m.entries()]) {
        if (seq <= p.throughSeq) {
          ingest.push(at - sent)
          m.delete(seq)
        }
      }
    })

    // 等两个真 Run 终态（live 链路先真跑；合成流走迟到事件持久路径，不冒充活跃状态机）。
    for (const runId of runIds) {
      const d = Date.now() + 90_000
      for (;;) {
        const rows = await database.sql`select status from run where id = ${runId}`
        if (
          ['completed', 'failed', 'cancelled', 'lost'].includes(
            String((rows[0] as Record<string, unknown>).status),
          )
        )
          break
        if (Date.now() > d) throw new Error(`run ${runId.slice(0, 8)} 未在 90s 内终态`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    const bases: number[] = []
    for (const runId of runIds) {
      const rows =
        (await database.sql`select coalesce(max(seq), 0)::int as m from run_event where run_id = ${runId}`) as Array<{
          m: number
        }>
      bases.push(rows[0]!.m + 1) // 水位连续：合成 seq 必须接在真实 seq 之后，否则 throughSeq 永不越过
    }
    const liveRows = runIds.length > 0 ? bases.reduce((a, b) => a + b - 1, 0) : 0 // 合成前各 run 的真实持久事件数（产品链路真跑过的 DB 地面真值）

    const tStart = performance.now()
    const loadRss: XY[] = [] // 负载段只记录不判定（RSS 随分配速率单调台阶，见阈值注释）
    const rssTimer = setInterval(
      () => loadRss.push({ x: performance.now() - tStart, y: process.memoryUsage().rss }),
      3_000,
    )
    const intervalMs = 1000 / opts.ratePerStreamPerSec
    let tickCount = 0
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        tickCount += 1
        for (let s = 0; s < opts.streams; s++) {
          const seq = bases[s]! + tickCount - 1 // 每拍每流一帧：从真实水位之后连续编号
          const f = runEventFrameJson(runIds[s]!, seq)
          const sent = performance.now()
          t0map.set(f.key, { sent, left: opts.browserConnections })
          const runMap = pendingAck.get(runIds[s]!) ?? new Map<number, number>()
          runMap.set(seq, sent)
          pendingAck.set(runIds[s]!, runMap)
          asm.nodeSend(f.text)
        }
        if (performance.now() - tStart >= opts.durationMs) {
          clearInterval(timer)
          resolve()
        }
      }, intervalMs)
    })
    await done
    clearInterval(rssTimer)
    off()
    for (const s of sockets) s.close()
    await new Promise((r) => setTimeout(r, 5_000)) // ack/扇出尾巴与 GC 先落一轮
    // **空闲段 = 判定窗**：无任何注入仍持续上涨才是泄漏（04 空闲口径的缩短代理）。
    // 尺子账其三：33s/10 点窗曾被判据环境权威判 FAIL（斜率 2.7MiB/min）——取证
    // （180s+逐点强制 GC）证明 RSS/heapUsed 死平、无泄漏，系 GC 沉降伪影：
    // 短窗测的是"GC 何时跑"而非"内存是否留"。故窗长 33s→120s、每点先 gc() 再采
    // （测留存而非分配时序；脚本经 NODE_OPTIONS=--expose-gc 运行，无 gc 时静默跳过
    // 采样仍有效但分辨率降——dev 机接受的降级）。阈值不随本修复松动。
    const gc = (globalThis as { gc?: () => void }).gc
    const idleStart = performance.now()
    const idleTimer = setInterval(() => {
      gc?.()
      rssSamples.push({ x: performance.now() - idleStart, y: process.memoryUsage().rss })
    }, 3_000)
    await new Promise((r) => setTimeout(r, 120_000))
    clearInterval(idleTimer)
    await asm.cleanup()
    await database.close()
    const verdict = verdictLoadSample({
      propagation,
      ingest,
      idleRssSamples: rssSamples,
      droppedConnections: dropped,
      liveSamples: liveRows,
    })
    return {
      ...verdict,
      report: {
        runIds,
        liveRows,
        streams: opts.streams,
        ratePerStreamPerSec: opts.ratePerStreamPerSec,
        durationMs: opts.durationMs,
        browserConnections: opts.browserConnections,
        loadRssSamples: loadRss.length,
        idleRssSamples: rssSamples.length,
        recorderNote:
          '空闲段仍含 harness 自身（recorder 保留量/堆 GC 时序）；4→1MiB/min 的严界敢用于空闲窗正因分配伪影已排除——预演实测见 acceptance',
      },
    }
  } finally {
    await postgres.stop()
  }
}

/**
 * 两级判定（#109 修订，事实驱动：裁决前提"ubuntu-latest=4vCPU/16GB"被闸亲手
 * 证伪——实测 2vCPU/7.8GiB，本机 Docker VM 2C/1.9GiB，合格环境暂不可及）。
 *
 * 语义（FAIL 永不绿洗，SKIP 形态不存在）：
 * - 合格环境：权威判——PASS exit 0 / FAIL exit 2。
 * - 欠规环境跑完照判：PASS ⟹ exit 0 但标签 PASS-CONSERVATIVE（弱机过了强机
 *   必过，方向严格——这是保守证据不是权威判据，标签不许含糊）；FAIL ⟹
 *   exit 3 INCONCLUSIVE（不判产品红——可能是环境贫血；必须去合格环境复判）。
 * - --dev-report：任何结果恒 exit 3（调试面，永远不充当判据）。
 */
export function finalVerdict(
  envEligible: boolean,
  v: Pick<LoadVerdict, 'verdict'>,
  devReport: boolean,
): { code: 0 | 2 | 3; label: string } {
  if (devReport) return { code: 3, label: 'DEV-REPORT（非判据环境，任何结果不充当发布判据）' }
  if (envEligible)
    return v.verdict === 'PASS'
      ? { code: 0, label: 'PASS（判据环境，权威判）' }
      : { code: 2, label: 'FAIL（判据环境，权威判）' }
  if (v.verdict === 'PASS')
    return {
      code: 0,
      label: 'PASS-CONSERVATIVE（欠规环境保守口径：弱机过强机必过；非权威判据，合格环境复判仍欠）',
    }
  return {
    code: 3,
    label: 'INCONCLUSIVE（欠规环境 FAIL：可能是环境贫血，须合格环境复判——不绿洗也不误杀）',
  }
}
