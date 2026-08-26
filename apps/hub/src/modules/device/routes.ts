/**
 * Device HTTP 路由（02 Task 9 Interfaces；03 §4）：
 *   POST /devices/pairing-codes   登录 Member 生成一次性配对码
 *   POST /devices/pairing-claims  匿名 Node 换取一次性 Device Token（响应 no-store）
 *   GET  /devices                 当前 Member 的设备与在线状态
 *   DELETE /devices/:deviceId     本人或 Owner/Admin 撤销
 *
 * Origin 豁免（pairing-claims）由组合根 app.ts 的中间件按 03 §4 末段处理；
 * 本文件只管路由与错误映射。Node WS（/ws/v1/node）在 node-websocket.ts。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Database } from '@project311/db'
import { CreatePairingCodeRequestSchema, PairingClaimRequestSchema } from '@project311/protocol'
import { audit } from '../shared/audit.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import {
  claimPairingCode,
  issuePairingCode,
  listOwnDevices,
  revokeDeviceForActor,
} from './pairing.js'

export interface DeviceRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

/** 配对响应禁止缓存（02 Task 9 Step 3）：Token/码明文不得进任何中间层。 */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceRouteDeps): void {
  app.post('/devices/pairing-codes', async (request, reply) => {
    const actor = await deps.requireActor(request)
    CreatePairingCodeRequestSchema.parse(request.body ?? {})
    const created = await issuePairingCode(deps.database, { ownerUserId: actor.userId })
    audit(request, 'device.pair', 'success', actor.userId)
    return noStore(reply).code(201).send({ ok: true, data: created })
  })

  app.post('/devices/pairing-claims', async (request, reply) => {
    // 匿名：无 requireActor；Idempotency-Key 由组合根钩子仍强制。
    const body = PairingClaimRequestSchema.parse(request.body)
    const claimed = await claimPairingCode(deps.database, { ...body })
    audit(request, 'device.claim', 'success', claimed.deviceId)
    return noStore(reply).code(201).send({ ok: true, data: claimed })
  })

  app.get('/devices', async (request) => {
    const actor = await deps.requireActor(request)
    return { ok: true, data: await listOwnDevices(deps.database, actor.userId) }
  })

  app.delete('/devices/:deviceId', async (request) => {
    const actor = await deps.requireActor(request)
    const { deviceId } = request.params as { deviceId: string }
    try {
      await revokeDeviceForActor(deps.database, actor, deviceId)
    } catch (error) {
      audit(request, 'device.revoke', 'denied', actor.userId)
      throw error
    }
    audit(request, 'device.revoke', 'success', actor.userId)
    return { ok: true, data: {} }
  })
}
