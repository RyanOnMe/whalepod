/**
 * P1-08 Browser 实时链路组合根（02 Task 8 Files）。
 *
 * 在 `/ws/v1` 前缀下挂载 `GET /client?cursor=<event-id>`，并在 Fastify 实例上
 * decorate `realtime`（live delta 注入面：P1-13 run 模块 publish，测试经它驱动）。
 * Hub WS 握手自校验（Session Cookie + Origin）、回放与订阅分发见各模块文件。
 */
import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { Database } from '@project311/db'
import { TeamEventStore } from './team-event-store.js'
import { createRealtimeHub, DEFAULT_POLL_INTERVAL_MS } from './subscriptions.js'
import type { RealtimeHub } from './subscriptions.js'
import { createClientWsAuth, createClientWsHandler } from './client-websocket.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** P1-08 live delta 注入面：仅 owner 连接可收到对应 run 的帧。 */
    readonly realtime: RealtimeHub
  }
}

export interface RealtimeRoutesDeps {
  readonly database: Database
  readonly publicOrigin: string
  readonly pollIntervalMs?: number
  readonly now?: () => Date
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  deps: RealtimeRoutesDeps,
): RealtimeHub {
  const store = new TeamEventStore(
    deps.database.db,
    deps.now === undefined ? {} : { now: deps.now },
  )
  const hub = createRealtimeHub({
    store,
    pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  app.decorate('realtime', hub)

  // @fastify/websocket 是 fastify-plugin：其 onRoute 钩子会对后续注册的
  // `websocket: true` 路由做升级接线；必须先于 realtime 路由注册。
  void app.register(fastifyWebsocket)
  void app.register(
    async (ws) => {
      const auth = createClientWsAuth(deps)
      ws.addHook('onRequest', auth.hook)
      const handler = createClientWsHandler({
        store,
        hub,
        actorOf: auth.actorOf,
        cursorOf: auth.cursorOf,
        warn: (request, message, context) =>
          request.log.warn({ component: 'hub.realtime', ...context }, message),
      })
      ws.get('/client', { websocket: true }, handler)
    },
    { prefix: '/ws/v1' },
  )

  app.addHook('onClose', async () => {
    hub.close()
  })
  return hub
}
