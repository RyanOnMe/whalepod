/**
 * 插件 Cordis entry 的确定性生成（02 Task 17 Step 5）。
 *
 * 每个 curated 包在 Runtime Cordis 树里对应一条 insert entry。本模块定义
 * 路径无关的逻辑形态：Hub 组装 Pack 时逐包计算 configDigest；Node preflight
 * 用同一算法复算比对，再把 entry 映射为本机 overlay（本地绝对路径不进
 * digest——digest 只覆盖 name/version/entrypoint/config 逻辑内容）。
 */
import { z } from 'zod'
import { NpmPackageNameSchema, ExactVersionSchema } from './plugin-manifest.js'

/** 插件 entry 逻辑形态（EntryOptions 的路径无关子集）。 */
export const PluginCordisEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Cordis 树内稳定 id：包名的 fs/id 安全形式（@scope/pkg → scope--pkg）。 */
  id: z.string().min(1),
  name: NpmPackageNameSchema,
  version: ExactVersionSchema,
  /** 包内入口相对路径（来自 manifest）。 */
  entrypoint: z.string().min(1),
  /** 传给插件的 config；第一阶段 catalog 不带插件配置，固定为空对象。 */
  config: z.record(z.string(), z.unknown()),
})
export type PluginCordisEntry = z.infer<typeof PluginCordisEntrySchema>

/** 包名 → Cordis entry id（`@scope/pkg` → `scope--pkg`）。 */
export function cordisEntryId(packageName: string): string {
  return packageName.replace(/^@/, '').replace('/', '--')
}

/** 从 manifest 身份字段生成确定性 entry（config 恒为空对象）。 */
export function pluginCordisEntry(manifest: {
  name: string
  version: string
  entrypoint: string
}): PluginCordisEntry {
  return PluginCordisEntrySchema.parse({
    schemaVersion: 1,
    id: cordisEntryId(manifest.name),
    name: manifest.name,
    version: manifest.version,
    entrypoint: manifest.entrypoint,
    config: {},
  })
}
