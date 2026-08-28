/**
 * Curated 插件清单与信任分级（02 Task 17 Step 3、03 §2.5）。
 *
 * Manifest 是 curated catalog 里的 review overlay——置于插件 tarball 之外，
 * 固定 name / 精确 version / tarball URL / SRI integrity / 全依赖闭包 lockfile
 * digest / DSH compatibility / entrypoint / declared capabilities / license /
 * review status 与 review commit。第一阶段正常 Pack 只允许 reviewed 包；
 * local-development 只在显式 dev mode 开启且 UI 标红。
 *
 * 本文件同构（不引 node:*），Web 端用于 Admin Plugin Settings 展示；
 * digest 计算在 ./plugin-pack-digest.ts（node:crypto，仅 Hub/Node 消费）。
 */
import { z } from 'zod'

/** 合法 npm package name（scope 可选；长度上限 214 见 03 §2.5）。 */
export const NpmPackageNameSchema = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'invalid npm package name')

/**
 * 精确语义化版本——拒绝 range（^ ~ >=）、tag（latest）、git URL 与本地路径
 * （04 §6.5 攻击矩阵第一行）。
 */
export const ExactVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    'version must be exact semver (no range/tag/url/path)',
  )

/** npm SRI integrity（sha256/384/512 + base64）。 */
export const SriIntegritySchema = z
  .string()
  .regex(/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/, 'invalid SRI integrity')

/** SHA-256 十六进制 digest（pack/lock/config 共用）。 */
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, 'expected sha256 hex digest')

/**
 * 声明能力（02 Task 17 Step 6）：第一阶段是审核与展示契约，
 * 不宣称 OS 级强隔离；高风险工具运行时仍走 Approval。
 */
export const PLUGIN_CAPABILITIES = [
  'workspace.read',
  'workspace.write',
  'network.egress',
  'subprocess.spawn',
  'secrets.model',
] as const
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]
export const PluginCapabilitySchema = z.enum(PLUGIN_CAPABILITIES)

/** 03 §2.5 trust 枚举。 */
export const PluginTrustSchema = z.enum(['builtin', 'curated', 'unreviewed'])
export type PluginTrust = z.infer<typeof PluginTrustSchema>

/** 03 §2.5 capability_class：declared=已按清单声明；legacy_unrestricted=未声明的旧插件。 */
export const PluginCapabilityClassSchema = z.enum(['declared', 'legacy_unrestricted'])
export type PluginCapabilityClass = z.infer<typeof PluginCapabilityClassSchema>

/** Catalog review 状态（02 Task 17 Step 3）。 */
export const PluginReviewStatusSchema = z.enum(['reviewed', 'unreviewed', 'local-development'])
export type PluginReviewStatus = z.infer<typeof PluginReviewStatusSchema>

/** review 状态 → 03 §2.5 trust 映射（builtin 不走 catalog）。 */
export function trustForReviewStatus(status: PluginReviewStatus): PluginTrust {
  return status === 'reviewed' ? 'curated' : 'unreviewed'
}

/** review overlay 元数据。 */
export const PluginReviewSchema = z.strictObject({
  status: PluginReviewStatusSchema,
  /** 审核对应的 catalog 仓库 commit（40 hex git sha）。 */
  commit: z.string().regex(/^[a-f0-9]{40}$/, 'review commit must be a full git sha'),
  /** 审核完成时间。 */
  at: z.iso.datetime({ offset: true }),
})
export type PluginReview = z.infer<typeof PluginReviewSchema>

/** Catalog 内的插件清单（review overlay，置于 tarball 之外）。 */
export const PluginManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: NpmPackageNameSchema,
  version: ExactVersionSchema,
  /** HTTPS tarball URL；host allowlist 与长度上限在安装侧校验。 */
  tarballUrl: z.url({ protocol: /^https$/ }),
  integrity: SriIntegritySchema,
  /** 受审全依赖闭包 lockfile 的 SHA-256（03 §2.5 dependency_lock_digest）。 */
  dependencyLockDigest: Sha256HexSchema,
  /** 兼容的 DSH 精确版本（DSH 锁精确版本红线：不接受 range）。 */
  dshCompatibility: ExactVersionSchema,
  /** 包内入口相对路径：拒绝绝对路径与 .. 段。 */
  entrypoint: z
    .string()
    .min(1)
    .refine(
      (v) => !v.startsWith('/') && !v.split('/').includes('..'),
      'entrypoint must be a package-relative path',
    ),
  capabilities: z.array(PluginCapabilitySchema),
  capabilityClass: PluginCapabilityClassSchema,
  /** SPDX license id。 */
  license: z.string().min(1).max(64),
  review: PluginReviewSchema,
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>

/** Pack 内一条安装（digest 输入；03 §2.5 列的子集 + 规范化排序字段）。 */
export const PluginPackEntrySchema = z.strictObject({
  name: NpmPackageNameSchema,
  version: ExactVersionSchema,
  integrity: SriIntegritySchema,
  dependencyLockDigest: Sha256HexSchema,
  entrypoint: z.string().min(1),
  /** 该包生成的 Cordis 配置的 digest（配置来源 catalog overlay，不 patch 插件源码）。 */
  configDigest: Sha256HexSchema,
})
export type PluginPackEntry = z.infer<typeof PluginPackEntrySchema>

/** digestPluginPack 的规范化输入。 */
export const PluginPackInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packages: z.array(PluginPackEntrySchema),
})
export type PluginPackInput = z.infer<typeof PluginPackInputSchema>
