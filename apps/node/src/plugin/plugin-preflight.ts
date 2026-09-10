/**
 * Plugin Pack preflight（P1-17；02 Task 17 Step 5、03 §4 node descriptor 路由）。
 *
 * runtime.initialize 之前的完整校验链（任何一步失败都不启动 Runtime）：
 * 1. core-empty pack（`digestPluginPack({ schemaVersion: 1, packages: [] })`）
 *    直接放行（无 overlay）；
 * 2. 本地命中：`<packsRoot>/<packDigest>/pack.json` marker 有效且逐包 store
 *    树存在 → 幂等补齐 overlay/锚后直接用，**不访问网络**；
 * 3. 本地未命中 → Device Token 拉 Hub descriptor → 校验（descriptor schema、
 *    逐包 manifest schema、reviewed 信任级、packDigest 复算、逐包 entry
 *    configDigest 复算、逐包 lockfile digest 复算）→ PluginInstaller 逐包
 *    安装 → 生成 overlay。
 *
 * 失败统一折算为 PluginPreflightError（code 直接是 wire ErrorCode，可回
 * command.ack）；PluginError 的具体折算见 PLUGIN_ERROR_WIRE_CODES。错误消息
 * 不含本地绝对路径（Hub wire 纪律：tarball 内容类与本地 IO 类失败只报固定话术）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pluginCordisEntry,
  type ErrorCode,
  type PluginManifest,
  type PluginPackEntry,
} from '@whalepod/protocol'
import { digestPluginCordisEntry, digestPluginPack } from '@whalepod/protocol/plugin-pack-digest'
import { PluginError } from './integrity.js'
import { type PluginInstaller } from './installer.js'
import { assertLockMatches, parseLockfile } from './lockfile.js'
import { type PackageStore } from './package-store.js'
import {
  PackMarkerSchema,
  buildPackOverlay,
  ensurePackOverlay,
  assertCordisEntryDigest,
  type PackOverlayResult,
  type PackPackageRecord,
} from './runtime-config.js'

/** 折算后的 wire 失败码（§10 目录内取值，不新造码）。 */
export type PreflightFailureCode = Extract<
  ErrorCode,
  | 'PLUGIN_PACK_MISMATCH'
  | 'PLUGIN_UNREVIEWED'
  | 'VALIDATION_FAILED'
  | 'RUNTIME_START_FAILED'
  | 'NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'INTERNAL_ERROR'
>

export class PluginPreflightError extends Error {
  constructor(
    readonly code: PreflightFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'PluginPreflightError'
  }
}

/** PluginError → wire ErrorCode（fail-closed：安全类失败一律 PLUGIN_PACK_MISMATCH）。 */
const PLUGIN_ERROR_WIRE_CODES: Record<PluginError['code'], PreflightFailureCode> = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTEGRITY_MISMATCH: 'PLUGIN_PACK_MISMATCH',
  LOCK_DIGEST_MISMATCH: 'PLUGIN_PACK_MISMATCH',
  TARBALL_UNSAFE: 'PLUGIN_PACK_MISMATCH',
  HOST_NOT_ALLOWED: 'PLUGIN_PACK_MISMATCH',
  SIZE_LIMIT_EXCEEDED: 'PLUGIN_PACK_MISMATCH',
  STORE_IO: 'RUNTIME_START_FAILED',
}

/**
 * 消息白名单：这两类失败的消息含 tarball 内容片段/本地 fs 细节，回 Hub 前换成
 * 固定话术（§9：绝对路径与攻击者可控串不进 Hub wire）。
 */
const GENERIC_PLUGIN_ERROR_MESSAGES: Partial<Record<PluginError['code'], string>> = {
  TARBALL_UNSAFE: 'unsafe tarball entry rejected',
  STORE_IO: 'plugin package store io failure',
}

function toPreflightError(error: unknown): PluginPreflightError {
  if (error instanceof PluginPreflightError) return error
  if (error instanceof PluginError) {
    const message = GENERIC_PLUGIN_ERROR_MESSAGES[error.code] ?? error.message
    return new PluginPreflightError(
      PLUGIN_ERROR_WIRE_CODES[error.code],
      `plugin pack preflight: ${message}`,
    )
  }
  return new PluginPreflightError('INTERNAL_ERROR', 'plugin pack preflight failed')
}

/** core-empty pack digest（空 packages 的规范化内容 SHA-256；Hub 侧同算法）。 */
export const CORE_EMPTY_PACK_DIGEST = digestPluginPack({ schemaVersion: 1, packages: [] })

/** descriptor 里一个已验证包（manifest/lockfile 已过 schema，entry 可选）。 */
export interface ValidatedDescriptorPackage {
  readonly manifest: PluginManifest
  /** lockfile yaml 原文（Hub 存的发布版，安装前复算 digest）。 */
  readonly lockfile: string
  /** Hub 随包携带的 pack entry（可选；携带时逐字段比对，双保险）。 */
  readonly entry?: PluginPackEntry
}

/** 已验证 descriptor（pack-descriptor-client 的返回形状）。 */
export interface PluginPackDescriptor {
  readonly schemaVersion: 1
  readonly packDigest: string
  readonly name: string
  readonly packages: readonly ValidatedDescriptorPackage[]
}

export interface PluginPackPreflightDeps {
  /** 插件 pack 数据根目录（`<stateDir>/plugin-packs`）。 */
  readonly packsRoot: string
  readonly store: PackageStore
  readonly installer: PluginInstaller
  /** descriptor 拉取缝（生产：Device Token HTTP；测试：内存注入）。 */
  readonly fetchDescriptor: (packDigest: string) => Promise<PluginPackDescriptor>
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

export interface PreflightOutcome {
  /** core-empty 或 preflight 失败前不存在；成功时为 overlay yml 绝对路径。 */
  readonly overlayPath?: string
}

export class PluginPackPreflight {
  constructor(private readonly deps: PluginPackPreflightDeps) {}

  /** run.start 的 preflight 入口：返回 overlay 路径（core-empty 返回空对象）。 */
  async ensure(packDigest: string): Promise<PreflightOutcome> {
    try {
      if (packDigest === CORE_EMPTY_PACK_DIGEST) return {}
      const localHit = this.tryLocalHit(packDigest)
      if (localHit !== undefined) {
        this.deps.log?.('info', 'plugin pack local hit', { packDigest: short(packDigest) })
        return { overlayPath: localHit.overlayPath }
      }
      this.deps.log?.('info', 'plugin pack local miss; fetching descriptor', {
        packDigest: short(packDigest),
      })
      const descriptor = await this.deps.fetchDescriptor(packDigest)
      const result = await this.installAndOverlay(packDigest, descriptor)
      this.deps.log?.('info', 'plugin pack installed', { packDigest: short(packDigest) })
      return { overlayPath: result.overlayPath }
    } catch (error) {
      throw toPreflightError(error)
    }
  }

  /** 本地完整命中（marker + 逐包 store 树）；命中即幂等补齐 overlay/锚。 */
  private tryLocalHit(packDigest: string): PackOverlayResult | undefined {
    let marker: unknown
    try {
      marker = JSON.parse(
        readFileSync(join(this.deps.packsRoot, packDigest, 'pack.json'), 'utf8'),
      ) as unknown
    } catch {
      return undefined
    }
    const parsed = PackMarkerSchema.safeParse(marker)
    if (
      !parsed.success ||
      parsed.data.packDigest !== packDigest ||
      parsed.data.packages.length === 0
    ) {
      return undefined
    }
    const records: PackPackageRecord[] = []
    for (const pkg of parsed.data.packages) {
      const storePath = this.deps.store.lookup(pkg.treeDigest)
      if (storePath === undefined) return undefined
      records.push({ ...pkg, storePath })
    }
    return ensurePackOverlay({ packDigest, packsRoot: this.deps.packsRoot, packages: records })
  }

  /** descriptor 校验 → 逐包安装 → overlay 生成（校验全部通过后才动 installer）。 */
  private async installAndOverlay(
    packDigest: string,
    descriptor: PluginPackDescriptor,
  ): Promise<PackOverlayResult> {
    const validated = this.validateDescriptor(packDigest, descriptor)
    const built = validated.map(async (pkg) => {
      const installed = await this.deps.installer.install(pkg.manifest, pkg.lock)
      return {
        manifest: pkg.manifest,
        configDigest: pkg.configDigest,
        treeDigest: installed.treeDigest,
        storePath: installed.path,
      }
    })
    return buildPackOverlay({
      packDigest,
      packsRoot: this.deps.packsRoot,
      packages: await Promise.all(built),
    })
  }

  /**
   * descriptor 全链校验（fail-closed）：
   * - 包名唯一；
   * - reviewed 信任级（第一阶段 normal pack 只收 reviewed，03 §2.5）；
   * - 可选 entry 与 manifest 身份字段逐项一致、configDigest 复算一致；
   * - packDigest 复算（synthesized entries 按 digestPluginPack 规范化）且与
   *   descriptor.packDigest、请求的 packDigest 三方一致；
   * - 逐包 lockfile 复算 digest 与 manifest.dependencyLockDigest 一致。
   */
  private validateDescriptor(
    packDigest: string,
    descriptor: PluginPackDescriptor,
  ): Array<{
    manifest: PluginManifest
    configDigest: string
    lock: ReturnType<typeof parseLockfile>
  }> {
    const names = new Set<string>()
    const entries: PluginPackEntry[] = []
    const validated: Array<{
      manifest: PluginManifest
      configDigest: string
      lock: ReturnType<typeof parseLockfile>
    }> = []
    for (const pkg of descriptor.packages) {
      const manifest = pkg.manifest
      if (names.has(manifest.name)) {
        throw new PluginPreflightError(
          'VALIDATION_FAILED',
          `descriptor has duplicate package ${manifest.name}`,
        )
      }
      names.add(manifest.name)
      if (manifest.review.status !== 'reviewed') {
        throw new PluginPreflightError(
          'PLUGIN_UNREVIEWED',
          `package ${manifest.name} is not reviewed for normal packs`,
        )
      }
      const configDigest = digestPluginCordisEntry(pluginCordisEntry(manifest))
      if (pkg.entry !== undefined) {
        const entry = pkg.entry
        if (
          entry.name !== manifest.name ||
          entry.version !== manifest.version ||
          entry.integrity !== manifest.integrity ||
          entry.dependencyLockDigest !== manifest.dependencyLockDigest ||
          entry.entrypoint !== manifest.entrypoint
        ) {
          throw new PluginPreflightError(
            'PLUGIN_PACK_MISMATCH',
            `descriptor entry identity drift for ${manifest.name}`,
          )
        }
        assertCordisEntryDigest(manifest, entry.configDigest)
      }
      entries.push({
        name: manifest.name,
        version: manifest.version,
        integrity: manifest.integrity,
        dependencyLockDigest: manifest.dependencyLockDigest,
        entrypoint: manifest.entrypoint,
        configDigest,
      })
      const lock = parseLockfile(pkg.lockfile)
      assertLockMatches(lock, {
        name: manifest.name,
        version: manifest.version,
        dependencyLockDigest: manifest.dependencyLockDigest,
      })
      validated.push({ manifest, configDigest, lock })
    }
    const computed = digestPluginPack({ schemaVersion: 1, packages: entries })
    if (computed !== descriptor.packDigest || computed !== packDigest) {
      throw new PluginPreflightError(
        'PLUGIN_PACK_MISMATCH',
        'plugin pack digest drift between descriptor and requested digest',
      )
    }
    return validated
  }
}

function short(digest: string): string {
  return digest.slice(0, 12)
}
