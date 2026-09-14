#!/usr/bin/env tsx
/**
 * 一次性 PostgreSQL 容器生命周期（供 with-test-postgres.mts CLI 与 e2e-serve 共用）。
 *
 * 启动 postgres:18 一次性容器（127.0.0.1 随机端口、随机密码、--rm），等端口映射
 * 发布（有界轮询，见 waitPublishedPort）与 ready 后返回连接串；stop() 强制删除容器，保证 `docker ps` 无残留。Docker 不可用、镜像
 * 缺失或启动超时（含重建上限用尽）一律抛错，不得报绿。密码不进仓库、不进日志；日志一律写 stderr。
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IMAGE = 'postgres:18'
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250
// 端口发布兜底：实测 x20 抓到两形态——第 8 轮「立即查询即红」、第 18/19 轮
// 「60s 死等仍不发布（容器活着，病态绑在单个 endpoint 上）」。故单次等待收窄到
// 20s，失败即删容器重建（共 3 次尝试）：重开沙箱比延长等待有效，且总预算
// （3×20s + 退避 3s）留在 playwright webServer 的 180s 超时内。
const PORT_PUBLISH_TIMEOUT_MS = 20_000
/**
 * 无 pid 标签的陈旧容器判为残留所需的年龄（#188）：10 分钟远大于任何一次门禁运行的
 * 启动阶段，又远小于「上一轮被中断、隔天再跑」的间隔，所以既不误杀、又能自愈。
 */
const STALE_GRACE_MS = 10 * 60_000
/**
 * 容器年龄上限（#190 评审 R2）：超过它一律算残留，**不再看 pid 是否活着**。
 *
 * 为什么需要：pid 会被复用。若某个残留容器的 `runner-pid` 标签恰好指向一个活着的无关进程，
 * 单看 pid 就会**永远**判为「正在运行中」，容器与匿名卷永久留下（评审实测：把时钟拨到
 * 30 天后仍是 `[]`）。6 小时远大于任何一次门禁运行（Q5 webServer 预算 180s、负载长档 30min），
 * 所以正常运行的容器不会被它误判。
 */
const STALE_MAX_AGE_MS = 6 * 60 * 60_000
const PORT_PUBLISH_POLL_MS = 250
const LAUNCH_ATTEMPTS = 3
const LAUNCH_BACKOFF_MS = 1_000

const log = (message: string): void => console.error(`[ephemeral-postgres] ${message}`)

function fail(message: string): never {
  log(`FAIL ${message}`)
  process.exit(1)
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function ensureDocker(): Promise<void> {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'])
  } catch {
    fail('Docker 不可用；需要本机 Docker 运行临时 postgres:18')
  }
}

async function ensureImage(): Promise<void> {
  try {
    await docker(['image', 'inspect', IMAGE])
  } catch {
    log(`本地无 ${IMAGE}，拉取中…`)
    try {
      await docker(['pull', IMAGE])
    } catch (error) {
      fail(`拉取 ${IMAGE} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 端口发布探测的依赖面（生产接线用真实 docker + setTimeout/Date.now；
 * 确定性测试注入假 docker/时钟——Q5 x20 第 8 轮实测竞态的回归哨兵需要）。
 */
export interface PublishedPortDeps {
  docker(args: string[]): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
  timeoutMs: number
  pollMs: number
}

/**
 * `docker run -d` 返回 ≠ 端口映射已发布：Docker 网络编程有滞后窗（实测 20 连跑
 * 第 8 轮抓到——容器报「已启动」而 `docker port` 报 no public port published）。
 * 有界轮询直至发布；超期附 `docker logs --tail 20` 现场抛出（区分「发布滞后」
 * 与「容器即死」两种真因），绝不带着歧义继续。
 */
export async function waitPublishedPort(
  containerId: string,
  deps: PublishedPortDeps,
): Promise<string> {
  const deadline = deps.now() + deps.timeoutMs
  for (;;) {
    try {
      const out = await deps.docker(['port', containerId, '5432'])
      const line = out.trim().split('\n')[0] ?? ''
      const port = line.split(':').pop()?.trim()
      if (port && /^\d+$/.test(port) && port !== '0') return port
      // 空输出/端口 0：视为「尚未发布」继续轮询，不误报成功。
    } catch {
      // docker port 非零退出（no public port published）= 预期中的未发布态。
    }
    if (deps.now() >= deadline) {
      let logs = ''
      try {
        logs = await deps.docker(['logs', '--tail', '20', containerId])
      } catch {
        logs = '(docker logs 也不可用)'
      }
      throw new Error(
        `容器 ${containerId.slice(0, 12)} 端口映射未在 ${deps.timeoutMs / 1000}s 内发布` +
          `（若日志显示容器已死则非竞态）。容器日志尾部：\n${logs}`,
      )
    }
    await deps.sleep(deps.pollMs)
  }
}

export interface LaunchDeps extends PublishedPortDeps {
  /** 创建→发布失败之间的重试退避基数（第 i 次重试等 i*backoffMs）。 */
  backoffMs: number
  /** 总尝试次数（含首次）。 */
  attempts: number
  log(message: string): void
}

/**
 * 创建容器 + 等端口发布，**发布失败则删容器重建**（上限 attempts 次）。
 *
 * 依据（Q5 x20 三轮实测的两形态）：第 8 轮「立即查即无」、第 18/19 轮「容器活着
 * （initdb 完成、日志可取）但 60s 内端口始终不发布」——后者说明病态绑在单个
 * endpoint 上，延长等待无效，重开沙箱才有效（Docker Desktop 端口分配器在连续
 * 容器 churn 下的退化）。环境准备失败不该判产品死刑，也不该吃掉 playwright
 * webServer 的 180s 预算：故用 attempts×portTimeout + 退避的有界重建。
 */
export async function launchWithPortRetry(
  runArgs: string[],
  deps: LaunchDeps,
): Promise<{ containerId: string; port: string }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= deps.attempts; attempt += 1) {
    const containerId = (await deps.docker(runArgs)).trim()
    deps.log(`容器 ${containerId.slice(0, 12)} 已启动（第 ${attempt}/${deps.attempts} 次尝试）`)
    try {
      const port = await waitPublishedPort(containerId, deps)
      return { containerId, port }
    } catch (error) {
      lastError = error
      deps.log(
        `WARN 第 ${attempt}/${deps.attempts} 次端口发布失败：${
          error instanceof Error ? error.message.split('\n')[0] : String(error)
        }`,
      )
      // 删掉这个「活着但网络没发布」的容器，让下一次尝试拿到全新沙箱。
      try {
        // `-v` 必须带（#188）：这里删的是**活着**的容器，`--rm` 策略不会生效，
        // 而 docker rm 默认**不回收匿名卷**——postgres:18 的 Config.Volumes 实测为
        // /var/lib/postgresql（PG18 改了布局，不是 /var/lib/postgresql/data），每次重试
        // 就会永久漏一个 ~40 MB 的卷。实测复现：中断一次运行留下容器，事后
        // `docker rm -f`（无 -v）→ 卷永久残留。
        await deps.docker(['rm', '-f', '-v', containerId])
      } catch {
        // --rm 容器可能已自清：删不掉不是本路径的判据，继续重试。
      }
      if (attempt < deps.attempts) await deps.sleep(deps.backoffMs * attempt)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`端口发布连续 ${deps.attempts} 次失败（无错误现场）`)
}

async function waitReady(
  containerId: string,
  runDocker: (args: string[]) => Promise<string> = docker,
  nowMs: () => number = Date.now,
): Promise<void> {
  const deadline = nowMs() + READY_TIMEOUT_MS
  for (;;) {
    try {
      // 走容器内 TCP（而非本地 socket），确保发布端口对应的监听已就绪。
      await runDocker(['exec', containerId, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'])
      return
    } catch {
      if (nowMs() >= deadline) {
        let logs = ''
        try {
          logs = await runDocker(['logs', '--tail', '20', containerId])
        } catch {
          logs = '(docker logs 也不可用)'
        }
        fail(`PostgreSQL ${READY_TIMEOUT_MS / 1000}s 内未就绪。容器日志尾部：\n${logs}`)
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
  }
}

export interface EphemeralPostgres {
  readonly databaseUrl: string
  /** 强制删除容器；幂等。 */
  stop(): Promise<void>
}

/**
 * 当前 worktree 的隔离标识（并行 e2e 用）：取 cwd 目录名 + 路径短哈希。
 * 目的：多 worktree 并行跑 Q5 时，容器清理只碰自己那一副，不误删兄弟线的 DB。
 */
export function e2eScope(cwd: string = process.cwd()): string {
  const name = cwd.split('/').filter(Boolean).pop() ?? 'root'
  let hash = 0
  for (const ch of cwd) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return `${name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 24)}-${hash.toString(16).slice(0, 6)}`
}

/**
 * 判定「哪些容器是上一次运行留下的残留」（#188 + 评审 B1/B2）。
 *
 * 三条判据，缺一不可：
 *   1. **scope 标签**（worktree 隔离）：绝不碰兄弟 worktree 的库；
 *   2. **启动者 pid**：pid 仍活着 = 同 worktree 里正跑着的兄弟运行 → **一律不碰**
 *     （这是评审 B2 抓到的回归：只按 scope 清会把并行运行的库抽走）；
 *   3. **宽限期**：没有 pid 标签的旧容器（历史版本留下的）按「启动超过 graceMs」判定，
 *     避免把刚起、还没来得及打标签的容器当残留。
 *
 * pid 已死 = 那次运行确定结束了 → 立即算残留（不必等宽限期）。
 */
export interface StaleContainerDeps {
  docker?: (args: string[]) => Promise<string>
  log?: (message: string) => void
  /** 判定 pid 是否仍活着（默认 process.kill(pid, 0)）；注入便于确定性测试。 */
  isPidAlive?: (pid: number) => boolean
  now?: () => number
  /** 无 pid 标签的容器判为残留所需的年龄（默认 10 分钟）。 */
  graceMs?: number
  /** 无论 pid 是否活着都判为残留的年龄上限（默认 6 小时；pid 复用兜底）。 */
  maxAgeMs?: number
  /** 覆盖 scope（默认取当前 cwd 的 e2eScope）；测试用。 */
  scope?: string
}

interface ContainerFacts {
  id: string
  startedAt: number
  runnerPid: number | undefined
}

/** docker ps -aq（按 scope 标签）→ docker inspect 一次拿全部事实。 */
async function inspectScopedContainers(
  runDocker: (args: string[]) => Promise<string>,
  scope: string,
): Promise<ContainerFacts[]> {
  const listed = await runDocker(['ps', '-aq', '--filter', `label=whalepod.e2e-scope=${scope}`])
  const ids = listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (ids.length === 0) return []
  // 一次 inspect 拿全部（避免 N 次往返）：Id | StartedAt | runner-pid 标签。
  // 注意（#190 评审 O1）：批量 inspect 只要有一个 id 在 ps 与 inspect 之间消失，docker 会
  // 输出**部分**结果并以非零退出——真实 CLI 走 execFile 时即 reject。所以这里要保住部分结果，
  // 否则「兄弟运行的正常 stop()」这类 20ms 窗口会让本轮清扫整体放弃。
  let inspected: string
  try {
    inspected = await runDocker([
      'inspect',
      '--format',
      '{{.Id}}|{{.State.StartedAt}}|{{index .Config.Labels "whalepod.e2e-runner-pid"}}',
      ...ids,
    ])
  } catch (error) {
    const partial = (error as { stdout?: string }).stdout
    if (typeof partial !== 'string' || partial.trim().length === 0) throw error
    inspected = partial
  }
  return inspected
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id = '', startedAt = '', pidRaw = ''] = line.split('|')
      const started = Date.parse(startedAt)
      const pid = Number.parseInt(pidRaw, 10)
      return {
        id,
        startedAt: Number.isNaN(started) ? 0 : started,
        // 缺标签时 Go 模板渲染成 `<no value>`；非数字一律视为「无 pid」。
        runnerPid: Number.isNaN(pid) ? undefined : pid,
      }
    })
    .filter((facts) => facts.id.length > 0)
}

export async function findStaleContainers(deps: StaleContainerDeps = {}): Promise<string[]> {
  const runDocker = deps.docker ?? docker
  const now = deps.now ?? (() => Date.now())
  const graceMs = deps.graceMs ?? STALE_GRACE_MS
  const maxAgeMs = deps.maxAgeMs ?? STALE_MAX_AGE_MS
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  const facts = await inspectScopedContainers(runDocker, deps.scope ?? e2eScope())
  return facts
    .filter((container) => {
      const age = now() - container.startedAt
      // 先看年龄上限：pid 会被复用，超过上限一律算残留（否则「恰好活着」的 pid 会让容器永留）。
      if (age > maxAgeMs) return true
      // pid 标签有效（>=2：0 会让 process.kill(0,0) 不抛、1 恒 EPERM，都不是真实 runner）。
      if (container.runnerPid !== undefined && container.runnerPid >= 2) {
        return !isPidAlive(container.runnerPid)
      }
      // 无（有效）pid 标签：只有够老才算残留（历史版本留下的容器没有这个标签）。
      return age > graceMs
    })
    .map((container) => container.id)
}

/**
 * 清扫本 worktree 上一次运行留下的容器与匿名卷（#188）。
 *
 * 为什么必须有：`--rm` 只在容器**自己退出**时回收匿名卷。上一次运行若被 SIGKILL /
 * 超时打断（本机高负载时很常见），容器会一直活着，卷也就一直留着；等到有人（或某条清理
 * 命令）用 `docker rm -f` 收掉容器时，卷**不会**跟着走。实测复现过这条链。
 *
 * 已知口径（#190 评审 O2）：pid 标签记的是**启动者**（wrapper 进程），不是整棵运行树。
 * 常规 Ctrl-C / SIGTERM 会转发给子进程并等待其退出，所以判据成立；但「只 SIGKILL wrapper
 * 而让被包裹的子进程继续跑」这一形态下，下一次启动会把那个子进程**正在用**的库一并扫掉
 *（评审实测）。要根治需记 pgid，本片不做，在此写明。
 *
 * 只清 `findStaleContainers` 判定的残留（活着的兄弟运行不碰），且一律 `rm -f -v`
 *（`-v` 才是回收匿名卷的那一位）。
 */
export async function sweepStaleContainers(deps: StaleContainerDeps = {}): Promise<number> {
  const runDocker = deps.docker ?? docker
  const log = deps.log ?? ((message: string) => console.error(`[ephemeral-postgres] ${message}`))
  let stale: string[] = []
  try {
    stale = await findStaleContainers(deps)
  } catch (error) {
    // 清扫是尽力而为：Docker 抖动不该挡住启动（真正的启动失败会在下面如实报错）。
    log(
      `WARN 清扫陈旧容器失败（继续启动）：${error instanceof Error ? error.message : String(error)}`,
    )
    return 0
  }
  if (stale.length === 0) return 0
  let removed = 0
  for (const id of stale) {
    try {
      await runDocker(['rm', '-f', '-v', id])
      removed += 1
    } catch {
      // 单条删不掉不影响其余：下轮启动还会再扫。
    }
  }
  if (removed > 0) {
    log(`已清扫上一次运行留下的 ${removed} 个容器（含其匿名卷）`)
  }
  return removed
}

/** 默认存活判定：ESRCH = 不存在；EPERM = 存在但非本用户（也算活着）。 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 启动依赖（#188 评审 S1/S2）：`docker` 原先只在模块级，导致 `removeContainer` 的 `-v`、
 * 清扫的接线与顺序**都无法被判据覆盖**（变异后 Q0 全绿）。开一个注入缝，让单测能用假
 * docker 走完整条启动→清理路径。
 */
export interface StartDeps {
  docker?: (args: string[]) => Promise<string>
  /** 跳过 ensureDocker/ensureImage（单测不碰真 Docker）。 */
  skipPrelude?: boolean
  now?: () => number
  log?: (message: string) => void
  isPidAlive?: (pid: number) => boolean
  scope?: string
}

export async function startEphemeralPostgres(deps: StartDeps = {}): Promise<EphemeralPostgres> {
  const runDocker = deps.docker ?? docker
  const startLog = deps.log ?? log
  const scope = deps.scope ?? e2eScope()
  if (deps.skipPrelude !== true) {
    await ensureDocker()
    await ensureImage()
  }
  await sweepStaleContainers({
    docker: runDocker,
    log: startLog,
    scope,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.isPidAlive !== undefined ? { isPidAlive: deps.isPidAlive } : {}),
  })

  // 随机密码：一次性容器不落到任何文件，避免 secret-scan 语料与真实凭据混淆。
  const password = randomBytes(12).toString('base64url')
  const runArgs = [
    'run',
    '-d',
    '--rm',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-p',
    '127.0.0.1:0:5432',
    '--label',
    'whalepod.e2e-postgres=true',
    // 并行 worktree 隔离：多 worktree 同时跑 e2e 时，各自的清理只该动自己的容器。
    // 旧标签保留（q5-loop.sh 与历史清理路径仍按它筛），新标签用于「按 worktree 精确清」。
    '--label',
    `whalepod.e2e-scope=${scope}`,
    // 启动者 pid（#188 评审 B2）：清扫据此区分「上一次中断的残留」与「**同 worktree 里
    // 正在跑的兄弟运行**」——scope 只隔离到 worktree，同 worktree 并发（integration +
    // resilience、或两条 integration）scope 相同，只按 scope 清会互相残杀（实测：
    // 后起者启动即把先起者正在用的库删掉）。
    '--label',
    `whalepod.e2e-runner-pid=${process.pid}`,
    IMAGE,
  ]

  let containerId: string
  let port: string
  try {
    ;({ containerId, port } = await launchWithPortRetry(runArgs, {
      docker: runDocker,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      timeoutMs: PORT_PUBLISH_TIMEOUT_MS,
      pollMs: PORT_PUBLISH_POLL_MS,
      attempts: LAUNCH_ATTEMPTS,
      backoffMs: LAUNCH_BACKOFF_MS,
      log: startLog,
    }))
  } catch (error) {
    // 抛错即死（非零退出）：e2e-serve/with-test-postgres 都以启动失败处理，
    // 报错已带日志尾部现场——不留「带着未发布端口继续跑」的歧义态。
    fail(error instanceof Error ? error.message : String(error))
  }

  let stopped = false
  async function removeContainer(): Promise<void> {
    if (stopped) return
    stopped = true
    try {
      // `-v` 见上面重试路径的说明（#188）：强杀/超时路径下容器可能仍活着，不带 -v 就漏卷。
      await runDocker(['rm', '-f', '-v', containerId])
      startLog(`容器 ${containerId.slice(0, 12)} 已删除`)
    } catch (error) {
      startLog(
        `WARN 删除容器失败（需人工检查 docker ps）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  await waitReady(containerId, runDocker, deps.now ?? Date.now)
  const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`

  return {
    databaseUrl,
    stop: removeContainer,
  }
}
