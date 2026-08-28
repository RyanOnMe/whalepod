/**
 * Node 出站 WebSocket（/ws/v1/node；02 Task 9 Step 4/5，03 §6）。
 *
 * 升级前认证：Authorization: Device <token>（SHA-256 比对、拒绝已撤销），
 * 失败在升级前以 401 HTTP 应答。连接后每条上行帧过 parseNodeFrame fail-closed：
 * - node.hello：回填 #37 运行时事实列（dsh 版本/pack digests）；
 * - 其余（heartbeat/command.ack/run.event/run.snapshot）：统一交
 *   RunOrchestrator.ingestNodeEvent——它先刷 lastSeenAt 再按帧类型迁移
 *   Run/租约活动投影，本层不重复该职责。
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '@project311/db'
import { findDeviceByTokenHash, setDeviceHelloFacts, touchDeviceLastSeenAt } from '@project311/db'
import { parseNodeFrame } from '@project311/protocol'
import type { RunOrchestrator } from '../run/orchestrator.js'
import type { AuthenticatedDevice } from '../run/device-gateway.js'
import { hashToken } from '../auth/token.js'
import { nodeConnections } from './connection-registry.js'
import { WorkspaceInventoryIngest } from './inventory.js'
import { WebSocket } from 'ws'

export interface NodeWebsocketDeps {
  readonly database: Database
  readonly orchestrator: RunOrchestrator
}

interface DeviceUpgradeRequest extends FastifyRequest {
  device?: AuthenticatedDevice
}

function extractBearerDeviceToken(request: FastifyRequest): string {
  const header = request.headers.authorization
  if (typeof header !== 'string') return ''
  const prefix = 'Device '
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : ''
}

export function registerNodeWebsocket(app: FastifyInstance, deps: NodeWebsocketDeps): void {
  const inventoryIngest = new WorkspaceInventoryIngest({
    database: deps.database,
    warn: (message, context) => app.log.warn({ component: 'hub.node-ws', ...context }, message),
  })
  app.get(
    '/ws/v1/node',
    {
      websocket: true,
      async onRequest(request: FastifyRequest, reply: FastifyReply) {
        const token = extractBearerDeviceToken(request)
        const device =
          token === '' ? undefined : await findDeviceByTokenHash(deps.database.db, hashToken(token))
        if (device === undefined || device.revokedAt !== null) {
          return reply.code(401).send({
            ok: false,
            error: {
              code: 'INVALID_CREDENTIALS',
              message: 'invalid or revoked device token',
              requestId: String(request.id),
            },
          })
        }
        ;(request as DeviceUpgradeRequest).device = {
          deviceId: device.id,
          ownerUserId: device.ownerUserId,
        }
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const identity = (request as DeviceUpgradeRequest).device
      if (identity === undefined) return // onRequest 已 401；防御分支。
      nodeConnections.attach({ ...identity, socket })

      const handleUpstream = async (raw: string): Promise<void> => {
        try {
          const frame = parseNodeFrame(JSON.parse(raw), 'upstream')
          if (frame.type === 'node.inventory' && frame.payload.deviceId === identity.deviceId) {
            // inventory：先刷 lastSeenAt（与 hello/heartbeat 同职责，不动 #37 事实列），
            // 再做投影 upsert。
            await touchDeviceLastSeenAt(deps.database.db, identity.deviceId)
            await inventoryIngest.ingest(identity, frame.payload)
            return
          }
          if (frame.type === 'node.hello' && frame.payload.deviceId === identity.deviceId) {
            await setDeviceHelloFacts(deps.database.db, identity.deviceId, {
              dshDistributionVersion: frame.payload.dshDistributionVersion,
              pluginPackDigests: [...frame.payload.pluginPackDigests],
              lastSeenAt: new Date(),
            })
          }
          await deps.orchestrator.ingestNodeEvent(identity, frame)
        } catch (error) {
          // fail-closed：协议错误/未知帧/越权载荷一律断开，不给半解析数据留通道。
          request.log.warn(
            {
              component: 'hub.node-ws',
              deviceId: identity.deviceId,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            },
            'node upstream frame rejected',
          )
          if (socket.readyState === socket.OPEN) socket.close(4003, 'protocol violation')
          nodeConnections.detach(identity.deviceId, socket)
        }
      }

      socket.on('message', (raw: unknown) => {
        void handleUpstream(String(raw))
      })
    },
  )
}

/** 供测试/运维构造合法上行帧（与 Node 端同形）。 */
export function buildUpstreamFrame(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  })
}
