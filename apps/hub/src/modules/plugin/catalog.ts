/**
 * Curated 插件 catalog 的加载（02 Task 17 Step 3/7）。
 *
 * 目录布局（PROJECT311_PLUGIN_CATALOG_DIR，缺省仓库根 plugins/）：
 *   <dir>/catalog/<name>.json             PluginManifest（review overlay，置于 tarball 之外）
 *   <dir>/locks/<name>@<version>.lock.yaml 受审全依赖闭包 lockfile 原文
 *
 * fail-closed（02 Task 17 Step 3）：坏文件（非法 JSON、schema 拒绝、name@version
 * 重复、lock 缺失或为空）在启动时抛错、拒绝启动。目录本身不存在 = 尚未部署
 * curated catalog，按空 catalog 启动（没有任何可装包，安装面同样关死），不算坏文件。
 *
 * lock 文件按「不透明文本」处理：Hub 不引 yaml 依赖、不复算其内容 digest——
 * manifest.dependencyLockDigest 是 review 时的登记值，Hub 只做「文件按名匹配且
 * 存在」的身份校验；文本原样进 descriptor，由 Node preflight 用同一 digestLockfile
 * 算法（canonical JSON SHA-256，见 apps/node/src/plugin/lockfile.ts）复算内容一致性。
 * 这是两个方案中更简单且端到端仍 fail-closed 的选择。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PluginManifestSchema } from '@project311/protocol'
import type { PluginManifest } from '@project311/protocol'

export interface PluginCatalog {
  /** 全部 manifest，按 name、version 字典序稳定排序（GET /plugins/catalog 的顺序）。 */
  readonly manifests: readonly PluginManifest[]
  get(name: string, version: string): PluginManifest | undefined
  /** 受审依赖闭包 lockfile 的 yaml 原文（不透明文本）。 */
  lockfile(name: string, version: string): string | undefined
}

const EMPTY_CATALOG: PluginCatalog = {
  manifests: [],
  get: () => undefined,
  lockfile: () => undefined,
}

interface CatalogEntry {
  readonly manifest: PluginManifest
  readonly lockfile: string
}

/** lock 文件名约定（03 §2.5 语义：按 name@version 精确匹配）。 */
export function lockFileName(name: string, version: string): string {
  return `${name}@${version}.lock.yaml`
}

function byNameVersion(a: PluginManifest, b: PluginManifest): number {
  return a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
}

export async function loadPluginCatalog(dir: string): Promise<PluginCatalog> {
  const catalogDir = join(dir, 'catalog')
  const locksDir = join(dir, 'locks')
  let filenames: string[]
  try {
    filenames = await readdir(catalogDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_CATALOG
    throw error
  }

  const entries = new Map<string, CatalogEntry>()
  for (const filename of filenames.filter((f) => f.endsWith('.json')).sort()) {
    // 错误信息只含 catalog 相对名，不含绝对路径（红线：绝对路径不进日志）。
    const raw = await readFile(join(catalogDir, filename), 'utf8')
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`plugin catalog 文件不是合法 JSON：catalog/${filename}`)
    }
    const parsed = PluginManifestSchema.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue === undefined ? '' : `${issue.path.join('.')} ${issue.message}`
      throw new Error(
        `plugin catalog 清单校验失败：catalog/${filename}${where === '' ? '' : ` —— ${where}`}`,
      )
    }
    const manifest = parsed.data
    const key = `${manifest.name}@${manifest.version}`
    if (entries.has(key)) {
      throw new Error(`plugin catalog 重复登记：${key}（catalog/${filename}）`)
    }
    let lockfile: string
    try {
      lockfile = await readFile(
        join(locksDir, lockFileName(manifest.name, manifest.version)),
        'utf8',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `plugin catalog 不完整：locks/${lockFileName(manifest.name, manifest.version)} 缺失（catalog/${filename} 声明了该包）`,
        )
      }
      throw error
    }
    if (lockfile.trim() === '') {
      throw new Error(
        `plugin catalog lock 文件为空：locks/${lockFileName(manifest.name, manifest.version)}`,
      )
    }
    entries.set(key, { manifest, lockfile })
  }

  const manifests = [...entries.values()].map((entry) => entry.manifest).sort(byNameVersion)
  return {
    manifests,
    get: (name, version) => entries.get(`${name}@${version}`)?.manifest,
    lockfile: (name, version) => entries.get(`${name}@${version}`)?.lockfile,
  }
}
