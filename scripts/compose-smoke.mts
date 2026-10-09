/**
 * Q9 安装门（P1-20 / #24）：`pnpm test:compose-smoke`。
 *
 * 判据对齐 04 矩阵：「从镜像与空卷启动 ⟹ 15 分钟内完成标准闭环」。闭环分两段，
 * 边界写在下面（对外说法只许照抄这一段，不许把两段说成一段）：
 *
 *   A. 安装与接线（本脚本全程机检）：compose up（**生产同一份 compose.yml**，
 *      不造冒烟专用拓扑）→ 浏览器视角探活 → setup-token 经**容器内生产 bin**
 *      读取（#95 教训的镜像版）→ 建队/登录/邀请/接受/配对走真实 HTTP
 *      （Origin/Idempotency 全按 03 §4）→ **宿主真 node bin** pair/workspace
 *      add/start → 两成员各一台设备、各自 Workspace → 投影可见且**互不可见**
 *      → Agent 经真实管理 API 建（core-empty Pack 随 Setup 落库）→ Task 建单/
 *      指派/受理 → 两位成员各自在自己 Workspace 上**起 Run** → Run 走到
 *      Runtime 启动前一步，缺模型凭证时 Hub 落 failed/MODEL_CREDENTIAL_UNAVAILABLE
 *      （诚实失败，不静默挂起）→ 跨成员起 Run 被拒且 Run 数不变。
 *   B. Agent 真执行（**不在本脚本内，不得声称被本脚本验过**）：需要真实模型
 *      密钥，属 Phase 2 外部 alpha（真团队真密钥）与人工狗食；Q5 E2E 用 DSH
 *      replay overlay 在开发装配上覆盖执行段（无外部模型）。
 *
 * 所以本脚本证的是：**空卷安装能承载标准闭环直到凭证边界，且边界处如实报错**。
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
const project = `wpsmoke${randomBytes(3).toString('hex')}`
const webPort = 20_000 + Math.floor(Math.random() * 20_000)
const dbPassword = randomBytes(12).toString('hex')
const publicOrigin = `http://localhost:${webPort}`
/** 第二位成员的口令：过口令政策（#106 起 setup/invite 两条建账腿同判）。 */
const MEMBER_PASSWORD = 'correct horse battery staples'
/** GET /workspaces 投影条目（03 §4 的不透明 Workspace 视图，无本地路径）。 */
interface WsEntry {
  workspaceId?: string
  deviceId?: string
  name?: string
  kind?: string
}
// 文书与机检同路径（B7）：机密写临时 .env（0600），compose 一律 --env-file 显式指定，
// 与 installation.md 教给非开发者的形态逐字一致——不依赖 cwd 解析的跨版本差异。
const envDir = mkdtempSync(join(tmpdir(), 'wpsmoke-env-'))
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
    WHALEPOD_PUBLIC_ORIGIN: publicOrigin,
    WHALEPOD_WEB_PORT: String(webPort),
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

/**
 * 有界轮询（与仓库 poll-until 纪律同形）：probe 返回 undefined 表示「还没到」，
 * 到deadline 抛带语义的错。固定 sleep 猜时间在这里一律不出现。
 */
async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  describe: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error(`超时 ${(timeoutMs / 1000).toFixed(0)}s：${describe}`)
    }
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
  // 两成员形态：每人一台设备（独立 HOME = 独立 Device Token/密钥库/workspace 登记），
  // 收尸统一走数组——A0-5 之前是单变量，加第二台时最容易漏杀漏删。
  const homes: string[] = [mkdtempSync(join(tmpdir(), 'wp-smoke-home-'))]
  const home = homes[0]!
  const wsDirs: string[] = []
  const nodeChildren: Array<{ child: ReturnType<typeof spawn>; tail: () => string }> = []
  let up = false
  try {
    // envFile 必须在第一次 compose 调用前写好（up 在 phase 打点之前执行——插错过一次，Q9 红实录）。
    const { writeFileSync, chmodSync } = await import('node:fs')
    writeFileSync(
      envFile,
      `POSTGRES_PASSWORD=${dbPassword}\nWHALEPOD_PUBLIC_ORIGIN=${publicOrigin}\nWHALEPOD_WEB_PORT=${webPort}\n`,
    )
    chmodSync(envFile, 0o600)
    // Docker Hub 匿名授权 EOF 是本会话三次实录的瞬时抖动（ephemeral-postgres 有
    // 同款退避）：仅对拉取/授权类失败重试一次，构建/编排错误不掩。
    try {
      await compose(['up', '-d', '--build'])
    } catch (error) {
      if (
        !/failed to resolve reference|failed to (fetch oauth token|authorize)|EOF/.test(
          String(error),
        )
      )
        throw error
      process.stderr.write('[compose-smoke] component=harness.smoke 拉取抖动，退避 20s 重试一次\n')
      await sleep(20_000)
      await compose(['up', '-d', '--build'])
    }
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
    const ownerUserId = setup.body.data?.userId
    if (ownerUserId === undefined) throw new Error('setup 未回 userId')
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

    const wsDir = mkdtempSync(join(tmpdir(), 'wp-smoke-ws-'))
    wsDirs.push(wsDir)
    mkdirSync(join(wsDir, '.git'), { recursive: true }) // git_repository kind 分支
    const add = runNodeCli(['workspace', 'add', wsDir, '--name', 'smoke-ws'], home)
    if ((await new Promise<number | null>((r) => add.child.on('exit', r))) !== 0) {
      throw new Error(`node cli workspace add 非零退出\n${add.tail()}`)
    }
    const nodeChild = runNodeCli(['start'], home)
    nodeChildren.push(nodeChild)
    phase('workspace add + node start')

    // 投影就绪 = 轮询真人 API（与 Q5/chain 同一判据形态，不数自报帧）。
    const probeLog: Array<{ status: number; names: (string | undefined)[]; body: string }> = []
    const ownerWs = await pollUntil(async () => {
      const list = await api<{ data?: WsEntry[]; error?: unknown }>(
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
        return mine[0]!
      }
      if (nodeChild.child.exitCode !== null) {
        throw new Error(
          `node start 退出 code=${nodeChild.child.exitCode}，投影仍缺\n${nodeChild.tail()}`,
        )
      }
      return undefined
    }, 'Hub 投影 60s 内未出现 smoke-ws').catch((error: unknown) => {
      throw new Error(
        `${String(error)}\n最近 3 次轮询=${JSON.stringify(probeLog.slice(-3))}\n` +
          `node start stderr 尾:\n${nodeChild.tail()}`,
      )
    })
    phase('inventory projection visible')

    // ---------- A0-5：标准闭环的机检面（到凭证边界为止） ----------
    // 段落边界见文件头：Agent 真执行要真实模型密钥，本脚本不假装跑过。

    // ① 邀请第二位成员（03 §4：Owner 建邀请 → 匿名腿一次性 Token 接受）。
    const invite = await api<{ data?: { token?: string } }>(
      'POST',
      '/api/v1/invites',
      { role: 'member' },
      cookie,
    )
    const inviteToken = invite.body.data?.token
    if (invite.status !== 201 || inviteToken === undefined) {
      throw new Error(
        `invite status=${invite.status} body=${JSON.stringify(invite.body).slice(0, 160)}`,
      )
    }
    const accepted = await api<{ data?: { userId?: string } }>('POST', '/api/v1/invites/accept', {
      token: inviteToken,
      username: 'smoke2',
      displayName: 'Smoke Two',
      password: MEMBER_PASSWORD,
    })
    const memberCookie = accepted.cookie
    const memberUserId = accepted.body.data?.userId
    if (accepted.status !== 201 || memberCookie === undefined || memberUserId === undefined) {
      throw new Error(
        `invite accept status=${accepted.status} body=${JSON.stringify(accepted.body).slice(0, 160)}`,
      )
    }
    const members = await api<{ data?: Array<{ userId?: string; enabled?: boolean }> }>(
      'GET',
      '/api/v1/team/members',
      undefined,
      cookie,
    )
    const memberCount = (members.body.data ?? []).filter((m) => m.enabled !== false).length
    if (memberCount !== 2) throw new Error(`成员数=${memberCount}（期望 2）`)
    phase('invite + accept (2nd member)')

    // ② 第二位成员的第二台设备 + 第二个 Workspace（03 §2.4：路径只在本机）。
    const code2 = await api<{ data?: { code?: string } }>(
      'POST',
      '/api/v1/devices/pairing-codes',
      {},
      memberCookie,
    )
    const pairing2 = code2.body.data?.code
    if (code2.status !== 201 || pairing2 === undefined)
      throw new Error(`2nd pairing-code status=${code2.status}`)
    const home2 = mkdtempSync(join(tmpdir(), 'wp-smoke-home2-'))
    homes.push(home2)
    const pair2 = runNodeCli(['pair', '--hub', publicOrigin, '--code', pairing2], home2)
    if ((await new Promise<number | null>((r) => pair2.child.on('exit', r))) !== 0) {
      throw new Error(`2nd node cli pair 非零退出\n${pair2.tail()}`)
    }
    const wsDir2 = mkdtempSync(join(tmpdir(), 'wp-smoke-ws2-'))
    wsDirs.push(wsDir2)
    mkdirSync(join(wsDir2, '.git'), { recursive: true })
    const add2 = runNodeCli(['workspace', 'add', wsDir2, '--name', 'smoke-ws-b'], home2)
    if ((await new Promise<number | null>((r) => add2.child.on('exit', r))) !== 0) {
      throw new Error(`2nd workspace add 非零退出\n${add2.tail()}`)
    }
    const nodeChild2 = runNodeCli(['start'], home2)
    nodeChildren.push(nodeChild2)
    const memberWs = await pollUntil(async () => {
      if (nodeChild2.child.exitCode !== null) {
        throw new Error(
          `第二台 node start 退出 code=${nodeChild2.child.exitCode}\n${nodeChild2.tail()}`,
        )
      }
      const list = await api<{ data?: WsEntry[] }>(
        'GET',
        '/api/v1/workspaces',
        undefined,
        memberCookie,
      )
      return (list.body.data ?? []).find((w) => w.name === 'smoke-ws-b')
    }, '第二台设备 60s 内未在成员视图出现 smoke-ws-b')
    phase('2nd device pair + workspace add + node start')

    // ③ Workspace 投影按 owner 过滤（03 §4）：一人不得看见另一人机器上的目录。
    //    安装面的跨成员边界——与 Q7 负向族同姿态，且此段无需任何密钥。
    const ownerView = await api<{ data?: WsEntry[] }>(
      'GET',
      '/api/v1/workspaces',
      undefined,
      cookie,
    )
    const memberView = await api<{ data?: WsEntry[] }>(
      'GET',
      '/api/v1/workspaces',
      undefined,
      memberCookie,
    )
    const ownerNames = (ownerView.body.data ?? []).map((w) => w.name)
    const memberNames = (memberView.body.data ?? []).map((w) => w.name)
    if (ownerNames.length !== 1 || ownerNames[0] !== 'smoke-ws') {
      throw new Error(`Owner 视图应恰好只有自己的 smoke-ws，实际=${JSON.stringify(ownerNames)}`)
    }
    if (memberNames.includes('smoke-ws') || !memberNames.includes('smoke-ws-b')) {
      throw new Error(`成员视图串了他人 Workspace：${JSON.stringify(memberNames)}`)
    }
    phase('workspace isolation (owner-scoped projection)')

    // ④ Agent 经真实管理 API 建（P1-17）：全新安装的 core-empty Pack 由 Setup 落库。
    const packs = await api<{ data?: Array<{ id?: string; name?: string }> }>(
      'GET',
      '/api/v1/plugin-packs',
      undefined,
      cookie,
    )
    const coreEmpty = (packs.body.data ?? []).find((p) => p.name === 'core-empty')
    if (coreEmpty?.id === undefined) {
      throw new Error(`全新安装缺 core-empty Pack：${JSON.stringify(packs.body).slice(0, 200)}`)
    }
    const agent = await api<{ data?: { id?: string } }>(
      'POST',
      '/api/v1/agents',
      {
        name: 'smoke-agent',
        persona: 'WhalePod compose 冒烟 Agent（不执行真实模型调用）。',
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        credentialSlot: 'default',
        pluginPackId: coreEmpty.id,
      },
      cookie,
    )
    const agentId = agent.body.data?.id
    if (agent.status !== 201 || agentId === undefined) {
      throw new Error(
        `agent status=${agent.status} body=${JSON.stringify(agent.body).slice(0, 200)}`,
      )
    }
    phase('core-empty pack + agent via admin API')

    // ⑤ 两位成员各自的 Task（ADR-0009 决策 6 的成员腿：指派 → 责任人受理）。
    const project = await api<{ data?: { id?: string } }>(
      'POST',
      '/api/v1/projects',
      { name: 'smoke' },
      cookie,
    )
    const projectId = project.body.data?.id
    if (project.status !== 201 || projectId === undefined) {
      throw new Error(
        `project status=${project.status} body=${JSON.stringify(project.body).slice(0, 160)}`,
      )
    }
    const createTask = async (
      title: string,
      assigneeUserId: string,
      assigneeCookie: string,
    ): Promise<string> => {
      const res = await api<{ data?: { id?: string } }>(
        'POST',
        `/api/v1/projects/${projectId}/tasks`,
        { title, assigneeUserId },
        cookie,
      )
      const taskId = res.body.data?.id
      if (res.status !== 201 || taskId === undefined) {
        throw new Error(
          `task(${title}) status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`,
        )
      }
      const acceptAssignment = await api(
        'POST',
        `/api/v1/tasks/${taskId}/accept`,
        {},
        assigneeCookie,
      )
      if (acceptAssignment.status !== 200) {
        throw new Error(
          `task(${title}) accept status=${acceptAssignment.status} ` +
            `body=${JSON.stringify(acceptAssignment.body).slice(0, 160)}`,
        )
      }
      return taskId
    }
    const memberTaskId = await createTask('member run', memberUserId, memberCookie)
    const ownerTaskId = await createTask('owner run', ownerUserId, cookie)
    phase('project + tasks + assignments accepted')

    // ⑥ 起 Run：每人在自己机器、自己 Workspace 上各起一个。终态断言是**诚实失败**
    //    MODEL_CREDENTIAL_UNAVAILABLE（本机未配模型凭证）——证明安装面把 Run 送到
    //    Node、走到 Runtime 启动前一步，缺凭证时给出明确失败码与摘要（不静默挂起、
    //    不谎称成功）。Agent 真执行见文件头 B 段。
    const startRunAtCredentialBoundary = async (
      label: string,
      actorCookie: string,
      taskId: string,
      deviceId: string,
      workspaceId: string,
    ): Promise<string> => {
      const start = await api<{ data?: { id?: string } }>(
        'POST',
        `/api/v1/tasks/${taskId}/runs`,
        { agentId, deviceId, workspaceId, prompt: `compose smoke: ${label}` },
        actorCookie,
      )
      const runId = start.body.data?.id
      if (start.status !== 201 || runId === undefined) {
        throw new Error(
          `run(${label}) start status=${start.status} body=${JSON.stringify(start.body).slice(0, 200)}`,
        )
      }
      const terminal = await pollUntil(
        async () => {
          const res = await api<{
            data?: { status?: string; failureCode?: string | null; failureSummary?: string | null }
          }>('GET', `/api/v1/runs/${runId}`, undefined, actorCookie)
          const status = res.body.data?.status
          return status === 'completed' ||
            status === 'failed' ||
            status === 'cancelled' ||
            status === 'lost'
            ? res.body.data
            : undefined
        },
        `run(${label}) 120s 内未落到终态`,
        120_000,
      )
      if (terminal.status !== 'failed' || terminal.failureCode !== 'MODEL_CREDENTIAL_UNAVAILABLE') {
        throw new Error(
          `run(${label}) 终态=${terminal.status} code=${terminal.failureCode} ` +
            '（未配凭证时必须 failed/MODEL_CREDENTIAL_UNAVAILABLE）',
        )
      }
      if (terminal.failureSummary == null) {
        throw new Error(`run(${label}) 失败但无 failureSummary（人看不到原因）`)
      }
      return runId
    }
    if (memberWs.deviceId === undefined || memberWs.workspaceId === undefined) {
      throw new Error('成员 Workspace 投影缺 deviceId/workspaceId')
    }
    if (ownerWs.deviceId === undefined || ownerWs.workspaceId === undefined) {
      throw new Error('Owner Workspace 投影缺 deviceId/workspaceId')
    }
    const memberRunId = await startRunAtCredentialBoundary(
      'member',
      memberCookie,
      memberTaskId,
      memberWs.deviceId,
      memberWs.workspaceId,
    )
    await startRunAtCredentialBoundary(
      'owner',
      cookie,
      ownerTaskId,
      ownerWs.deviceId,
      ownerWs.workspaceId,
    )
    phase('runs reach the credential boundary honestly (failed/MODEL_CREDENTIAL_UNAVAILABLE ×2)')

    // ⑦ 成员 Run 对 Owner 可见（任务房间是团队读面）：安装面不丢成员侧执行事实。
    const memberRoom = await api<{ data?: { runs?: Array<{ id?: string; status?: string }> } }>(
      'GET',
      `/api/v1/tasks/${memberTaskId}`,
      undefined,
      cookie,
    )
    const memberRunSeen = (memberRoom.body.data?.runs ?? []).find((r) => r.id === memberRunId)
    if (memberRunSeen?.status !== 'failed') {
      throw new Error(
        `Owner 视图未看到成员 Run 的 failed 终态：${JSON.stringify(memberRoom.body).slice(0, 200)}`,
      )
    }

    // ⑧ 跨成员越权反证：成员拿 Owner 的 device+Workspace 起 Run 必须被拒，且
    //    Task 上的 Run 数不变（负向断言带「不变」反证，不看「看起来失败」）。
    const runsBefore = (memberRoom.body.data?.runs ?? []).length
    const cross = await api<{ error?: { code?: string } }>(
      'POST',
      `/api/v1/tasks/${memberTaskId}/runs`,
      {
        agentId,
        deviceId: ownerWs.deviceId,
        workspaceId: ownerWs.workspaceId,
        prompt: 'cross-member attempt',
      },
      memberCookie,
    )
    if (cross.status < 400 || cross.status >= 500) {
      throw new Error(
        `跨成员起 Run 应被 4xx 拒绝，实际 status=${cross.status} ` +
          `body=${JSON.stringify(cross.body).slice(0, 200)}`,
      )
    }
    const roomAfter = await api<{ data?: { runs?: unknown[] } }>(
      'GET',
      `/api/v1/tasks/${memberTaskId}`,
      undefined,
      cookie,
    )
    const runsAfter = (roomAfter.body.data?.runs ?? []).length
    if (runsAfter !== runsBefore) {
      throw new Error(`被拒的跨成员起 Run 仍新增 Run：${runsBefore} → ${runsAfter}`)
    }
    phase(`cross-member run start refused (${cross.body.error?.code ?? 'no-code'})`)

    const total = ((Date.now() - startedAt) / 1000).toFixed(1)
    process.stdout.write(
      `[compose-smoke] PASS total=${total}s phases=${JSON.stringify(phaseLog)}\n`,
    )
  } finally {
    for (const nodeProcess of nodeChildren) nodeProcess.child.kill('SIGKILL')
    if (up) {
      try {
        await compose(['down', '-v', '--remove-orphans'])
      } catch (error) {
        process.stderr.write(
          `[compose-smoke] component=harness.smoke down 失败（需人工清 ${project}）: ${String(error)}\n`,
        )
      }
    }
    for (const dir of homes) rmSync(dir, { recursive: true, force: true })
    for (const dir of wsDirs) rmSync(dir, { recursive: true, force: true }) // 一审 nit：临时目录全数收尸
    rmSync(envDir, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `[compose-smoke] FAIL component=hub.smoke ${String(error)}\nphases=${JSON.stringify(phaseLog)}\n`,
  )
  process.exitCode = 1
})
