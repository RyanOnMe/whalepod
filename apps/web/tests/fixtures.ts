/**
 * HTTP 层 mock（02 Task 7 Step 1：Tests mock 掉 HTTP 层，从用户视角断言 UI）。
 * 真实 fetch 被替换为按 (method, url) 匹配的 handler；envelope 形状与 Hub 一致
 * （{ ok:true, data } / { ok:false, error:{ code, message, requestId } }）。
 */
import { vi } from 'vitest'
import type { PluginPackView } from '@project311/protocol'
import type {
  AgentView,
  CommentView,
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
