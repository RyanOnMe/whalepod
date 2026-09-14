/**
 * HTTP 层 mock（02 Task 7 Step 1：Tests mock 掉 HTTP 层，从用户视角断言 UI）。
 * 真实 fetch 被替换为按 (method, url) 匹配的 handler；envelope 形状与 Hub 一致
 * （{ ok:true, data } / { ok:false, error:{ code, message, requestId } }）。
 */
import { vi } from 'vitest'
import type { PluginPackView, TeamMemberView } from '@whalepod/protocol'
import type {
  AgentView,
  CommentView,
  DeviceView,
  InviteDetailsView,
  PairingCodeView,
  ProjectView,
  Session,
  TaskRoomArtifact,
  TaskRoomRun,
  TaskView,
} from '../src/shared/api/types.js'

export const ALICE: Session = {
  userId: 'aaaaaaaa-0000-4000-8000-000000000001',
  username: 'alice',
  displayName: 'Alice',
  role: 'owner',
}

export const BOB: Session = {
  userId: 'bbbbbbbb-0000-4000-8000-000000000002',
  username: 'bob',
  displayName: 'Bob',
  role: 'member',
}

export const TEAM_ID = 'cccccccc-0000-4000-8000-000000000003'

export interface MockResponse {
  status: number
  body: unknown
}

export interface MockHandler {
  method: string
  url: RegExp
  /** 返回 MockResponse = JSON envelope；直接返回 Response = 原样透传（二进制下载用）。 */
  respond: (init: RequestInit) => MockResponse | Response | Promise<MockResponse | Response>
}

export function ok(data: unknown): MockResponse {
  return { status: 200, body: { ok: true, data } }
}

export function created(data: unknown): MockResponse {
  return { status: 201, body: { ok: true, data } }
}

export function apiFailure(
  code: string,
  message: string,
  requestId = 'req-test-0001',
): MockResponse {
  return { status: 409, body: { ok: false, error: { code, message, requestId } } }
}

export function unauthorized(): MockResponse {
  return apiFailure('AUTH_REQUIRED', 'login required', 'req-test-auth-0001')
}

/** 替换全局 fetch：无匹配 handler 时抛错，用例不会静默通过。 */
export function installFetch(handlers: readonly MockHandler[]): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const requestInit = init ?? {}
    for (const handler of handlers) {
      if (handler.method === method && handler.url.test(url)) {
        const response = await handler.respond(requestInit)
        // Response 实例：raw 透传（P1-15 Artifact 内容下载等二进制面）。
        if (response instanceof Response) return response
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    throw new Error(`[mock-http] no handler for ${method} ${url}`)
  })
  vi.stubGlobal('fetch', impl)
  return impl
}

export function initOf(call: [RequestInfo | URL, RequestInit?]): RequestInit {
  return call[1] ?? {}
}

// ---------------------------------------------------------------------------
// 持久 fixture 生成器（幂等 id，避免用例间 UUID 波动）
// ---------------------------------------------------------------------------

let seq = 0

function nextId(): string {
  seq += 1
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

export function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: nextId(),
    projectId: '11111111-0000-4000-8000-000000000001',
    title: 'Ship first artifact',
    description: '发布第一个版本的实现',
    status: 'open',
    assigneeUserId: BOB.userId,
    assignmentStatus: 'pending',
    createdBy: ALICE.userId,
    acceptedAt: null,
    completedAt: null,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

export function makeComment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: nextId(),
    taskId: 'task',
    authorUserId: ALICE.userId,
    body: '默认留言内容',
    // #185：默认造一条**讨论**消息（服务端的默认值同形）。指令/追问形态由用例显式覆盖。
    kind: 'discussion',
    origin: 'human',
    targetAgentId: null,
    runId: null,
    instructionState: null,
    instructionErrorCode: null,
    instructionErrorMessage: null,
    createdAt: '2026-08-25T01:00:00.000Z',
    editedAt: null,
    ...overrides,
  }
}

export function makeRun(overrides: Partial<TaskRoomRun> = {}): TaskRoomRun {
  return {
    id: nextId(),
    status: 'running',
    createdAt: '2026-08-25T02:00:00.000Z',
    startedAt: '2026-08-25T02:00:05.000Z',
    finishedAt: null,
    rerunOfRunId: null,
    ...overrides,
  }
}

export function makeArtifact(overrides: Partial<TaskRoomArtifact> = {}): TaskRoomArtifact {
  return {
    id: nextId(),
    runId: 'run',
    ownerUserId: BOB.userId,
    title: 'security-review.md',
    mediaType: 'text/markdown',
    byteSize: 2048,
    sha256: 'd'.repeat(64),
    status: 'published',
    createdAt: '2026-08-25T03:00:00.000Z',
    publishedAt: '2026-08-25T03:05:00.000Z',
    ...overrides,
  }
}

export function makeDevice(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: nextId(),
    name: 'm4-mini',
    platform: 'darwin',
    status: 'online',
    dshDistributionVersion: null,
    lastSeenAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 路由级 handler
// ---------------------------------------------------------------------------

export function setupStatusHandler(initialized: boolean): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/setup\/status$/, respond: () => ok({ initialized }) }
}

export function sessionHandler(session: Session | 'unauthorized'): MockHandler {
  return {
    method: 'GET',
    url: /\/api\/v1\/auth\/session$/,
    respond: () => (session === 'unauthorized' ? unauthorized() : ok(session)),
  }
}

/** 登录前 401、登录后返回会话的可变 session handler。 */
export function sessionSwitchHandler(session: Session): {
  handler: MockHandler
  flip: () => void
  reset: () => void
} {
  let current: Session | 'unauthorized' = 'unauthorized'
  return {
    handler: {
      method: 'GET',
      url: /\/api\/v1\/auth\/session$/,
      respond: () => (current === 'unauthorized' ? unauthorized() : ok(current)),
    },
    flip: () => {
      current = session
    },
    reset: () => {
      current = 'unauthorized'
    },
  }
}

/**
 * 可变 setup/status：POST /setup 成功后 initialized 翻转（Setup 完成 → 进入主站）。
 * 与真实 Hub 一致（POST /setup 会下发 Owner 的 Session Cookie），onSetup 由用例
 * 用来同时翻转 auth/session 桩（如 sessionSwitchHandler.flip）。
 */
export function setupFlow(onSetup?: () => void): {
  statusHandler: MockHandler
  setupHandler: MockHandler
} {
  let initialized = false
  return {
    statusHandler: {
      method: 'GET',
      url: /\/api\/v1\/setup\/status$/,
      respond: () => ok({ initialized }),
    },
    setupHandler: {
      method: 'POST',
      url: /\/api\/v1\/setup$/,
      respond: () => {
        initialized = true
        onSetup?.()
        return created({ teamId: TEAM_ID, userId: 'aaaaaaaa-0000-4000-8000-000000000001' })
      },
    },
  }
}

export function loginHandler(session: Session, onLogin?: () => void): MockHandler {
  return {
    method: 'POST',
    url: /\/api\/v1\/auth\/login$/,
    respond: () => {
      onLogin?.()
      return ok(session)
    },
  }
}

export function setupHandler(session: Session, onInitialized?: () => void): MockHandler {
  return {
    method: 'POST',
    url: /\/api\/v1\/setup$/,
    respond: () => {
      onInitialized?.()
      return created({ teamId: TEAM_ID, userId: session.userId })
    },
  }
}

export function logoutHandler(): MockHandler {
  return { method: 'POST', url: /\/api\/v1\/auth\/logout$/, respond: () => ok({}) }
}

export function projectsHandler(projects: ProjectView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/projects$/, respond: () => ok(projects) }
}

/**
 * #136/#141 GET /team/members mock：默认给出 Alice(owner) + Bob(member) 两条未停用成员。
 * 形态与 Hub 一致：**data 即数组**（`TeamMemberViewsSchema`），不包 `{ members }`；
 * 类型来自 `@whalepod/protocol`（本仓响应面 schema 的唯一来源）。
 */
export function teamMembersHandler(members?: TeamMemberView[]): MockHandler {
  return {
    method: 'GET',
    url: /\/api\/v1\/team\/members$/,
    respond: () => ok(members ?? [makeMember(), makeMember({ ...BOB, role: BOB.role })]),
  }
}

export function createProjectHandler(createdProject: ProjectView): MockHandler {
  return {
    method: 'POST',
    url: /\/api\/v1\/projects$/,
    respond: () => created(createdProject),
  }
}

export function createTaskHandler(createdTask: TaskView): MockHandler {
  return {
    method: 'POST',
    url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
    respond: () => created(createdTask),
  }
}

/** GET /tasks/:taskId 的 Task Room 聚合。 */
export function taskRoomHandler(
  task: TaskView,
  extras: { comments?: CommentView[]; runs?: TaskRoomRun[]; artifacts?: TaskRoomArtifact[] } = {},
): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${task.id}$`),
    respond: () =>
      ok({
        task,
        comments: extras.comments ?? [],
        runs: extras.runs ?? [],
        artifacts: extras.artifacts ?? [],
      }),
  }
}

export function commentHandler(taskId: string, comment: CommentView): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/tasks/${taskId}/comments$`),
    respond: () => created(comment),
  }
}

export function acceptHandler(task: TaskView): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/tasks/${task.id}/accept$`),
    respond: () =>
      ok({ ...task, assignmentStatus: 'accepted', acceptedAt: '2026-08-26T00:00:00.000Z' }),
  }
}

export function rejectHandler(task: TaskView): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/tasks/${task.id}/reject$`),
    respond: () => ok({ ...task, assignmentStatus: 'rejected' }),
  }
}

export function agentsHandler(agents: AgentView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/agents$/, respond: () => ok(agents) }
}

export function createAgentHandler(createdAgent: AgentView): MockHandler {
  return { method: 'POST', url: /\/api\/v1\/agents$/, respond: () => created(createdAgent) }
}

/** GET /plugin-packs：Pack 列表（Agent 表单的 Pack 下拉数据源，P1-17）。 */
export function packsHandler(packs: PluginPackView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/plugin-packs$/, respond: () => ok(packs) }
}

// ---------------------------------------------------------------------------
// #141 邀请链（成员页 / 接受页）。以下均为**新增** export：既有 handler 签名不动。
// ---------------------------------------------------------------------------

/** 邀请 Token 的测试取值（32 字节随机串的形态与长度，非真实 Token）。 */
export const INVITE_TOKEN = 'invite-token-for-tests-0000000000000000'

/** GET /team：单 Team 基本信息（接受页/成员页的团队名来源）。 */
export function teamHandler(name: string): MockHandler {
  return {
    method: 'GET',
    url: /\/api\/v1\/team$/,
    respond: () => ok({ id: TEAM_ID, name, createdAt: '2026-08-24T00:00:00.000Z' }),
  }
}

/** POST /invites：生成一次性邀请。requests 记录请求体，供断言角色选择。 */
export function createInviteHandler(invite: {
  inviteId?: string
  token?: string
  role: 'admin' | 'member'
  expiresAt?: string
}): { handler: MockHandler; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = []
  return {
    requests,
    handler: {
      method: 'POST',
      url: /\/api\/v1\/invites$/,
      respond: (init) => {
        requests.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>)
        return created({
          inviteId: invite.inviteId ?? 'invite-1',
          token: invite.token ?? INVITE_TOKEN,
          role: invite.role,
          expiresAt: invite.expiresAt ?? '2026-08-28T00:00:00.000Z',
        })
      },
    },
  }
}

/** GET /invites/:token：接受页预检。 */
export function inviteDetailsHandler(
  details: Partial<InviteDetailsView> = {},
  token: string = INVITE_TOKEN,
): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/invites/${token}$`),
    respond: () =>
      ok({
        role: details.role ?? 'member',
        teamName: details.teamName ?? 'Acme',
        expiresAt: details.expiresAt ?? '2026-08-28T00:00:00.000Z',
        expired: details.expired ?? false,
        consumed: details.consumed ?? false,
      }),
  }
}

/** GET /invites/:token 的失效形态：404 未知 Token，或 409 已用/已过期（带区分 details）。 */
export function unusableInviteHandler(
  kind: 'unknown' | 'expired' | 'consumed',
  token: string = INVITE_TOKEN,
): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/invites/${token}$`),
    respond: () =>
      kind === 'unknown'
        ? {
            status: 404,
            body: {
              ok: false,
              error: { code: 'NOT_FOUND', message: 'invite not found', requestId: 'req-inv-404' },
            },
          }
        : {
            status: 409,
            body: {
              ok: false,
              error: {
                code: 'CONFLICT',
                message: 'invite token is invalid, expired or already consumed',
                requestId: 'req-inv-409',
                details: { expired: kind === 'expired', consumed: kind === 'consumed' },
              },
            },
          },
  }
}

/** POST /invites/:token/accept：已登录一键加入。 */
export function acceptInviteAsMemberHandler(
  result: {
    role?: 'admin' | 'member'
    teamName?: string
    joined?: boolean
    alreadyMember?: boolean
  } = {},
  token: string = INVITE_TOKEN,
): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/invites/${token}/accept$`),
    respond: () =>
      ok({
        role: result.role ?? 'member',
        teamName: result.teamName ?? 'Acme',
        joined: result.joined ?? true,
        alreadyMember: result.alreadyMember ?? false,
      }),
  }
}

/** POST /invites/accept：匿名接受（接受页的「建号并加入」腿）。 */
export function acceptInviteAnonymouslyHandler(
  result: { userId?: string; role?: 'admin' | 'member' } = {},
  requests: Array<Record<string, unknown>> = [],
  /** 真实 Hub 会在本响应里下发 Session Cookie：用例用它翻转会话桩。 */
  onAccepted?: () => void,
): MockHandler {
  return {
    method: 'POST',
    url: /\/api\/v1\/invites\/accept$/,
    respond: (init) => {
      requests.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>)
      onAccepted?.()
      return created({ userId: result.userId ?? BOB.userId, role: result.role ?? 'member' })
    },
  }
}

/**
 * 成员名单 fixture（#136/#141）：字段与 `TeamMemberViewSchema` 一致——
 * `enabled` 是「未停用」的唯一判据（Hub 侧由 disabledAt 收敛，裸时间戳不出网）。
 */
export function makeMember(overrides: Partial<TeamMemberView> = {}): TeamMemberView {
  return {
    userId: ALICE.userId,
    username: ALICE.username,
    displayName: ALICE.displayName,
    role: 'owner',
    enabled: true,
    ...overrides,
  }
}

export function devicesHandler(devices: DeviceView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/devices$/, respond: () => ok(devices) }
}

/**
 * 可变设备列表（#142）：配对成功后 Hub 扇出 device.changed，event-router 失效
 * ['devices'] 触发 refetch——用例用 add 模拟「服务器那边已多了一台」，
 * calls 计 refetch 次数，证明设备是重新拉取来的，不是别处凭空出现的。
 */
export function statefulDevices(initial: DeviceView[] = []): {
  handler: MockHandler
  add: (device: DeviceView) => void
  calls: () => number
} {
  let devices = [...initial]
  let calls = 0
  return {
    handler: {
      method: 'GET',
      url: /\/api\/v1\/devices$/,
      respond: () => {
        calls += 1
        return ok([...devices])
      },
    },
    add: (device) => {
      devices = [...devices, device]
    },
    calls: () => calls,
  }
}

/** POST /devices/pairing-codes：一次性配对码（明文只在本响应出现一次）。 */
export function pairingCodeHandler(code: PairingCodeView): MockHandler {
  return {
    method: 'POST',
    url: /\/api\/v1\/devices\/pairing-codes$/,
    respond: () => created(code),
  }
}

/** 已登录页面的默认 handler 组合（setup/status + session + 页面级 extras）。 */
export function loggedInHandlers(session: Session, extra: MockHandler[] = []): MockHandler[] {
  return [setupStatusHandler(true), sessionHandler(session), ...extra]
}

/** 永不 resolve 的 handler：模拟慢请求（加载态断言）。 */
export function pendingHandler(method: string, url: RegExp): MockHandler {
  return {
    method,
    url,
    respond: () => new Promise<MockResponse>(() => undefined),
  }
}

/** 可手动触发的延迟响应：pending 态断言（按钮禁用等）。 */
export function deferredResponse(): {
  promise: Promise<MockResponse>
  resolve: (response: MockResponse) => void
} {
  let resolve!: (response: MockResponse) => void
  const promise = new Promise<MockResponse>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * 可变 Task Room：接受/留言后 refetch 返回新快照（模拟 server reconciliation，
 * 与 production 的 invalidate + refetch 语义一致）。
 */
export function statefulTaskRoom(task: TaskView): {
  handlers: MockHandler[]
  setTask: (next: TaskView) => void
  addComment: (comment: CommentView) => void
} {
  let currentTask: TaskView = { ...task }
  let comments: CommentView[] = []
  return {
    handlers: [
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => ok({ task: currentTask, comments, runs: [], artifacts: [] }),
      },
    ],
    setTask: (next) => {
      currentTask = next
    },
    addComment: (comment) => {
      comments = [...comments, comment]
    },
  }
}
