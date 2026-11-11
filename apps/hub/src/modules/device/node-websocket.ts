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
import type { ManagedDraftHost } from '../../config.js'
import type { ManagedDraftExecution } from '../draft-share/execution.js'
import { deviceForNodeRequest, matchesManagedDraftHost } from '../draft-share/host-auth.js'
import type { ManagedDraftTransport } from '../draft-share/dispatch.js'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '@whalepod/db'
import {
  appendTeamEvent,
  getOrdinaryRun,
  getRun,
  isManagedDraftSource,
  runEventWatermark,
  setDeviceHelloFacts,
  touchDeviceLastSeenAt,
  schema,
} from '@whalepod/db'
import {
  COORDINATION_CAPABILITY,
  DISCOVERY_CAPABILITY,
  MANAGED_DRAFT_CONTROL_VERSION,
  MANAGED_DRAFT_EXECUTION_VERSION,
  parseNodeFrame,
  ProtocolError,
  RunEventAckSchema,
  RunResendFromSchema,
} from '@whalepod/protocol'
import type { RunOrchestrator } from '../run/orchestrator.js'
import type { AuthenticatedDevice } from '../run/device-gateway.js'
import { isRunSemanticConflict } from '../run/errors.js'
import { sanitizeError } from '../shared/error-log.js'
import { nodeConnections } from './connection-registry.js'
import { WorkspaceInventoryIngest } from './inventory.js'
import type { RealtimeHub } from '../realtime/subscriptions.js'
import { WebSocket } from 'ws'
import { acceptDiscoveryHeartbeat, acceptDiscoveryResult } from '../discovery/service.js'
import { acceptRouterHeartbeat, acceptRouterResult } from '../router/service.js'
import type { RouterAutoDispatch } from '../router/application.js'
import { ArtifactStore } from '../artifact/store.js'

export interface NodeWebsocketDeps {
  readonly database: Database
  readonly orchestrator: RunOrchestrator
  /** P1-13：owner-only live delta 的投递面（03 §8：不持久、非 owner 不可见）。 */
  readonly realtime: RealtimeHub
  readonly routerStore?: ArtifactStore
  readonly managedDraftHost?: ManagedDraftHost | undefined
  readonly managedDraftRequiresTls: boolean
  readonly managedDraftTransport: ManagedDraftTransport
  readonly managedDraftExecution: ManagedDraftExecution
  /** RD-03r2：结果接受后应用提案并由组合根尝试既有自动派工端口。 */
  readonly onAutoDispatch?: RouterAutoDispatch
}

/** Run 终态集合（§3.2）：迟到 live delta 不转发、心跳缺口不为终态 Run 拉取。 */
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'lost'])

interface DeviceUpgradeRequest extends FastifyRequest {
  device?: AuthenticatedDevice
  managedDraftHost?: ManagedDraftHost | undefined
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
        const device = await deviceForNodeRequest(deps.database, request)
        const host = deps.managedDraftHost
        const dedicated = host !== undefined && device?.id === host.deviceId
        const proof = request.headers['x-whalepod-managed-host']
        const verified = matchesManagedDraftHost(
          request,
          host,
          device,
          deps.managedDraftRequiresTls,
        )
        if (
          device === undefined ||
          device.revokedAt !== null ||
          ((dedicated || proof !== undefined) && !verified)
        ) {
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
        if (verified) (request as DeviceUpgradeRequest).managedDraftHost = host
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const identity = (request as DeviceUpgradeRequest).device
      if (identity === undefined) return // onRequest 已 401；防御分支。
      const managedDraftHost = (request as DeviceUpgradeRequest).managedDraftHost
      nodeConnections.attach({ ...identity, socket, managedDraftHost })

      const handleUpstream = async (raw: string): Promise<void> => {
        try {
          if (!nodeConnections.isCurrent(identity.deviceId, socket)) return
          const frame = parseNodeFrame(JSON.parse(raw), 'upstream')
          if (managedDraftHost !== undefined) {
            if (
              frame.type === 'node.hello' &&
              frame.payload.deviceId === identity.deviceId &&
              (frame.payload.dshDistributionVersion === MANAGED_DRAFT_CONTROL_VERSION ||
                frame.payload.dshDistributionVersion === MANAGED_DRAFT_EXECUTION_VERSION) &&
              frame.payload.pluginPackDigests.length === 0 &&
              !frame.payload.sourceCapabilities?.length &&
              !frame.payload.contextCapabilities?.length &&
              !frame.payload.coordinationCapabilities?.length
            ) {
              if (
                nodeConnections.markManagedDraftReady(
                  identity.deviceId,
                  socket,
                  frame.payload.dshDistributionVersion === MANAGED_DRAFT_EXECUTION_VERSION,
                )
              )
                return
              throw new Error('managed draft mode changed')
            }
            if (
              frame.type === 'node.heartbeat' &&
              frame.payload.deviceId === identity.deviceId &&
              frame.payload.activeRunIds.length === 0 &&
              Object.keys(frame.payload.lastEventSeqByRun).length === 0
            ) {
              return
            }
            if (frame.type === 'managed_draft.outcome') {
              await deps.managedDraftExecution.receive(managedDraftHost, socket, frame.payload)
              return
            }
            if (frame.type === 'command.ack') {
              const recorded = await deps.managedDraftTransport.receive(
                managedDraftHost,
                socket,
                frame.payload,
              )
              if (recorded)
                request.log.info(
                  {
                    component: 'hub.managed-draft',
                    action: 'manifest.receipt',
                    deviceId: identity.deviceId,
                    commandId: frame.payload.commandId,
                  },
                  'managed manifest received',
                )
              return
            }
            throw new Error('unsupported managed draft host frame')
          }

          if (frame.type === 'managed_draft.outcome') throw new Error('unsupported node frame')

          if (frame.type === 'discovery.heartbeat' || frame.type === 'discovery.result') {
            // Spool replay follows hello and can precede the fresh inventory on reconnect.
            if (!nodeConnections.hasDiscoveryHello(identity.deviceId, socket)) {
              // A legacy Node can replay a well-formed result from its old spool. Drop it without
              // taking down the connection used by ordinary Runs and Router.
              request.log.warn(
                {
                  component: 'hub.node-ws',
                  deviceId: identity.deviceId,
                  disposition: 'connection-retained',
                },
                'discovery frame ignored without compatible hello',
              )
              return
            }
            await touchDeviceLastSeenAt(deps.database.db, identity.deviceId)
            const discoveryDeps = {
              database: deps.database,
              ...(deps.routerStore ? { store: deps.routerStore } : {}),
              log: (event: Record<string, unknown>) => app.log.info(event, 'discovery event'),
            }
            const response =
              frame.type === 'discovery.heartbeat'
                ? await acceptDiscoveryHeartbeat(
                    discoveryDeps,
                    identity.deviceId,
                    frame.payload,
                    (model) =>
                      nodeConnections.canDispatchDiscovery(identity.deviceId, model, socket),
                  )
                : await acceptDiscoveryResult(discoveryDeps, identity.deviceId, frame.payload)
            if (response && nodeConnections.hasDiscoveryHello(identity.deviceId, socket))
              socket.send(
                JSON.stringify({
                  protocolVersion: 1,
                  messageId: randomUUID(),
                  sentAt: new Date().toISOString(),
                  type:
                    frame.type === 'discovery.heartbeat'
                      ? 'discovery.model_start_ack'
                      : 'discovery.result_ack',
                  payload: response,
                }),
              )
            return
          }
          if (frame.type === 'coordination.heartbeat' || frame.type === 'coordination.result') {
            await touchDeviceLastSeenAt(deps.database.db, identity.deviceId)
            const routerDeps = {
              database: deps.database,
              ...(deps.routerStore ? { store: deps.routerStore } : {}),
              log: (event: Record<string, unknown>) => app.log.info(event, 'router event'),
              ...(deps.onAutoDispatch === undefined ? {} : { onAutoDispatch: deps.onAutoDispatch }),
            }
            if (frame.type === 'coordination.heartbeat') {
              try {
                await acceptRouterHeartbeat(routerDeps, identity.deviceId, frame.payload)
              } catch (error) {
                app.log.warn(
                  {
                    component: 'hub.router',
                    evaluationId: frame.payload.evaluationId,
                    ...sanitizeError(error),
                  },
                  'router heartbeat rejected',
                )
              }
            } else {
              const ack = await acceptRouterResult(routerDeps, identity.deviceId, frame.payload)
              if (socket.readyState === socket.OPEN)
                socket.send(
                  JSON.stringify({
                    protocolVersion: 1,
                    messageId: randomUUID(),
                    sentAt: new Date().toISOString(),
                    type: 'coordination.result_ack',
                    payload: ack,
                  }),
                )
            }
            return
          }
          if (frame.type === 'node.preparation_result') {
            // 应答本身也是活性证据；与 heartbeat 一样刷新 lastSeenAt，避免长检查期间被判离线。
            await touchDeviceLastSeenAt(deps.database.db, identity.deviceId)
            nodeConnections.deliverPreparation(identity.deviceId, socket, frame.payload)
            return
          }
          if (frame.type === 'source.permission_result') {
            // ADR-0024 §5：有界只读检查的回报；只交给对应连接上的等待者。
            await touchDeviceLastSeenAt(deps.database.db, identity.deviceId)
            nodeConnections.deliverSourcePermission(identity.deviceId, socket, frame.payload)
            return
          }
          if (frame.type === 'node.inventory' && frame.payload.deviceId === identity.deviceId) {
            // inventory：先刷 lastSeenAt（与 hello/heartbeat 同职责，不动 #37 事实列），
            // 再做投影 upsert。
            const slots = frame.payload.coordinationCredentialSlots ?? []
            nodeConnections.setDiscoveryInventory(identity.deviceId, socket, [])
            await nodeConnections.updateDeviceFacts(identity.deviceId, socket, async () => {
              await touchDeviceLastSeenAt(deps.database.db, identity.deviceId)
              await inventoryIngest.ingest(identity, frame.payload)
              await deps.database.db
                .update(schema.devices)
                .set({
                  capabilities: sql`jsonb_set(${schema.devices.capabilities}, '{coordinationCredentialSlots}', ${JSON.stringify(slots)}::jsonb)`,
                })
                .where(eq(schema.devices.id, identity.deviceId))
              nodeConnections.setDiscoveryInventory(identity.deviceId, socket, slots)
            })
            return
          }
          if (frame.type === 'node.hello' && frame.payload.deviceId === identity.deviceId) {
            // #142：hello 是「设备变在线」的唯一时刻（status 由 lastSeenAt 推导），
            // 与事实列回填同事务补发 device.changed——否则配对后页面停在「离线」，
            // 要等用户自己刷新才变绿。
            const capabilities = frame.payload.coordinationCapabilities ?? []
            nodeConnections.setDiscoveryHello(identity.deviceId, socket, false)
            const isCurrent = await nodeConnections.updateDeviceFacts(
              identity.deviceId,
              socket,
              async () => {
                await deps.database.transaction(async (tx) => {
                  await setDeviceHelloFacts(tx, identity.deviceId, {
                    dshDistributionVersion: frame.payload.dshDistributionVersion,
                    pluginPackDigests: [...frame.payload.pluginPackDigests],
                    // hello 是能力权威集合：缺省即清空旧声明，防止升级/降级后残留。
                    sourceCapabilities: frame.payload.sourceCapabilities ?? [],
                    contextCapabilities: frame.payload.contextCapabilities ?? [],
                    coordinationCapabilities: capabilities,
                    lastSeenAt: new Date(),
                  })
                  await appendTeamEvent(tx, {
                    type: 'device.changed',
                    payload: { deviceId: identity.deviceId },
                  })
                })
                nodeConnections.setDiscoveryHello(
                  identity.deviceId,
                  socket,
                  capabilities.includes(COORDINATION_CAPABILITY) &&
                    capabilities.includes(DISCOVERY_CAPABILITY),
                )
              },
            )
            // ADR-0027 §6（PC-05b）：重连/hello 必须收到完整当前状态，不只增量。
            if (isCurrent) await deps.orchestrator.onDeviceHello(identity.deviceId)
          }
          if (frame.type === 'run.live_delta') {
            // P1-13：直播 delta 不持久——校验归属后直接投递给 owner 连接（03 §8）。
            const run = await getRun(deps.database.db, frame.payload.runId)
            if (run === undefined || run.deviceId !== identity.deviceId) {
              throw new Error('live_delta for unknown or foreign run')
            }
            if (isManagedDraftSource(run)) return
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
              const run = await getOrdinaryRun(deps.database.db, runId)
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
          // #206：原来 errorMessage 取原始 message——Drizzle 外层 message 就是
          // `Failed query: …`（含 SQL 列名与参数值），与 app.ts 修掉的是同一缺陷。
          // 换成共享脱敏（与 hub.http / inventory 同一份）。
          // JSON and wire validation errors may echo caller-controlled bytes or field names.
          // Keep only fixed parser diagnostics before writing to the shared log.
          const diagnostic =
            error instanceof ProtocolError
              ? { errorName: 'ProtocolError', errorCode: error.code }
              : error instanceof SyntaxError
                ? { errorName: 'SyntaxError', errorCode: 'VALIDATION_FAILED' }
                : sanitizeError(error)
          request.log.warn(
            {
              component: 'hub.node-ws',
              deviceId: identity.deviceId,
              ...(managedDraftHost === undefined
                ? diagnostic
                : { errorName: 'ManagedDraftProtocolError' }),
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
