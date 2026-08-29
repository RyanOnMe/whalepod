/**
 * Plugin 写命令（03 §4：POST /plugins/installations、POST /plugin-packs）。
 *
 * 权限走 @project311/domain 单一决策入口（install_plugin / create_plugin_pack 均
 * Owner/Admin）；幂等经 transactCommand 回执；trust 与 capability 快照以 catalog
 * manifest 为准（03 §2.5）。Pack 不可变：无更新端点，name 冲突映射 409。
 */
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { authorize } from '@project311/domain'
import type { Actor } from '@project311/domain'
import { schema, transactCommand, unwrapPgError } from '@project311/db'
import type { Database } from '@project311/db'
import { digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import { trustForReviewStatus } from '@project311/protocol'
import type { PluginInstallationView, PluginManifest, PluginPackView } from '@project311/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import type { PluginCatalog } from './catalog.js'
import { resolvePackEntryPairs, toInstallationView, toPackView } from './queries.js'

/**
 * POST /plugins/installations 的准入（02 Task 17 Step 3）：只能安装 catalog 内
 * review.status=reviewed 的包；local-development 仅在显式 dev mode 开启时允许；
 * unreviewed 永远拒收（fail-closed，routes 层按 denied 审计）。
 */
function assertInstallableReviewStatus(
  manifest: PluginManifest,
  allowLocalDevelopment: boolean,
): void {
  if (manifest.review.status === 'reviewed') return
  if (manifest.review.status === 'local-development' && allowLocalDevelopment) return
  throw new ApiError(
    403,
    'PLUGIN_UNREVIEWED',
    `review status '${manifest.review.status}' is not installable`,
  )
}

/** (name, version) → 事务级 advisory lock 键：稳定分布即可，无需密码学强度。 */
function advisoryKey(name: string, version: string): number {
  const hex = createHash('sha256').update(`${name}@${version}`).digest('hex')
  return Number.parseInt(hex.slice(0, 8), 16)
}

export interface CreateInstallationInput {
  readonly name: string
  readonly version: string
  readonly installedBy: string
  readonly idempotencyKey: string
}

export interface CreateInstallationResult {
  readonly installation: PluginInstallationView
  readonly created: boolean
}

/**
 * 供给一个精确 curated 包（02 Task 17 Step 7）。capabilities/capability_class/
 * integrity/dependency_lock_digest 全部从 manifest 快照入行；trust 用
 * trustForReviewStatus。幂等：同 name+version 已 installed 则返回已有行而非 500
 * ——plugin_installation 无 (name,version) 唯一约束（schema 冻结不可改），用事务级
 * advisory lock 串行化同名同版本的并发安装，使存在性检查在事务内可重读成立。
 */
export async function createInstallation(
  database: Database,
  catalog: PluginCatalog,
  actor: Actor,
  input: CreateInstallationInput,
  options: { readonly allowLocalDevelopment: boolean },
): Promise<CreateInstallationResult> {
  if (!authorize(actor, 'install_plugin', {})) {
    throw new ApiError(403, 'FORBIDDEN', 'only owner or admin can install plugins')
  }
  const manifest = catalog.get(input.name, input.version)
  if (manifest === undefined) {
    throw new ApiError(404, 'NOT_FOUND', 'package is not in the curated catalog')
  }
  assertInstallableReviewStatus(manifest, options.allowLocalDevelopment)
  const trust = trustForReviewStatus(manifest.review.status)
  return transactCommand(database, `plugin.install:${input.idempotencyKey}`, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${advisoryKey(input.name, input.version)})`)
    const [existing] = await tx
      .select()
      .from(schema.pluginInstallations)
      .where(
        and(
          eq(schema.pluginInstallations.packageName, input.name),
          eq(schema.pluginInstallations.packageVersion, input.version),
          eq(schema.pluginInstallations.status, 'installed'),
        ),
      )
    if (existing !== undefined) {
      return { installation: toInstallationView(existing), created: false }
    }
    const [row] = await tx
      .insert(schema.pluginInstallations)
      .values({
        id: uuidv7(),
        packageName: manifest.name,
        packageVersion: manifest.version,
        integrity: manifest.integrity,
        dependencyLockDigest: manifest.dependencyLockDigest,
        trust,
        capabilityClass: manifest.capabilityClass,
        capabilities: [...manifest.capabilities],
        status: 'installed',
        installedBy: input.installedBy,
      })
      .returning()
    if (row === undefined) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'installation insert returned no row')
    }
    return { installation: toInstallationView(row), created: true }
  })
}

export interface CreatePackInput {
  readonly name: string
  readonly installationIds: readonly string[]
  readonly createdBy: string
  readonly idempotencyKey: string
}

/**
 * 创建不可变 Plugin Pack（03 §2.5/§4）：installations 必须全部存在且非 unreviewed
 * （unreviewed 不进普通 Pack，仅 CLI 一次性探测 Runtime 可用）；逐 installation 回查
 * catalog manifest 重建 PluginPackEntry（configDigest = pluginCordisEntry 的 digest），
 * packages 按 name 排序后 digestPluginPack 得 pack_digest；installations jsonb 存按
 * name 排序的 installation id 数组。Pack 不可变：不提供更新；name 冲突（Team 内唯一，
 * schema 冻结为全局唯一约束）映射 409 CONFLICT。
 */
export async function createPack(
  database: Database,
  catalog: PluginCatalog,
  actor: Actor,
  input: CreatePackInput,
): Promise<PluginPackView> {
  if (!authorize(actor, 'create_plugin_pack', {})) {
    throw new ApiError(403, 'FORBIDDEN', 'only owner or admin can create plugin packs')
  }
  if (new Set(input.installationIds).size !== input.installationIds.length) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'installationIds must be unique')
  }
  try {
    return await transactCommand(database, `plugin.pack:${input.idempotencyKey}`, async (tx) => {
      const rows = await tx.select().from(schema.pluginInstallations)
      const byId = new Map(rows.map((row) => [row.id, row]))
      const members = input.installationIds.map((id) => {
        const row = byId.get(id)
        if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'installation not found')
        return row
      })
      const unreviewed = members.find((row) => row.trust === 'unreviewed')
      if (unreviewed !== undefined) {
        throw new ApiError(
          409,
          'PLUGIN_UNREVIEWED',
          'unreviewed packages cannot enter a plugin pack',
        )
      }
      const pairs = resolvePackEntryPairs(catalog, members)
      const packDigest = digestPluginPack({ schemaVersion: 1, packages: pairs.map((p) => p.entry) })
      const [row] = await tx
        .insert(schema.pluginPacks)
        .values({
          id: uuidv7(),
          name: input.name,
          installations: pairs.map((p) => p.installation.id),
          packDigest,
          createdBy: input.createdBy,
        })
        .returning()
      if (row === undefined) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'pack insert returned no row')
      }
      return toPackView(row, pairs)
    })
  } catch (error) {
    const pg = unwrapPgError(error)
    if (pg?.code === '23505' && (pg.constraintName ?? '').includes('plugin_pack_name')) {
      throw new ApiError(409, 'CONFLICT', 'pack name already taken')
    }
    throw error
  }
}
