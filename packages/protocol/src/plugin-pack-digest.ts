/**
 * Plugin Pack digest（02 Task 17 Step 5、03 §2.5 pack_digest）。
 *
 * 规范化内容 SHA-256：packages 按 name 排序后取固定字段子集，canonical JSON
 * （键序递归排序）后 sha256。Hub 组装 Pack 时计算；Node preflight 用同一算法
 * 复算 descriptor 验证 digest 未漂移（G-契约：digest 变 = preflight 拒绝）。
 *
 * 仅此文件引 node:crypto——经 `@whalepod/protocol/plugin-pack-digest`
 * 子路径导出，不进 index（Web  bundle 不触 node 内建）。
 */
import { createHash } from 'node:crypto'
import { PluginPackInputSchema, type PluginPackInput } from './plugin-manifest.js'
import { PluginCordisEntrySchema, type PluginCordisEntry } from './plugin-runtime-config.js'

/**
 * 码点比较器：digest 规范化排序一律用它，不用 localeCompare——localeCompare
 * 依赖 ICU/CLDR 排序表（随 Node major 与系统 locale 变），而 digest 必须是
 * 内容纯函数，Hub/Node/curator 跨环境复算要逐字节一致（G-契约锚点）。
 */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 确定性 JSON：对象键递归排序；数组保序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareCodePoints(a, b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** 02 Task 17 Step 5 的算法原文。 */
export function digestPluginPack(pack: PluginPackInput): string {
  const parsed = PluginPackInputSchema.parse(pack)
  const normalized = [...parsed.packages]
    .sort((a, b) => compareCodePoints(a.name, b.name))
    .map(({ name, version, integrity, dependencyLockDigest, entrypoint, configDigest }) => ({
      name,
      version,
      integrity,
      dependencyLockDigest,
      entrypoint,
      configDigest,
    }))
  // 同名包多版本会让「排序后的内容」依赖输入顺序（同键 stable sort），digest
  // 不再是内容纯函数；Node preflight 也拒绝重名 descriptor——直接 fail-closed。
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i]!.name === normalized[i - 1]!.name) {
      throw new Error(`duplicate package name in plugin pack: ${normalized[i]!.name}`)
    }
  }
  return createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, packages: normalized }))
    .digest('hex')
}

/**
 * 单包 Cordis entry 的 configDigest（03 §2.5 PluginPackEntry.configDigest）。
 * Hub 组装 Pack 时写入；Node preflight 复算比对，防 catalog/overlay 漂移。
 */
export function digestPluginCordisEntry(entry: PluginCordisEntry): string {
  const parsed = PluginCordisEntrySchema.parse(entry)
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex')
}
