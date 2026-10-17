/**
 * Hub 应用级测试脚手架（#183 拆耦合第 1 步）：经 `@whalepod/hub/testing` 子路径导出。
 *
 * 为什么放在 `src/` 而不是 `tests/`：`apps/node` 的 integration spec 需要「起一个真 Hub
 * 应用、走 HTTP inject 完成 Setup/配对」——那是**跨应用**的测试支撑，借道
 * `../../../hub/tests/helpers.js` 相对路径会把 hub 源码拖进 node 的 typecheck program。
 * 与 `@whalepod/db` 公开导出 `insertTeam`/`insertUser` 等建场脚手架同型：测试支撑进
 * src、由包导出，而不是让别的应用去 relative-import 测试内部文件。
 *
 * 边界：本目录**不得** import `@whalepod/testkit`（`apps/hub/` 的依赖表只允许
 * domain/protocol/db）——需要 testkit 的脚手架（FakeClock/FakeDeviceGateway/本地
 * harness）留在 `apps/hub/tests/helpers.ts`。
 *
 * 出口：`@whalepod/hub/testing`（package.json 的 `./testing`）。测试进程必须与它
 * 驱动的东西**同一份模块图**：integration spec 里还有 `hub/src/modules/...` 的深模块
 * 相对 import（`vi.spyOn(nodeConnections, 'attach')` 这类要观测的就是那个实例），
 * 所以 exports 里给了 `development → src`（与 `@whalepod/testkit` 同型）——vitest 下
 * 拿到源码，类型来自 dist 声明，生产路径仍走 dist。
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { OutgoingHttpHeaders } from 'node:http'
import type { FastifyInstance } from 'fastify'
import type { Database } from '@whalepod/db'
import { buildApp } from '../app.js'
import type { HubConfig } from '../config.js'

/** 捕获 hub 审计事件（component=hub.audit 的结构化日志行）。 */
export interface AuditEvent {
  component: string
  action: string
  actor: string
  outcome: string
  requestId: string
}

/** 捕获 hub warn 级结构化日志（带 component 的非审计行）；供告警计数断言（#55 迁移告警）。 */
export interface WarnEvent {
  readonly component: string
  readonly msg: string
}

class AuditStream extends Writable {
  readonly events: AuditEvent[] = []
  readonly warnings: WarnEvent[] = []

  override _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const entry = JSON.parse(trimmed) as {
          component?: string
          level?: number
          msg?: string
        } & AuditEvent
        if (entry.component === 'hub.audit') this.events.push(entry)
        else if (
          entry.level === 40 &&
          typeof entry.component === 'string' &&
          typeof entry.msg === 'string'
        ) {
          this.warnings.push({ component: entry.component, msg: entry.msg })
        }
      } catch {
        // 非 JSON 行（启动横幅等）忽略
      }
    }
    callback()
  }
}

export interface TestApp {
  readonly app: FastifyInstance
  readonly database: Database
  readonly origin: string
  readonly setupToken: string
  readonly setupTokenPath: string
  readonly auditEvents: AuditEvent[]
  readonly warnEvents: WarnEvent[]
  readonly config: HubConfig
  close(): Promise<void>
}

export interface TestAppOptions {
  /** 默认 http://localhost:4242（Secure=false 分支）；换 https origin 走 Secure=true 分支。 */
  readonly origin?: string
  readonly rateLimit?: HubConfig['rateLimit']
  /** #113：反代形态开关（透传 fastify trustProxy；默认 false = 直连形态）。 */
  readonly trustProxy?: boolean
  /** #183：Plugin Catalog / dev 模式（plugin-catalog、plugin-pack 两个 spec 需要 fixture 目录）。 */
  readonly pluginCatalogDir?: string
  readonly pluginDevMode?: boolean
}

export async function createTestApp(
  database: Database,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const origin = options.origin ?? 'http://localhost:4242'
  const dir = await mkdtemp(join(tmpdir(), 'wp-hub-test-'))
  const setupTokenPath = join(dir, 'setup-token')
  const setupToken = randomBytes(32).toString('base64url')
  await writeFile(setupTokenPath, setupToken, { mode: 0o600 })
  const audit = new AuditStream()
  const config: HubConfig = {
    publicOrigin: origin,
    databaseUrl: '',
    setupTokenPath,
    host: '127.0.0.1',
    port: 0,
    // P1-15：Artifact Store 与 setup token 同一个一次性临时目录。
    artifactStoreDir: join(dir, 'artifact-store'),
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.pluginCatalogDir !== undefined
      ? { pluginCatalogDir: options.pluginCatalogDir }
      : {}),
    ...(options.pluginDevMode ? { pluginDevMode: true as const } : {}),
  }
  const app = await buildApp({
    config,
    database,
    logger: { level: 'info', stream: audit },
  })
  return {
    app,
    database,
    origin,
    setupToken,
    setupTokenPath,
    auditEvents: audit.events,
    warnEvents: audit.warnings,
    config,
    close: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 驱动助手：全部走 HTTP inject，不抄近道。
// ---------------------------------------------------------------------------

export interface Session {
  readonly cookie: string
  readonly userId: string
}

export function idemKey(): string {
  return randomBytes(16).toString('hex')
}

/**
 * inject 结果面（只暴露测试真正用到的部分）：本目录进 hub 的声明产物（dist/testing），
 * 而 fastify 的 inject 返回类型来自传递依赖 light-my-request——直接让它推断会 TS2883
 * （声明里出现无法命名的外部类型）。显式收窄成可移植结构，测试用到的字段一个不少。
 */
export interface InjectResponse {
  readonly statusCode: number
  readonly body: string
  readonly headers: OutgoingHttpHeaders
  /**
   * 默认类型参数与上游 light-my-request 的 `json<T = any>()` 一致：本目录是脚手架，
   * 归位到 src 不该让既有 spec 的读法（`res.json().data.x`）全线需要注解——
   * 那会把「测试代码类型正确」的信号淹没在噪声里（#183 的本意正相反）。
   */
  json<T = any>(): T
}

/** 已认证的 HTTP inject：带 Origin、Cookie 与 Idempotency-Key（GET 也会带上，无害）。 */
export async function apiInject(
  ctx: TestApp,
  session: Session,
  opts: { method: string; url: string; payload?: object; idempotencyKey?: string },
): Promise<InjectResponse> {
  return ctx.app.inject({
    method: opts.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: opts.url,
    headers: {
      origin: ctx.origin,
      cookie: session.cookie,
      'idempotency-key': opts.idempotencyKey ?? idemKey(),
    },
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  })
}

/** 从 set-cookie 头提取 whalepod_session 的 Cookie 请求头值。 */
export function extractSessionCookie(setCookie: string | string[] | number | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (typeof header !== 'string') throw new Error('response 缺少 set-cookie')
  const pair = header.split(';')[0]
  if (pair === undefined || !pair.startsWith('whalepod_session=')) {
    throw new Error(`set-cookie 不含 whalepod_session：${header}`)
  }
  return pair
}

/** G1-01 驱动：完成首次 Setup，返回 Owner 会话。 */
export async function driveSetup(ctx: TestApp, username = 'alice'): Promise<Session> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      setupToken: ctx.setupToken,
      teamName: 'Acme',
      username,
      displayName: 'Alice',
      password: 'correct horse battery staple',
    },
  })
  if (response.statusCode !== 201) {
    throw new Error(`setup 失败：${response.statusCode} ${response.body}`)
  }
  const body = response.json() as { ok: true; data: { userId: string } }
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: body.data.userId }
}

/** 登录驱动。 */
export async function driveLogin(
  ctx: TestApp,
  username: string,
  password: string,
): Promise<Session> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: { username, password },
  })
  if (response.statusCode !== 200) {
    throw new Error(`login 失败：${response.statusCode} ${response.body}`)
  }
  const body = response.json() as { ok: true; data: { userId: string } }
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: body.data.userId }
}

/** G1-03 驱动：actor 创建邀请，新用户接受邀请，返回新会话与邀请 Token。 */
export async function driveInviteAndAccept(
  ctx: TestApp,
  actor: Session,
  invitee: { username: string; displayName: string; password: string },
  role: 'admin' | 'member' = 'member',
): Promise<{ session: Session; inviteToken: string; inviteId: string }> {
  const createResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/invites',
    headers: {
      origin: ctx.origin,
      'idempotency-key': idemKey(),
      cookie: actor.cookie,
    },
    payload: { role },
  })
  if (createResponse.statusCode !== 201) {
    throw new Error(`create invite 失败：${createResponse.statusCode} ${createResponse.body}`)
  }
  const created = createResponse.json() as {
    ok: true
    data: { inviteId: string; token: string }
  }
  const acceptResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/invites/accept',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      token: created.data.token,
      username: invitee.username,
      displayName: invitee.displayName,
      password: invitee.password,
    },
  })
  if (acceptResponse.statusCode !== 201) {
    throw new Error(`accept invite 失败：${acceptResponse.statusCode} ${acceptResponse.body}`)
  }
  const accepted = acceptResponse.json() as { ok: true; data: { userId: string } }
  return {
    session: {
      cookie: extractSessionCookie(acceptResponse.headers['set-cookie']),
      userId: accepted.data.userId,
    },
    inviteToken: created.data.token,
    inviteId: created.data.inviteId,
  }
}
