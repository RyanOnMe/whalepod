/**
 * Plugin 读视图（03 §4：GET /plugins/catalog、/plugins/installations、/plugin-packs）。
 *
 * Pack entry 的重建走统一 fail-closed 路径（resolvePackEntryPairs）：catalog 漂移
 * （manifest 缺失、或与安装行不可变快照不一致）= PLUGIN_PACK_MISMATCH，视图与
 * descriptor 同一语义拒绝——被污染的 catalog 不产出任何 Pack 内容。
 */
import { asc } from 'drizzle-orm'
import { schema } from '@project311/db'
import type { DbHandle } from '@project311/db'
import { PluginPackEntrySchema, pluginCordisEntry } from '@project311/protocol'
import { digestPluginCordisEntry, digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import type {
  PluginCapability,
  PluginInstallationView,
  PluginManifest,
  PluginPackEntry,
  PluginPackEntryView,
  PluginPackView,
} from '@project311/protocol'
import { ApiError } from '../shared/http-error.js'
import type { PluginCatalog } from './catalog.js'

export type PluginInstallationRow = typeof schema.pluginInstallations.$inferSelect
export type PluginPackRow = typeof schema.pluginPacks.$inferSelect

/** 安装行 → JSON 视图（capabilities 为 manifest 快照的 jsonb 直出）。 */
export function toInstallationView(row: PluginInstallationRow): PluginInstallationView {
  return {
    id: row.id,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    integrity: row.integrity,
    dependencyLockDigest: row.dependencyLockDigest,
    trust: row.trust,
    capabilityClass: row.capabilityClass,
    capabilities: row.capabilities as PluginCapability[],
    status: row.status,
    installedBy: row.installedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * 安装行 + 当前 catalog manifest → Pack entry（03 §2.5 的 digest 输入子集）。
 * configDigest 从 manifest 身份字段经 pluginCordisEntry 确定性重建。
 */
export function rebuildPackEntry(
  catalog: PluginCatalog,
  row: PluginInstallationRow,
): PluginPackEntry {
  const manifest = catalog.get(row.packageName, row.packageVersion)
  if (manifest === undefined) {
    throw new ApiError(
      409,
      'PLUGIN_PACK_MISMATCH',
      'catalog manifest is missing for an installed package',
    )
  }
  // 快照一致性：安装行是安装时 manifest 的不可变快照；catalog 若改动已审字段
  // （integrity / 闭包 digest / 能力声明），entry 不再可复算 → 拒绝（fail-closed）。
  if (
    manifest.integrity !== row.integrity ||
    manifest.dependencyLockDigest !== row.dependencyLockDigest ||
    manifest.capabilityClass !== row.capabilityClass ||
    JSON.stringify(manifest.capabilities) !== JSON.stringify(row.capabilities)
  ) {
    throw new ApiError(409, 'PLUGIN_PACK_MISMATCH', 'catalog manifest drifted after installation')
  }
  return PluginPackEntrySchema.parse({
    name: manifest.name,
    version: manifest.version,
    integrity: manifest.integrity,
    dependencyLockDigest: manifest.dependencyLockDigest,
    entrypoint: manifest.entrypoint,
    configDigest: digestPluginCordisEntry(pluginCordisEntry(manifest)),
  })
}

/**
 * Pack 成员行 → 展开的 entry 视图（按 package name 排序，03 §2.5 installations 的排序语义）。
 * commands（创建 Pack）、queries（列表视图）、pack-resolver（descriptor）共用这一条路径。
 */
export function resolvePackEntryPairs(
  catalog: PluginCatalog,
  rows: readonly PluginInstallationRow[],
): PluginPackEntryView[] {
  const sorted = [...rows].sort((a, b) => a.packageName.localeCompare(b.packageName))
  return sorted.map((row) => ({
    entry: rebuildPackEntry(catalog, row),
    installation: toInstallationView(row),
  }))
}

export function toPackView(
  row: PluginPackRow,
  entries: readonly PluginPackEntryView[],
): PluginPackView {
  return {
    id: row.id,
    name: row.name,
    packDigest: row.packDigest,
    // jsonb 直出：创建时已按 package name 排序（03 §2.5）。
    installations: row.installations as string[],
    entries: [...entries],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/** GET /plugins/catalog：catalog 视图（加载时已按 name/version 排序）。 */
export function listCatalogViews(catalog: PluginCatalog): readonly PluginManifest[] {
  return catalog.manifests
}

/** GET /plugins/installations：安装列表（按包名、时间稳定排序）。 */
export async function listInstallationViews(handle: DbHandle): Promise<PluginInstallationView[]> {
  const rows = await handle
    .select()
    .from(schema.pluginInstallations)
    .orderBy(asc(schema.pluginInstallations.packageName), asc(schema.pluginInstallations.createdAt))
  return rows.map(toInstallationView)
}

/**
 * GET /plugin-packs：Pack 列表（entries 展开安装详情）。
 * fail-closed 视图：entries 重建后复算 pack digest，与行内登记不一致（catalog 漂移）
 * 即整体 409——视图永不展示 digest 对不上的 Pack；任一 Pack 漂移即拒绝整个列表，
 * 不部分展示被污染组合。
 */
export async function listPackViews(
  handle: DbHandle,
  catalog: PluginCatalog,
): Promise<PluginPackView[]> {
  const packs = await handle
    .select()
    .from(schema.pluginPacks)
    .orderBy(asc(schema.pluginPacks.createdAt), asc(schema.pluginPacks.name))
  if (packs.length === 0) return []
  const rows = await handle.select().from(schema.pluginInstallations)
  const byId = new Map(rows.map((row) => [row.id, row]))
  return packs.map((pack) => {
    const members = (pack.installations as string[]).map((id) => {
      const row = byId.get(id)
      if (row === undefined) {
        throw new ApiError(409, 'PLUGIN_PACK_MISMATCH', 'pack references a missing installation')
      }
      return row
    })
    const entries = resolvePackEntryPairs(catalog, members)
    const recomputed = digestPluginPack({ schemaVersion: 1, packages: entries.map((p) => p.entry) })
    if (recomputed !== pack.packDigest) {
      throw new ApiError(409, 'PLUGIN_PACK_MISMATCH', 'pack digest does not match its entries')
    }
    return toPackView(pack, entries)
  })
}
