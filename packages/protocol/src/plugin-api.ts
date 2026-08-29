/**
 * 插件模块的 HTTP 面 schema（03 §4 的四个插件端点；02 Task 17 Step 7）。
 *
 * 同构：不引 node:*，Hub 与 Web（Admin Plugin Settings / PluginPackEditor）共用。
 * 所有视图都不含 secret、不含本机绝对路径；descriptor 的 lockfile 是 catalog 内
 * lock 原文的透传文本——内容与 manifest.dependencyLockDigest 的一致性由 Node
 * preflight 复算（digestLockfile），Hub 不解析 yaml。
 */
import { z } from 'zod'
import {
  ExactVersionSchema,
  NpmPackageNameSchema,
  PluginCapabilitySchema,
  PluginCapabilityClassSchema,
  PluginManifestSchema,
  PluginPackEntrySchema,
  PluginTrustSchema,
  Sha256HexSchema,
  SriIntegritySchema,
} from './plugin-manifest.js'
import type { PluginManifest } from './plugin-manifest.js'

/** 03 §2.5 plugin_installation.status。 */
export const PluginStatusSchema = z.enum(['installed', 'disabled', 'failed'])
export type PluginStatus = z.infer<typeof PluginStatusSchema>

/**
 * GET /plugins/catalog 的条目：manifest 全字段即审核摘要（exact version、SRI 全文、
 * license、review commit、declared capabilities）；integrity 短摘要由 Web 自行截断展示。
 */
export const PluginCatalogEntryViewSchema = PluginManifestSchema
export type PluginCatalogEntryView = PluginManifest

/** plugin_installation 行的 JSON 视图（03 §2.5；capabilities 是 manifest 快照）。 */
export const PluginInstallationViewSchema = z.strictObject({
  id: z.uuid(),
  packageName: NpmPackageNameSchema,
  packageVersion: ExactVersionSchema,
  integrity: SriIntegritySchema,
  dependencyLockDigest: Sha256HexSchema,
  trust: PluginTrustSchema,
  capabilityClass: PluginCapabilityClassSchema,
  capabilities: z.array(PluginCapabilitySchema),
  status: PluginStatusSchema,
  installedBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type PluginInstallationView = z.infer<typeof PluginInstallationViewSchema>

/** POST /plugins/installations 请求体：catalog 内 name + 精确 version。 */
export const PluginInstallRequestSchema = z.strictObject({
  name: NpmPackageNameSchema,
  version: ExactVersionSchema,
})
export type PluginInstallRequest = z.infer<typeof PluginInstallRequestSchema>

/** Pack 视图内一条展开的 entry：digest 输入（PluginPackEntry）+ 安装行详情。 */
export const PluginPackEntryViewSchema = z.strictObject({
  entry: PluginPackEntrySchema,
  installation: PluginInstallationViewSchema,
})
export type PluginPackEntryView = z.infer<typeof PluginPackEntryViewSchema>

/** GET /plugin-packs 的条目：不可变 Pack（entries 按 package name 排序展开）。 */
export const PluginPackViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  packDigest: Sha256HexSchema,
  /** 按 package name 排序的 installation id 数组（03 §2.5 原文）。 */
  installations: z.array(z.uuid()),
  entries: z.array(PluginPackEntryViewSchema),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type PluginPackView = z.infer<typeof PluginPackViewSchema>

/** POST /plugin-packs 请求体。空 Pack 即 core-empty（Setup 创建），API 不重复提供。 */
export const PluginPackCreateRequestSchema = z.strictObject({
  name: z.string().min(1).max(80),
  installationIds: z.array(z.uuid()).min(1),
})
export type PluginPackCreateRequest = z.infer<typeof PluginPackCreateRequestSchema>

/**
 * GET /node/plugin-packs/:packDigest 的响应（03 §4：不含 secret 的不可变
 * pack/lock descriptor）。Node 按 manifest 逐包校验 lockfile digest 与 SRI 后
 * 才启 Runtime；digest 漂移即整体拒用。
 */
export const PluginPackDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packDigest: Sha256HexSchema,
  name: z.string().min(1).max(80),
  packages: z.array(
    z.strictObject({
      manifest: PluginManifestSchema,
      /** 依赖闭包 lockfile 的 yaml 原文（不透明文本；Node 侧 digestLockfile 复算）。 */
      lockfile: z.string().min(1),
      /**
       * 可选随包 pack entry：携带时 Node 逐字段 + configDigest 复算双保险比对；
       * 缺省时由 manifest 复算 configDigest → digestPluginPack 三方比对覆盖同一语义。
       */
      entry: PluginPackEntrySchema.optional(),
    }),
  ),
})
export type PluginPackDescriptor = z.infer<typeof PluginPackDescriptorSchema>
