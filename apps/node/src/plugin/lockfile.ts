/**
 * 受审依赖闭包 lockfile（02 Task 17 Step 4；plugins/locks/*.lock.yaml）。
 *
 * Curated review 在隔离环境解析一次完整依赖闭包，提交 frozen lockfile 与
 * digest；Node 安装前复算 digest 与 manifest.dependencyLockDigest 比对，
 * 漂移即拒（04 §6.5：dependency lock 漂移 = 拒绝）。
 */
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { canonicalJson, compareCodePoints } from '@whalepod/protocol/plugin-pack-digest'
import { ExactVersionSchema, NpmPackageNameSchema, SriIntegritySchema } from '@whalepod/protocol'
import { PluginError } from './integrity.js'

/** 闭包中一个依赖 tarball 的钉死记录。 */
export const LockedDependencySchema = z.strictObject({
  name: NpmPackageNameSchema,
  version: ExactVersionSchema,
  /** HTTPS tarball URL。 */
  resolved: z.url({ protocol: /^https$/ }),
  integrity: SriIntegritySchema,
})
export type LockedDependency = z.infer<typeof LockedDependencySchema>

export const PluginLockfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** 根包（与 manifest name/version 必须一致）。 */
  package: z.strictObject({ name: NpmPackageNameSchema, version: ExactVersionSchema }),
  /** 完整依赖闭包（不含根包自身；按 name+version 排序存储）。 */
  dependencies: z.array(LockedDependencySchema),
})
export type PluginLockfile = z.infer<typeof PluginLockfileSchema>

export function parseLockfile(yamlText: string): PluginLockfile {
  let data: unknown
  try {
    data = parseDocument(yamlText).toJS()
  } catch {
    // 固定话术：yaml 解析错误会携带输入 token 片段（攻击者可控），不得回显（§9）。
    throw new PluginError('VALIDATION_FAILED', 'lockfile is not valid yaml')
  }
  const parsed = PluginLockfileSchema.safeParse(data)
  if (!parsed.success) {
    throw new PluginError('VALIDATION_FAILED', `lockfile schema rejected: ${parsed.error.message}`)
  }
  return parsed.data
}

/** 闭包规范化：name+version 码点排序后 canonical JSON 的 SHA-256。 */
export function digestLockfile(lock: PluginLockfile): string {
  const normalized = [...lock.dependencies].sort((a, b) =>
    compareCodePoints(`${a.name}@${a.version}`, `${b.name}@${b.version}`),
  )
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: 1,
        package: lock.package,
        dependencies: normalized,
      }),
    )
    .digest('hex')
}

/** manifest 声明的闭包 digest 与 lockfile 实算一致才放行。 */
export function assertLockMatches(
  lock: PluginLockfile,
  expected: { name: string; version: string; dependencyLockDigest: string },
): void {
  if (lock.package.name !== expected.name || lock.package.version !== expected.version) {
    throw new PluginError(
      'LOCK_DIGEST_MISMATCH',
      'lockfile root package does not match the manifest',
    )
  }
  const actual = digestLockfile(lock)
  if (actual !== expected.dependencyLockDigest) {
    throw new PluginError(
      'LOCK_DIGEST_MISMATCH',
      `dependency lock drift: manifest declares ${expected.dependencyLockDigest.slice(0, 12)}… but lockfile computes ${actual.slice(0, 12)}…`,
    )
  }
}
