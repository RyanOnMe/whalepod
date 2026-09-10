/**
 * Plugin HTTP 面接线（03 §4 权限表；02 Task 17 Step 7）：
 *   GET  /plugins/catalog                Member（审核摘要视图）
 *   GET  /plugins/installations          Member
 *   POST /plugins/installations          Owner/Admin（domain install_plugin）
 *   GET  /plugin-packs                   Member
 *   POST /plugin-packs                   Owner/Admin（domain create_plugin_pack）
 *   GET  /node/plugin-packs/:packDigest  Device Token（Node 专用，Origin 豁免由组合根处理）
 *
 * Member 打 POST 必须 403 FORBIDDEN 并 audit 'denied'（G1-05 场景）；Browser POST 的
 * Origin/Idempotency-Key 约束沿用组合根 app.ts 的全局机制，此处不重复。
 */
import type { FastifyInstance } from 'fastify'
import type { Database } from '@whalepod/db'
import { asUserId } from '@whalepod/domain'
import {
  PluginInstallRequestSchema,
  PluginPackCreateRequestSchema,
  Sha256HexSchema,
} from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { createInstallation, createPack } from './commands.js'
import { listCatalogViews, listInstallationViews, listPackViews } from './queries.js'
import { authenticateDevice, resolvePackDescriptor } from './pack-resolver.js'
import type { PluginCatalog } from './catalog.js'

export interface PluginRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  readonly catalog: PluginCatalog
  /** 显式 dev mode：允许安装 local-development 清单（WHALEPOD_PLUGIN_DEV_MODE）。 */
  readonly allowLocalDevelopment: boolean
}

function actorFrom(session: { userId: string; role: 'owner' | 'admin' | 'member' }) {
  return { userId: asUserId(session.userId), role: session.role }
}

export function registerPluginRoutes(app: FastifyInstance, deps: PluginRouteDeps): void {
  // GET /plugins/catalog：Member 查看 curated catalog 与审核摘要（manifest 全字段）。
  app.get('/plugins/catalog', async (request) => {
    await deps.requireActor(request)
    return { ok: true, data: listCatalogViews(deps.catalog) }
  })

  // GET /plugins/installations：Member 可读安装列表。
  app.get('/plugins/installations', async (request) => {
    await deps.requireActor(request)
    return { ok: true, data: await listInstallationViews(deps.database.db) }
  })

  // POST /plugins/installations：Owner/Admin 供给精确 curated 包。
  app.post('/plugins/installations', async (request, reply) => {
    const session = await deps.requireActor(request)
    const body = PluginInstallRequestSchema.parse(request.body)
    try {
      const result = await createInstallation(
        deps.database,
        deps.catalog,
        actorFrom(session),
        {
          name: body.name,
          version: body.version,
          installedBy: session.userId,
          idempotencyKey: readIdempotencyKey(request),
        },
        { allowLocalDevelopment: deps.allowLocalDevelopment },
      )
      audit(request, 'plugin.install', 'success', session.userId)
      // 幂等重装（同 name+version 已 installed）返回已有行：200，而非重复 201。
      return reply.code(result.created ? 201 : 200).send({ ok: true, data: result.installation })
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'FORBIDDEN' || error.code === 'PLUGIN_UNREVIEWED')
      ) {
        audit(request, 'plugin.install', 'denied', session.userId)
      }
      throw error
    }
  })

  // GET /plugin-packs：Member 可读 Pack 列表（entries 展开安装详情）。
  app.get('/plugin-packs', async (request) => {
    await deps.requireActor(request)
    return { ok: true, data: await listPackViews(deps.database.db, deps.catalog) }
  })

  // POST /plugin-packs：Owner/Admin 创建不可变 Pack。
  app.post('/plugin-packs', async (request, reply) => {
    const session = await deps.requireActor(request)
    const body = PluginPackCreateRequestSchema.parse(request.body)
    try {
      const pack = await createPack(deps.database, deps.catalog, actorFrom(session), {
        name: body.name,
        installationIds: body.installationIds,
        createdBy: session.userId,
        idempotencyKey: readIdempotencyKey(request),
      })
      audit(request, 'plugin.pack', 'success', session.userId)
      return reply.code(201).send({ ok: true, data: pack })
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'FORBIDDEN' || error.code === 'PLUGIN_UNREVIEWED')
      ) {
        audit(request, 'plugin.pack', 'denied', session.userId)
      }
      throw error
    }
  })

  // GET /node/plugin-packs/:packDigest：Node 专用 descriptor（Device Token）。
  // 非法 digest 形态与未知 digest 同作 404：不能枚举哪些 digest 存在（04 §6.1）。
  app.get('/node/plugin-packs/:packDigest', async (request) => {
    await authenticateDevice(deps.database, request)
    const { packDigest } = request.params as { packDigest: string }
    if (!Sha256HexSchema.safeParse(packDigest).success) {
      throw new ApiError(404, 'NOT_FOUND', 'plugin pack not found')
    }
    const descriptor = await resolvePackDescriptor(deps.database, deps.catalog, packDigest)
    return { ok: true, data: descriptor }
  })
}
