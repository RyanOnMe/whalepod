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
        // 而 docker rm 默认**不回收匿名卷**——postgres 镜像在 /var/lib/postgresql/data
        // 声明了 VOLUME，每次重试就会永久漏一个 ~45 MB 的卷。实测复现：中断一次运行
        // 留下容器，事后 `docker rm -f`（无 -v）→ 卷永久残留。
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

async function waitReady(containerId: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    try {
      // 走容器内 TCP（而非本地 socket），确保发布端口对应的监听已就绪。
      await docker(['exec', containerId, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'])
      return
    } catch {
      if (Date.now() >= deadline) {
        let logs = ''
        try {
          logs = await docker(['logs', '--tail', '20', containerId])
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
 * 清扫本 worktree 上一次运行留下的容器与匿名卷（#188）。
 *
 * 为什么必须有：`--rm` 只在容器**自己退出**时回收匿名卷。上一次运行若被 SIGKILL /
 * 超时打断（本机高负载时很常见），容器会一直活着，卷也就一直留着；等到有人（或某条清理
 * 命令）用 `docker rm -f` 收掉容器时，卷**不会**跟着走。实测复现过这条链。
 *
 * 只按**本 worktree 的 scope 标签**筛，避免误删并行跑的兄弟 worktree 的库
 *（`e2eScope()` 的隔离设计见上）。
 */
export async function sweepStaleContainers(
  deps: {
    docker?: (args: string[]) => Promise<string>
    log?: (message: string) => void
  } = {},
): Promise<void> {
  const runDocker = deps.docker ?? docker
  const log = deps.log ?? ((message: string) => console.error(`[ephemeral-postgres] ${message}`))
  const scope = e2eScope()
  let ids: string[] = []
  try {
    const output = await runDocker(['ps', '-aq', '--filter', `label=whalepod.e2e-scope=${scope}`])
    ids = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (error) {
    // 清扫是尽力而为：Docker 抖动不该挡住启动（真正的启动失败会在下面如实报错）。
    log(
      `WARN 清扫陈旧容器失败（继续启动）：${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  if (ids.length === 0) return
  for (const id of ids) {
    try {
      await runDocker(['rm', '-f', '-v', id])
    } catch {
      // 单条删不掉不影响其余：下轮启动还会再扫。
    }
  }
  log(`已清扫上一次运行留下的 ${ids.length} 个容器（含其匿名卷）`)
}

export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  await ensureDocker()
  await ensureImage()
  await sweepStaleContainers()

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
    `whalepod.e2e-scope=${e2eScope()}`,
    IMAGE,
  ]

  let containerId: string
  let port: string
  try {
    ;({ containerId, port } = await launchWithPortRetry(runArgs, {
      docker,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      timeoutMs: PORT_PUBLISH_TIMEOUT_MS,
      pollMs: PORT_PUBLISH_POLL_MS,
      attempts: LAUNCH_ATTEMPTS,
      backoffMs: LAUNCH_BACKOFF_MS,
      log,
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
      await docker(['rm', '-f', '-v', containerId])
      log(`容器 ${containerId.slice(0, 12)} 已删除`)
    } catch (error) {
      log(
        `WARN 删除容器失败（需人工检查 docker ps）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  await waitReady(containerId)
  const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`

  return {
    databaseUrl,
    stop: removeContainer,
  }
}
