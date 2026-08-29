/**
 * Node 侧 Pack descriptor 解析（03 §4：GET /node/plugin-packs/:packDigest）。
 *
 * Device Token 鉴权与 Node WS（node-websocket.ts）同一验法：Authorization:
 * Device <token> → SHA-256 比对 → 拒绝已撤销。/node/** 的 Origin 豁免由组合根
 * app.ts 的钩子按 03 §4 末段处理，本模块不重复。
 *
 * fail-closed 主锚点：按请求的 packDigest 找 Pack → 用当前 catalog 重建 entries
 * 并复算 pack digest → 与请求不一致即 404。catalog 被改动（Hub 重启后加载了被
 * 篡改的 manifest）= digest 漂移 = 拒发；与「未知 digest」同一 404 形态，不泄露
 * 存在性（04 §6.1）。descriptor 不含任何 secret、不含本机绝对路径——manifest 与
 * lockfile 都是 catalog 相对内容的原样下发。
 */
import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { findDeviceByTokenHash, schema } from '@project311/db'
import type { Database } from '@project311/db'
import { PluginPackDescriptorSchema } from '@project311/protocol'
import type { PluginPackDescriptor } from '@project311/protocol'
import { digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import { ApiError } from '../shared/http-error.js'
import { hashToken } from '../auth/token.js'
import type { PluginCatalog } from './catalog.js'
import { resolvePackEntryPairs } from './queries.js'

export interface DeviceIdentity {
  readonly deviceId: string
  readonly ownerUserId: string
}

/** Device Token → 设备身份；缺失/伪造/撤销一律 401 INVALID_CREDENTIALS。 */
export async function authenticateDevice(
  database: Database,
  request: FastifyRequest,
): Promise<DeviceIdentity> {
  const header = request.headers.authorization
  const prefix = 'Device '
  const token =
    typeof header === 'string' && header.startsWith(prefix)
      ? header.slice(prefix.length).trim()
      : ''
  const device =
    token === '' ? undefined : await findDeviceByTokenHash(database.db, hashToken(token))
  if (device === undefined || device.revokedAt !== null) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid or revoked device token')
  }
  return { deviceId: device.id, ownerUserId: device.ownerUserId }
}

/**
 * 按不可变 pack_digest 解析 descriptor（无 secret）。
 * 前置：packDigest 已由路由层过 Sha256HexSchema（非法形态与未知 digest 同作 404）。
 */
export async function resolvePackDescriptor(
  database: Database,
  catalog: PluginCatalog,
  requestedPackDigest: string,
): Promise<PluginPackDescriptor> {
  const [pack] = await database.db
    .select()
    .from(schema.pluginPacks)
    .where(eq(schema.pluginPacks.packDigest, requestedPackDigest))
  if (pack === undefined) throw new ApiError(404, 'NOT_FOUND', 'plugin pack not found')

  const allInstallations = await database.db.select().from(schema.pluginInstallations)
  const byId = new Map(allInstallations.map((row) => [row.id, row]))
  const members = (pack.installations as string[]).map((id) => {
    const row = byId.get(id)
    if (row === undefined) {
      throw new ApiError(409, 'PLUGIN_PACK_MISMATCH', 'pack references a missing installation')
    }
    return row
  })

  // 复算锚点：与创建 Pack 时同一条重建路径（queries.resolvePackEntryPairs），
  // catalog 漂移在此暴露为 digest 不一致。
  const pairs = resolvePackEntryPairs(catalog, members)
  const recomputed = digestPluginPack({ schemaVersion: 1, packages: pairs.map((p) => p.entry) })
  if (recomputed !== requestedPackDigest) {
    throw new ApiError(404, 'NOT_FOUND', 'plugin pack not found')
  }

  const packages = pairs.map((pair) => {
    const manifest = catalog.get(pair.installation.packageName, pair.installation.packageVersion)
    const lockfile = catalog.lockfile(
      pair.installation.packageName,
      pair.installation.packageVersion,
    )
    if (manifest === undefined || lockfile === undefined) {
      throw new ApiError(
        409,
        'PLUGIN_PACK_MISMATCH',
        'catalog entry is incomplete for an installed package',
      )
    }
    return { manifest, lockfile }
  })
  return PluginPackDescriptorSchema.parse({
    schemaVersion: 1,
    packDigest: requestedPackDigest,
    name: pack.name,
    packages,
  })
}
