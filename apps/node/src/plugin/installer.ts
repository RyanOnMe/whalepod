/**
 * 插件安装器（02 Task 17 Step 4；04 §6.5 攻击矩阵执行面）。
 *
 * 流程：manifest schema（protocol 层已拒 range/tag/git/local path）→
 * lockfile digest 比对 → 逐个拉取根包+闭包 tarball（HTTPS host allowlist +
 * 单包字节上限 + SRI 校验）→ 安全解包（tar.ts：拒绝绝对/越界路径、
 * symlink/hardlink/设备节点）→ **绝不运行任何 lifecycle script / native
 * addon**（第一阶段无构建步骤，源码树原样入 store）→ 树 digest 原子发布。
 */
import { PluginManifestSchema, type PluginManifest } from '@project311/protocol'
import { PluginError, verifyIntegrity } from './integrity.js'
import { assertLockMatches, type PluginLockfile } from './lockfile.js'
import { PackageStore } from './package-store.js'
import { unpackTarGz } from './tar.js'

/** fetch 注入缝：测试用内存字节服务；生产用全局 fetch。 */
export type PluginFetch = (url: string) => Promise<{ status: number; body: Buffer }>

export interface InstallerOptions {
  readonly store: PackageStore
  readonly fetchImpl: PluginFetch
  /** tarball URL host 白名单（默认仅 registry.npmjs.org）。 */
  readonly allowedHosts: readonly string[]
  /** 单 tarball 字节上限（tarbomb 第一道闸）。 */
  readonly maxTarballBytes: number
}

export interface InstallResult {
  readonly treeDigest: string
  /** 已发布包树的绝对路径。 */
  readonly path: string
  /** 实际落盘的包内相对文件清单。 */
  readonly files: readonly string[]
}

export const DEFAULT_ALLOWED_HOSTS = ['registry.npmjs.org'] as const
export const DEFAULT_MAX_TARBALL_BYTES = 8 * 1024 * 1024

export class PluginInstaller {
  constructor(private readonly options: InstallerOptions) {}

  /**
   * 安装 manifest + 其受审 lockfile 描述的完整闭包。任何一步失败：
   * 临时目录销毁，store 无残留（要么完整发布，要么不存在）。
   */
  async install(manifestInput: unknown, lock: PluginLockfile): Promise<InstallResult> {
    const manifestParsed = PluginManifestSchema.safeParse(manifestInput)
    if (!manifestParsed.success) {
      throw new PluginError(
        'VALIDATION_FAILED',
        `manifest rejected: ${manifestParsed.error.message}`,
      )
    }
    const manifest: PluginManifest = manifestParsed.data
    assertLockMatches(lock, {
      name: manifest.name,
      version: manifest.version,
      dependencyLockDigest: manifest.dependencyLockDigest,
    })

    const staging = this.options.store.beginStaging()
    try {
      const files: string[] = []
      // 根包（npm tarball 的根前缀 package/ 剥掉）+ 依赖闭包（node_modules/<name>/）。
      await this.installTarball(manifest.tarballUrl, manifest.integrity, staging, '', files)
      for (const dep of lock.dependencies) {
        await this.installTarball(
          dep.resolved,
          dep.integrity,
          staging,
          `node_modules/${dep.name}`,
          files,
        )
      }
      const tree = await this.options.store.finalize(staging)
      return { ...tree, files }
    } catch (error) {
      this.options.store.discard(staging)
      throw error
    }
  }

  private assertHost(url: string): void {
    const host = new URL(url).host
    if (!this.options.allowedHosts.includes(host)) {
      throw new PluginError('HOST_NOT_ALLOWED', `tarball host not in allowlist: ${host}`)
    }
  }

  private async installTarball(
    url: string,
    integrity: string,
    staging: string,
    prefix: string,
    files: string[],
  ): Promise<void> {
    this.assertHost(url)
    const response = await this.options.fetchImpl(url)
    if (response.status !== 200) {
      throw new PluginError('STORE_IO', `tarball fetch failed (${response.status}): ${url}`)
    }
    if (response.body.length > this.options.maxTarballBytes) {
      throw new PluginError(
        'SIZE_LIMIT_EXCEEDED',
        `tarball over ${this.options.maxTarballBytes} bytes: ${url}`,
      )
    }
    verifyIntegrity(response.body, integrity)
    const entries = unpackTarGz(response.body)
    const tarEntries = entries.map((entry) => ({
      ...entry,
      // npm tarball 根前缀 package/ 剥掉；依赖挂到 node_modules/<name>/ 下。
      path:
        prefix === ''
          ? entry.path.replace(/^package\//, '')
          : `${prefix}/${entry.path.replace(/^package\//, '')}`,
    }))
    for (const entry of tarEntries) {
      if (entry.kind === 'file') files.push(entry.path)
    }
    await this.options.store.writeEntries(staging, tarEntries)
  }
}
