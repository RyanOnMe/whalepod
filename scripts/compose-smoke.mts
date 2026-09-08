/**
 * Q9 安装门（P1-20 / #24）：`pnpm test:compose-smoke`。
 *
 * 判据对齐 04 矩阵：「从镜像与空卷启动 ⟹ 15 分钟内完成标准闭环」。
 * 闭环范围（机检面）= 安装与接线：compose up（**生产同一份 compose.yml**，
 * 不造冒烟专用拓扑）→ 浏览器视角探活 → setup-token 经**容器内生产 bin** 读取
 * （#95 教训的镜像版）→ 建队/登录/配对走真实 HTTP（Origin/Idempotency 全按
 * 03 §4）→ **宿主真 node bin** pair/workspace add/start → Hub 投影可见 →
 * web 静态与反代可达。主链 Run 闭环归 Q5（E2E），不在此重复。
 *
 * 失败纪律：每阶段带 `component` 归因与耗时；任何一步不过 = 非零退出；
 * 清理在 finally（down -v + 杀子进程 + 删临时 HOME），端口用随机高位段防互踩。
 */
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const COMPOSE_FILE = join(REPO_ROOT, 'deploy/compose.yml')
const TOTAL_BUDGET_MS = 15 * 60_000
const startedAt = Date.now()
const project = `p311smoke${randomBytes(3).toString('hex')}`
const webPort = 20_000 + Math.floor(Math.random() * 20_000)
const dbPassword = randomBytes(12).toString('hex')
const publicOrigin = `http://localhost:${webPort}`
// 文书与机检同路径（B7）：机密写临时 .env（0600），compose 一律 --env-file 显式指定，
// 与 installation.md 教给非开发者的形态逐字一致——不依赖 cwd 解析的跨版本差异。
const envDir = mkdtempSync(join(tmpdir(), 'p311smoke-env-'))
const envFile = join(envDir, '.env')

const phaseLog: Array<{ phase: string; ms: number }> = []
let phaseMark = Date.now()
function phase(name: string): void {
  phaseLog.push({ phase: name, ms: Date.now() - phaseMark })
  phaseMark = Date.now()
  process.stdout.write(
    `[compose-smoke] ${name} (+${(phaseLog[phaseLog.length - 1]!.ms / 1000).toFixed(1)}s)\n`,
  )
  if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
    throw new Error(`compose-smoke: 15 分钟总预算超时（进入 ${name} 时）`)
  }
}

function composeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    POSTGRES_PASSWORD: dbPassword,
    PROJECT311_PUBLIC_ORIGIN: publicOrigin,
    P311_WEB_PORT: String(webPort),
  }
}

/** 剩余预算（一审 B3：15 分钟是硬闸不是终检——每个外部调用都带死线，挂死=红而非永久挂）。 */
function remainingMs(): number {
  return Math.max(1_000, TOTAL_BUDGET_MS - (Date.now() - startedAt))
}

async function compose(args: string[]): Promise<string> {
  const { stdout } = await execFileP(
    'docker',
    ['compose', '--env-file', envFile, '-f', COMPOSE_FILE, '-p', project, ...args],
    {
      env: composeEnv(),
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
      timeout: remainingMs(), // B3：compose 子进程挂死不得绕过预算
    },
  )
  return stdout
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitHealthy(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  let last = 'unknown'
  for (;;) {
    try {
      const res = await fetch(`${publicOrigin}/healthz`, { signal: AbortSignal.timeout(10_000) })
      if (res.status === 200) {
        const body = (await res.json()) as { ok?: boolean }
        if (body.ok === true) return
        last = `200 but body=${JSON.stringify(body).slice(0, 120)}`
      } else last = `status=${res.status}`
    } catch (error) {
      last = String(error)
    }
    if (Date.now() > deadline)
      throw new Error(`hub unreachable via nginx /healthz within budget; last=${last}`)
    await sleep(1000)
  }
}

/** 浏览器替身：非安全方法必须带精确 Origin + Idempotency-Key（03 §4）。 */
async function api<T>(
  method: string,
  path: string,
  payload?: unknown,
  cookie?: string,
): Promise<{ status: number; body: T; cookie?: string }> {
  const headers: Record<string, string> = {
    origin: publicOrigin,
    'content-type': 'application/json',
  }
  if (method !== 'GET') headers['idempotency-key'] = randomBytes(16).toString('hex') // 16-128 字符内
  if (cookie !== undefined) headers.cookie = cookie
  const res = await fetch(`${publicOrigin}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(30_000), // 一审 nit：api 群同挂死线
  })
  const setCookie = res.headers.get('set-cookie') ?? undefined
  const body = (await res.json()) as T
  return {
    status: res.status,
    body,
    cookie: setCookie === undefined ? undefined : setCookie.split(';')[0],
  }
}

function runNodeCli(
  args: string[],
  home: string,
): { child: ReturnType<typeof spawn>; tail: () => string } {
  const buf: string[] = []
  const child = spawn(process.execPath, [join(REPO_ROOT, 'apps/node/dist/cli.js'), ...args], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (c: Buffer) => buf.push(c.toString())) // 必须消费：管道满会卡死子进程
  child.stderr.on('data', (c: Buffer) => buf.push(c.toString()))
  return { child, tail: () => buf.join('').slice(-1500) }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'p311-smoke-home-'))
  let wsDir: string | undefined
  let nodeChild: { child: ReturnType<typeof spawn>; tail: () => string } | undefined
  let up = false
  try {
    // envFile 必须在第一次 compose 调用前写好（up 在 phase 打点之前执行——插错过一次，Q9 红实录）。
    const { writeFileSync, chmodSync } = await import('node:fs')
    writeFileSync(
      envFile,
      `POSTGRES_PASSWORD=${dbPassword}\nPROJECT311_PUBLIC_ORIGIN=${publicOrigin}\nP311_WEB_PORT=${webPort}\n`,
    )
    chmodSync(envFile, 0o600)
    await compose(['up', '-d', '--build'])
    up = true
    phase('compose up --build')
    await waitHealthy(8 * 60_000)
    phase('healthy via nginx /healthz')

    // web 静态可达 + 哈希资产真实存在（只 GET 200 不证明 bundle 齐）。
    const page = await fetch(`${publicOrigin}/`, { signal: AbortSignal.timeout(30_000) })
    if (page.status !== 200) throw new Error(`web root status=${page.status}`)
    const html = await page.text()
    const asset = /\/assets\/[\w.-]+\.js/.exec(html)?.[0]
    if (asset === undefined)
      throw new Error('index.html 无 /assets/*.js 引用（vite build 产物形态变了）')
    if (
      (await fetch(`${publicOrigin}${asset}`, { signal: AbortSignal.timeout(30_000) })).status !==
      200
    )
      throw new Error(`asset ${asset} 404`)
    phase('web static + hashed asset')

    // 容器内**生产 bin** 读 setup token（compose 就是 hub 入口的组合根测）。
    const tokenOut = (
      await compose(['exec', '-T', 'hub', 'node', 'dist/cli.js', 'setup-token'])
    ).trim()
    if (!/^[\w-]{16,}$/.test(tokenOut))
      throw new Error(`setup-token 形态异常: ${tokenOut.slice(0, 40)}`)
    phase('container bin setup-token')

    const setup = await api<{ data?: { userId?: string } }>('POST', '/api/v1/setup', {
      setupToken: tokenOut,
      teamName: 'Smoke Co',
      username: 'smoke',
      displayName: 'Smoke',
      password: 'correct horse battery staple',
    })
    if (setup.status !== 201 || setup.cookie === undefined)
      throw new Error(`setup status=${setup.status}`)
    const login = await api<unknown>('POST', '/api/v1/auth/login', {
      username: 'smoke',
      password: 'correct horse battery staple',
    })
    if (login.status !== 200 || login.cookie === undefined)
      throw new Error(`login status=${login.status}`)
    const cookie = login.cookie
    phase('setup + login via API')

    const code = await api<{ data?: { code?: string } }>(
      'POST',
      '/api/v1/devices/pairing-codes',
      {},
      cookie,
    )
    const pairing = code.body.data?.code
    if (code.status !== 201 || pairing === undefined)
      throw new Error(`pairing-code status=${code.status}`)
    const pair = runNodeCli(['pair', '--hub', publicOrigin, '--code', pairing], home)
    const pairCode = await new Promise<number | null>((resolve) =>
      pair.child.on('exit', (c) => resolve(c)),
    )
    if (pairCode !== 0) throw new Error(`node cli pair exit=${pairCode}\n${pair.tail()}`)
    phase('pairing code + node cli pair')

    wsDir = mkdtempSync(join(tmpdir(), 'p311-smoke-ws-'))
    mkdirSync(join(wsDir, '.git'), { recursive: true }) // git_repository kind 分支
    const add = runNodeCli(['workspace', 'add', wsDir, '--name', 'smoke-ws'], home)
    if ((await new Promise<number | null>((r) => add.child.on('exit', r))) !== 0) {
      throw new Error(`node cli workspace add 非零退出\n${add.tail()}`)
    }
    nodeChild = runNodeCli(['start'], home)
    phase('workspace add + node start')

    // 投影就绪 = 轮询真人 API（与 Q5/chain 同一判据形态，不数自报帧）。
    const probeLog: Array<{ status: number; names: (string | undefined)[]; body: string }> = []
    const deadline = Date.now() + 60_000
    for (;;) {
      const list = await api<{ data?: Array<{ name?: string; kind?: string }>; error?: unknown }>(
        'GET',
        '/api/v1/workspaces',
        undefined,
        cookie, // 带权限接口：不带会话就是 401，轮询会把它读成「投影为空」——必须带
      )
      probeLog.push({
        status: list.status,
        names: (list.body.data ?? []).map((w) => w.name),
        body: JSON.stringify(list.body).slice(0, 160),
      })
      const mine = (list.body.data ?? []).filter((w) => w.name === 'smoke-ws')
      if (mine.length === 1) {
        if (mine[0]!.kind !== 'git_repository') throw new Error(`kind 投影异常: ${mine[0]!.kind}`)
        break
      }
      if (nodeChild?.child.exitCode !== null) {
        throw new Error(
          `node start 退出 code=${nodeChild.child.exitCode}，投影仍缺\n${nodeChild.tail()}`,
        )
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Hub 投影 60s 内未出现 smoke-ws。最近 3 次轮询=${JSON.stringify(probeLog.slice(-3))}\n` +
            `node start stderr 尾:\n${nodeChild?.tail() ?? 'n/a'}`,
        )
      }
      await sleep(2000)
    }
    phase('inventory projection visible')

    const total = ((Date.now() - startedAt) / 1000).toFixed(1)
    process.stdout.write(
      `[compose-smoke] PASS total=${total}s phases=${JSON.stringify(phaseLog)}\n`,
    )
  } finally {
    nodeChild?.child.kill('SIGKILL')
    if (up) {
      try {
        await compose(['down', '-v', '--remove-orphans'])
      } catch (error) {
        process.stderr.write(
          `[compose-smoke] component=harness.smoke down 失败（需人工清 ${project}）: ${String(error)}\n`,
        )
      }
    }
    rmSync(home, { recursive: true, force: true })
    if (wsDir !== undefined) rmSync(wsDir, { recursive: true, force: true }) // 一审 nit：临时目录全数收尸
    rmSync(envDir, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `[compose-smoke] FAIL component=hub.smoke ${String(error)}\nphases=${JSON.stringify(phaseLog)}\n`,
  )
  process.exitCode = 1
})
