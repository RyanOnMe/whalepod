/**
 * P1-08 Browser WS `/ws/v1/client` 握手自校验与连接处理（02 Task 8 Step 3/4、03 §5）。
 *
 * - 握手在升级前完成：Session Cookie 复用 auth/session `resolveSession`；Origin
 *   与 config.publicOrigin 严格相等（04 §6.2：无 Cookie、过期 Cookie、错误 Origin 不能升级）。
 * - 回放 `store.listAfter(cursor, highWater)` 后切 live（02 Step 3 伪代码交接点：
 *   订阅从 highWater 之后开始轮询，避免回放与轮询重复/缺隙）。
 * - 单连接待发持久事件 >1000 条或 >4MiB：先发 control `resync.required` 再 close 4009，
 *   客户端重新查询 Project/Task Room HTTP 快照（02 Task 8 Step 4、R2/R3）。
 */
import type { FastifyRequest } from 'fastify'
import WebSocket from 'ws'
import type { Database } from '@project311/db'
import { ClientFrameSchema } from '@project311/protocol'
import { ApiError } from '../shared/http-error.js'
import { resolveSession, SESSION_COOKIE } from '../auth/session.js'
import type { SessionActor } from '../auth/session.js'
import type { TeamEventStore } from './team-event-store.js'
import { buildPersistentWire } from './team-event-store.js'
import type { RealtimeHub, RealtimeSubscription } from './subscriptions.js'
import { eventVisibleTo } from './subscriptions.js'

/** 待发超压/过期 cursor 的关闭码（04 R2/R3 交期待发补洞的失败判据）。 */
export const CLOSE_RESYNC = 4009
/** 单连接待发持久事件上限（02 Task 8 Step 4）。 */
export const MAX_PENDING_EVENTS = 1000
/** 单连接待发持久事件字节上限（02 Task 8 Step 4）。 */
export const MAX_PENDING_BYTES = 4 * 1024 * 1024
/** 排水水位：socket 已排队量低于该值才继续发送，留出背压探测余量。 */
const DRAIN_WATERMARK_BYTES = 512 * 1024
/** bigserial 最大 19 位十进制；超出直接拒绝（400），不解析。 */
const CURSOR_PATTERN = /^(0|[1-9]\d{0,18})$/

export interface ClientWsAuth {
  readonly hook: (request: FastifyRequest) => Promise<void>
  readonly actorOf: (request: FastifyRequest) => SessionActor | undefined
  readonly cursorOf: (request: FastifyRequest) => number | undefined
}

/** 升级前握手门：Origin 严格等于 publicOrigin，Session Cookie 有效，cursor 形状合法。 */
export function createClientWsAuth(deps: {
  readonly database: Database
  readonly publicOrigin: string
}): ClientWsAuth {
  const actors = new WeakMap<FastifyRequest, SessionActor>()
  const cursors = new WeakMap<FastifyRequest, number>()

  const hook = async (request: FastifyRequest): Promise<void> => {
    // Origin gate：WS 握手是非安全上下文，Origin 缺失/不符一律 403（04 §6.1 同形态）。
    const origin = request.headers.origin
    if (typeof origin !== 'string' || origin !== deps.publicOrigin) {
      throw new ApiError(403, 'ORIGIN_REJECTED', 'origin does not match the public origin')
    }
    const token = request.cookies[SESSION_COOKIE]
    if (token === undefined || token === '') {
      throw new ApiError(401, 'AUTH_REQUIRED', 'missing session cookie')
    }
    const actor = await resolveSession(deps.database, token)
    actors.set(request, actor)

    const raw: unknown = (request.query as { cursor?: unknown }).cursor
    if (raw !== undefined && raw !== '') {
      if (typeof raw !== 'string' || !CURSOR_PATTERN.test(raw)) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'invalid cursor')
      }
    }
    cursors.set(request, raw === undefined || raw === '' ? 0 : Number(raw))
  }

  return {
    hook,
    actorOf: (request) => actors.get(request),
    cursorOf: (request) => cursors.get(request),
  }
}

export interface ClientWsHandlerDeps {
  readonly store: TeamEventStore
  readonly hub: RealtimeHub
  readonly actorOf: (request: FastifyRequest) => SessionActor | undefined
  readonly cursorOf: (request: FastifyRequest) => number | undefined
  readonly warn: (
    request: FastifyRequest,
    message: string,
    context?: Record<string, unknown>,
  ) => void
}

export function createClientWsHandler(
  deps: ClientWsHandlerDeps,
): (socket: WebSocket, request: FastifyRequest) => void {
  return (socket, request) => {
    void handleClientConnection(socket, request, deps)
  }
}

/** 待发队列 + 排水 + 超压判定（>1000 条或 >4MiB → 丢队列、请求 resync）。 */
class PendingQueue {
  private readonly frames: string[] = []
  private bytes = 0
  private dropped = false

  constructor(private readonly socket: WebSocket) {}

  enqueue(wire: string): 'accepted' | 'overflow' {
    // 连接已断/已丢弃：静默吸收，不再积压。
    if (this.dropped || this.socket.readyState !== WebSocket.OPEN) return 'accepted'
    this.frames.push(wire)
    this.bytes += Buffer.byteLength(wire)
    this.drain()
    if (this.frames.length > MAX_PENDING_EVENTS || this.bytes > MAX_PENDING_BYTES) {
      this.dropped = true
      this.frames.length = 0
      this.bytes = 0
      return 'overflow'
    }
    return 'accepted'
  }

  private drain(): void {
    while (
      this.frames.length > 0 &&
      this.socket.readyState === WebSocket.OPEN &&
      this.socket.bufferedAmount < DRAIN_WATERMARK_BYTES
    ) {
      const wire = this.frames.shift()
      if (wire !== undefined) this.socket.send(wire)
    }
  }
}

function sendControlResync(socket: WebSocket, latestCursor: number): void {
  const frame = ClientFrameSchema.parse({
    protocolVersion: 1,
    kind: 'control',
    type: 'resync.required',
    latestCursor: String(latestCursor),
  })
  // 兜底：队列处于 overflow 时已清空，control 帧直接绕过队列发（随后 close 4009）。
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

async function handleClientConnection(
  socket: WebSocket,
  request: FastifyRequest,
  deps: ClientWsHandlerDeps,
): Promise<void> {
  const actor = deps.actorOf(request)
  const cursor = deps.cursorOf(request)
  if (actor === undefined || cursor === undefined) {
    // 握手钩子已拒绝（401/403/400），这里只是防御性兜底。
    socket.close(4401)
    return
  }

  const queue = new PendingQueue(socket)
  let subscription: RealtimeSubscription | undefined
  try {
    // 02 Step 3 伪代码：先取 high-water mark，回放只补到它为止，随后订阅从它之后开始。
    const highWater = await deps.store.latestCursor()
    const lastExpired = await deps.store.lastExpiredCursor()

    let replayFrom = cursor
    if (cursor > 0 && cursor <= lastExpired) {
      // R3：cursor 早于 24h 保留窗口 → 必须 resync，不猜测缺失事件。
      sendControlResync(socket, highWater)
      socket.close(CLOSE_RESYNC, 'resync.required')
      return
    }
    if (replayFrom === 0) replayFrom = lastExpired // 全新连接：只补窗口内事件

    const events = await deps.store.listAfter(replayFrom, highWater)
    const subscriber = { userId: actor.userId, role: actor.role }
    for (const event of events) {
      // 受众过滤（P1-13）：回放与轮询同一判据——owner/admin 帧不出现在无权连接。
      if (!eventVisibleTo(event, subscriber)) continue
      const wire = buildPersistentWire(event, (message, context) =>
        deps.warn(request, message, context),
      )
      if (wire === null) {
        continue
      }
      if (queue.enqueue(wire) === 'overflow') {
        // latestCursor 用连接时 high-water：即“本应补发到的位置”，客户端据此重查快照。
        sendControlResync(socket, highWater)
        socket.close(CLOSE_RESYNC, 'resync.required')
        return
      }
    }

    if (socket.readyState !== WebSocket.OPEN) return

    subscription = deps.hub.subscribe({
      userId: actor.userId,
      role: actor.role,
      sink: (wire) => {
        const status = queue.enqueue(wire)
        if (status === 'overflow') {
          // 直播期背压超限：同样 resync + 4009，客户端重新拉 HTTP 快照。
          sendControlResync(socket, highWater)
          socket.close(CLOSE_RESYNC, 'resync.required')
        }
        return status
      },
    })
    socket.on('close', () => subscription?.stop())
    subscription.startFrom(highWater)
  } catch (error) {
    deps.warn(request, 'client websocket handling failed', {
      errorName: error instanceof Error ? error.name : String(error),
    })
    socket.close(1011)
  }
}
