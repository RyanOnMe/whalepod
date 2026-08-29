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

/**
 * fetch 注入缝：测试用内存字节服务；生产用全局 fetch（redirect: 'manual'）。
 * 3xx 时 location 原样透出（生产 fetchImpl 从 Location 头取；测试可脚本化
 * 重定向链）——installer 层逐跳 assertHost 后再跟随（M3）。
 */
export interface PluginFetchResponse {
  readonly status: number
  readonly location?: string
  readonly body: Buffer
}
export type PluginFetch = (url: string) => Promise<PluginFetchResponse>

/** 重定向跳数上限：每跳独立过 host 白名单，超限按白名单拒绝同码 fail-closed。 */
export const MAX_TARBALL_REDIRECTS = 5

/**
 * 流式读响应 body 并按字节上限截断（M4：生产 fetch 适配器第一道闸）。
 * 超 maxBytes 立即抛 SIZE_LIMIT_EXCEEDED，不把无界 body 收满进内存；
 * 调用方在 catch 里 cancel 底层流以中止下载。
 */
export async function readCappedBody(
  source: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (source === null) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk)
    if (total + bytes.length > maxBytes) {
      throw new PluginError('SIZE_LIMIT_EXCEEDED', 'tarball body exceeds byte limit')
    }
    total += bytes.length
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

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
      // 固定话术：重定向 Location 是攻击者可控串，host 不回显进错误消息。
      throw new PluginError('HOST_NOT_ALLOWED', 'tarball host not in allowlist')
    }
  }

  /**
   * 拉取 tarball 字节（M3：3xx 逐跳跟随，**每一跳**都过 assertHost——初始
   * URL 白名单不再因一次重定向失效；Location 头攻击者可控，错误消息不回显；
   * M4：生产路径的 body 已在 fetchImpl 流式截断，这里的长度检查兜底注入
   * 路径（测试内存 fetch 直接给完整 body））。
   */
  private async fetchTarball(url: string): Promise<Buffer> {
    let current = url
    for (let redirects = 0; ; redirects += 1) {
      this.assertHost(current)
      const response = await this.options.fetchImpl(current)
      if (response.status >= 300 && response.status < 400) {
        if (response.location === undefined) {
          throw new PluginError('STORE_IO', `tarball fetch failed (${response.status})`)
        }
        if (redirects >= MAX_TARBALL_REDIRECTS) {
          // 跳数超限 = 重定向环风险：与 host 白名单拒绝同码（HOST_NOT_ALLOWED）。
          throw new PluginError('HOST_NOT_ALLOWED', 'tarball redirect chain exceeds limit')
        }
        let next: string
        try {
          next = new URL(response.location, current).toString()
        } catch {
          throw new PluginError('HOST_NOT_ALLOWED', 'tarball redirect location is not a valid URL')
        }
        current = next
        continue
      }
      if (response.status !== 200) {
        throw new PluginError('STORE_IO', `tarball fetch failed (${response.status})`)
      }
      if (response.body.length > this.options.maxTarballBytes) {
        throw new PluginError(
          'SIZE_LIMIT_EXCEEDED',
          `tarball over ${this.options.maxTarballBytes} bytes`,
        )
      }
      return response.body
    }
  }

  private async installTarball(
    url: string,
    integrity: string,
    staging: string,
    prefix: string,
    files: string[],
  ): Promise<void> {
    const body = await this.fetchTarball(url)
    verifyIntegrity(body, integrity)
    const entries = unpackTarGz(body)
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
