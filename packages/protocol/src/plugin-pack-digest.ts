/**
 * Plugin Pack digest（02 Task 17 Step 5、03 §2.5 pack_digest）。
 *
 * 规范化内容 SHA-256：packages 按 name 排序后取固定字段子集，canonical JSON
 * （键序递归排序）后 sha256。Hub 组装 Pack 时计算；Node preflight 用同一算法
 * 复算 descriptor 验证 digest 未漂移（G-契约：digest 变 = preflight 拒绝）。
 *
 * 仅此文件引 node:crypto——经 `@project311/protocol/plugin-pack-digest`
 * 子路径导出，不进 index（Web  bundle 不触 node 内建）。
 */
import { createHash } from 'node:crypto'
import { PluginPackInputSchema, type PluginPackInput } from './plugin-manifest.js'

/** 确定性 JSON：对象键递归排序；数组保序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** 02 Task 17 Step 5 的算法原文。 */
export function digestPluginPack(pack: PluginPackInput): string {
  const parsed = PluginPackInputSchema.parse(pack)
  const normalized = [...parsed.packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, version, integrity, dependencyLockDigest, entrypoint, configDigest }) => ({
      name,
      version,
      integrity,
      dependencyLockDigest,
      entrypoint,
      configDigest,
    }))
  return createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, packages: normalized }))
    .digest('hex')
}
