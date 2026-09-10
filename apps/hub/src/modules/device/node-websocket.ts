/**
 * Node 出站 WebSocket（/ws/v1/node；02 Task 9 Step 4/5，03 §6）。
 *
 * 升级前认证：Authorization: Device <token>（SHA-256 比对、拒绝已撤销），
 * 失败在升级前以 401 HTTP 应答。连接后每条上行帧过 parseNodeFrame fail-closed：
 * - node.hello：回填 #37 运行时事实列（dsh 版本/pack digests）；
 * - 其余（heartbeat/command.ack/run.event/run.snapshot）：统一交
 *   RunOrchestrator.ingestNodeEvent——它先刷 lastSeenAt 再按帧类型迁移
 *   Run/租约活动投影，本层不重复该职责。
 * 4003 的射程（#52/ADR-0007）：结构坏与越权 = 通道不可信 → 断开；Run 账本的
 * 语义冲突 = 单 Run 业务问题 → orchestrator Run 级收敛，连接保留。
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '@whalepod/db'
import {
  appendTeamEvent,
  findDeviceByTokenHash,
  getRun,
  runEventWatermark,
  setDeviceHelloFacts,
  touchDeviceLastSeenAt,
} from '@whalepod/db'
import { parseNodeFrame, RunEventAckSchema, RunResendFromSchema } from '@whalepod/protocol'
import type { RunOrchestrator } from '../run/orchestrator.js'
import type { AuthenticatedDevice } from '../run/device-gateway.js'
import { isRunSemanticConflict } from '../run/errors.js'
import { hashToken } from '../auth/token.js'
import { nodeConnections } from './connection-registry.js'
import { WorkspaceInventoryIngest } from './inventory.js'
import type { RealtimeHub } from '../realtime/subscriptions.js'
import { WebSocket } from 'ws'

export interface NodeWebsocketDeps {
  readonly database: Database
  readonly orchestrator: RunOrchestrator
  /** P1-13：owner-only live delta 的投递面（03 §8：不持久、非 owner 不可见）。 */
  readonly realtime: RealtimeHub
}

/** Run 终态集合（§3.2）：迟到 live delta 不转发、心跳缺口不为终态 Run 拉取。 */
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'lost'])

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
            // #142：hello 是「设备变在线」的唯一时刻（status 由 lastSeenAt 推导），
            // 与事实列回填同事务补发 device.changed——否则配对后页面停在「离线」，
            // 要等用户自己刷新才变绿。
            await deps.database.transaction(async (tx) => {
              await setDeviceHelloFacts(tx, identity.deviceId, {
                dshDistributionVersion: frame.payload.dshDistributionVersion,
                pluginPackDigests: [...frame.payload.pluginPackDigests],
                lastSeenAt: new Date(),
              })
              await appendTeamEvent(tx, {
                type: 'device.changed',
                payload: { deviceId: identity.deviceId },
              })
            })
          }
          if (frame.type === 'run.live_delta') {
            // P1-13：直播 delta 不持久——校验归属后直接投递给 owner 连接（03 §8）。
            const run = await getRun(deps.database.db, frame.payload.runId)
            if (run === undefined || run.deviceId !== identity.deviceId) {
              throw new Error('live_delta for unknown or foreign run')
            }
            if (TERMINAL.has(run.status)) return // 终态后的迟到 delta：丢，不转发
            deps.realtime.publishLive({
              runId: run.id,
              deltaSeq: frame.payload.deltaSeq,
              text: frame.payload.text,
              ownerUserId: run.ownerUserId,
            })
            return
          }
          await deps.orchestrator.ingestNodeEvent(identity, frame)
          if (frame.type === 'run.event' && socket.readyState === socket.OPEN) {
            // R6 协议侧：重复 (runId,seq) 也 ack——幂等已应用，ack 只陈述水位。
            // throughSeq 是连续水位：缺口前的最大 seq，绝不越过缺口。
            const throughSeq = await runEventWatermark(deps.database.db, frame.payload.runId)
            if (throughSeq > 0) {
              socket.send(
                JSON.stringify(
                  RunEventAckSchema.parse({
                    protocolVersion: 1,
                    messageId: randomUUID(),
                    sentAt: new Date().toISOString(),
                    type: 'run.event_ack',
                    payload: { runId: frame.payload.runId, throughSeq },
                  }),
                ),
              )
            }
          }
          if (frame.type === 'node.heartbeat' && socket.readyState === socket.OPEN) {
            // R1 协议侧：心跳上报的 Node 水位高于 Hub 连续水位 → 主动拉缺口。
            // （Node 重连也会自发 drain——这里是 Hub 视角的双保险。）
            for (const [runId, nodeSeq] of Object.entries(frame.payload.lastEventSeqByRun)) {
              const run = await getRun(deps.database.db, runId)
              if (run === undefined || run.deviceId !== identity.deviceId) continue
              if (TERMINAL.has(run.status)) continue
              const hubWatermark = await runEventWatermark(deps.database.db, runId)
              if (nodeSeq > hubWatermark) {
                socket.send(
                  JSON.stringify(
                    RunResendFromSchema.parse({
                      protocolVersion: 1,
                      messageId: randomUUID(),
                      sentAt: new Date().toISOString(),
                      type: 'run.resend_from',
                      payload: { runId, fromSeq: hubWatermark + 1 },
                    }),
                  ),
                )
              }
            }
          }
        } catch (error) {
          // ADR-0007：连接级 fail-closed 收窄到「通道不可信」——结构坏（JSON/
          // schema 不过）与越权（deviceId 不符）一律断开，不给半解析数据留通道。
          // Run 账本的语义冲突（表外越边、引用缺失）不属此类：orchestrator 已在
          // 同一事务内留证 + Run 级收敛；此处再兜一道（disposition 日志字段是
          // 违例的可观测面），防任何路径把单 Run 冲突冒泡成 4003 毒杀设备连接。
          // 判定共用 isRunSemanticConflict（run/errors.ts 单一事实源）：与
          // orchestrator 降级各写一遍，惩罚边界迟早漂移。
          const semanticConflict = isRunSemanticConflict(error)
          request.log.warn(
            {
              component: 'hub.node-ws',
              deviceId: identity.deviceId,
              errorName: error instanceof Error ? error.name : 'UnknownError',
              errorMessage: error instanceof Error ? error.message : String(error),
              disposition: semanticConflict ? 'connection-retained' : 'connection-closed',
            },
            'node upstream frame rejected',
          )
          if (semanticConflict) return
          if (socket.readyState === socket.OPEN) socket.close(4003, 'protocol violation')
          nodeConnections.detach(identity.deviceId, socket)
        }
      }

      // 逐条串行：上一帧处理完才处理下一帧——run.event 的应用顺序必须等于
      // Node 发送顺序，否则连续水位 ack 会被并发 watermark 查询饿死（P1-13 实测）。
      let chain: Promise<void> = Promise.resolve()
      socket.on('message', (raw: unknown) => {
        chain = chain.then(() => handleUpstream(String(raw)))
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
