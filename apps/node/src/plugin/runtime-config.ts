/**
 * Plugin Pack → Runtime Cordis overlay（P1-17；02 Task 17 Step 5）。
 *
 * 输入是 preflight 校验过的 pack descriptor（逐包 manifest + 已发布到
 * content store 的包树绝对路径）；输出是确定性的 overlay yml——一个
 * `@deepseek-ai/cordis-plugin-include` PatchOptions 顶层 YAML 数组，每包一条
 * `{ insert: [{ id, name, config }] }` 行（形状对齐 loader 的 EntryOptions：
 * id=树内稳定 id、name=模块 specifier、config=插件配置；本文件不 import
 * @deepseek-ai/* 的类型或值，按 dsh-app-boot 0.1.0-rc.8 的 lib/types 结构注释
 * 对齐）。Hub 不参与本文件的任何执行面。
 *
 * 模块解析策略（调研 @deepseek-ai/dsh-app-boot@0.1.0-rc.8 与
 * cordis-plugin-loader@1.0.2 源码后选定）：
 * - loader 的 EntryTree.import：bare specifier 交给
 *   `loader.internal.import(name, baseUrl)`；relative specifier（`./` 开头）按
 *   `new URL(name, ctx.baseUrl)` 解析。
 * - dsh-app-boot 的 `boot()`：`ctx.baseUrl` = cordis.yml 所在目录
 *   （runtime-dsh 包内 config/）；`mountRootInclude` 在传入 bareModuleBaseUrl
 *   时安装 HostResolvedRootInclude——bare specifier 一律
 *   `internal.import(specifier, bareModuleBaseUrl)`，而 packages/runtime-dsh 的
 *   bridge.ts 已把该锚钉死为 `@deepseek-ai/dsh` 的 realpath（宿主拥有完整插件
 *   集），Node 侧不可改。
 * - 结论：bare name 的 node_modules 走查链从 DSH 宿主锚目录向上，永远到不了
 *   Device 本机数据目录 `<packsRoot>/<packDigest>/node_modules`；relative
 *   specifier 则从 runtime-dsh 的安装布局解析，深度随部署形态漂移。两条路都
 *   无法稳定命中本机 store。
 * - 采用：rows.name 写**绝对路径 specifier**，指向 pack 目录内的
 *   `node_modules/<name>` symlink 锚（锚 → store 包目录）。mountRootInclude 对
 *   `isAbsolute(name)` 显式 `pathToFileURL` 后直连 import，与 parent/baseUrl 完
 *   全解耦，不依赖 DSH 宿主安装布局。overlay 是本地 wire 产物，绝对路径不进
 *   Hub、日志与 evidence（红线同 runtime-wire 的 workspacePath）。
 * - symlink 锚保留 node_modules 语义：若后续 runtime 把 bareModuleBaseUrl 指向
 *   resolutionBaseDir，rows 改回 bare name + entrypoint 子路径即可，pack 目录
 *   无需重排。锚的建立幂等；失败报 PluginError（fail-closed）。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import {
  ExactVersionSchema,
  NpmPackageNameSchema,
  cordisEntryId,
  pluginCordisEntry,
  type PluginManifest,
} from '@whalepod/protocol'
import { compareCodePoints, digestPluginCordisEntry } from '@whalepod/protocol/plugin-pack-digest'
import { PluginError } from './integrity.js'

/** marker 文件名：pack 目录的就绪标记（含逐包 store 树 digest 回执）。 */
export const PACK_MARKER_FILENAME = 'pack.json'
/** overlay yml 文件名：Runtime 以 patch 层加载的 Cordis insert 列表。 */
export const PACK_OVERLAY_FILENAME = 'cordis.overlay.yml'

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)

/** pack 目录 marker（我们自己的落盘回执；不含绝对路径——storePath 由 treeDigest 现查）。 */
export const PackMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packDigest: Sha256HexSchema,
  packages: z.array(
    z.strictObject({
      name: NpmPackageNameSchema,
      version: ExactVersionSchema,
      entrypoint: z.string().min(1),
      treeDigest: Sha256HexSchema,
    }),
  ),
})
export type PackMarker = z.infer<typeof PackMarkerSchema>

/** 一条插件的 overlay 行（EntryOptions 的路径无关超集里本 slice 用到的三键）。 */
export interface PackOverlayRow {
  /** Cordis 树内稳定 id（cordisEntryId(name)，`@scope/pkg` → `scope--pkg`）。 */
  readonly id: string
  /** 模块 specifier（本 slice：node_modules 锚 + entrypoint 的绝对路径）。 */
  readonly name: string
  /** 插件 config（第一阶段 catalog 不带插件配置，恒为空对象）。 */
  readonly config: Record<string, unknown>
}

/** ensurePackOverlay 的输入记录（marker/preflight 都生产它）。 */
export interface PackPackageRecord {
  readonly name: string
  readonly version: string
  readonly entrypoint: string
  /** 该包在 content store 发布的树 digest。 */
  readonly treeDigest: string
  /** store 包目录绝对路径（store.lookup(treeDigest) 的回执）。 */
  readonly storePath: string
}

/** buildPackOverlay 的逐包输入：descriptor 里的 manifest + preflight 复算的 digest。 */
export interface PackOverlayBuildPackage {
  readonly manifest: PluginManifest
  /** pack entry 声明的 configDigest（重装路径来自 descriptor 复算链）。 */
  readonly configDigest: string
  readonly treeDigest: string
  readonly storePath: string
}

export interface PackOverlayResult {
  readonly overlayPath: string
  readonly overlayYaml: string
  /** 解析锚所在目录（含 node_modules/ 与 overlay yml）。 */
  readonly resolutionBaseDir: string
}

/**
 * 复算 `digestPluginCordisEntry(pluginCordisEntry(manifest))` 与 pack entry 的
 * configDigest 比对：漂移即 PluginError（fail-closed，G-契约）。
 */
export function assertCordisEntryDigest(manifest: PluginManifest, configDigest: string): void {
  const computed = digestPluginCordisEntry(pluginCordisEntry(manifest))
  if (computed !== configDigest) {
    throw new PluginError(
      'INTEGRITY_MISMATCH',
      `plugin cordis entry config digest drift for ${manifest.name}`,
    )
  }
}

/** 确定性渲染 overlay yml：rows 内部按 name 排序（调用方次序无关），键序由构造顺序决定。
 *
 * 行只产 `{ id, name, config }`：ctx.* 服务需求（cordis 按 fiber.inject 把门）
 * 由插件源码自声明 `export const inject = [...]`——生态契约，宿主原样挂载、
 * 不代标（02 Task 17 Step 5：不 patch/注入/重写插件源码）。catalog review
 * 负责挡住缺 inject 声明的 ctx.* 插件（Q3 探针实证，见 packages/runtime-dsh
 * tests/dsh-contract/helpers/pack-overlay.ts 头注）。
 */
export function renderPackOverlayYaml(rows: readonly PackOverlayRow[], packDigest: string): string {
  const patches = [...rows]
    .sort((a, b) => compareCodePoints(a.name, b.name))
    .map((row) => ({
      insert: [{ id: row.id, name: row.name, config: row.config }],
    }))
  const header =
    '# whalepod plugin pack overlay — generated by node preflight (P1-17); do not edit.\n' +
    `# pack: ${packDigest}\n`
  // lineWidth 0：绝对路径行绝不折叠（折叠会破坏确定性字节输出）。
  return header + stringifyYaml(patches, { lineWidth: 0, indent: 2 })
}

/**
 * 重装路径的 overlay 生成：先逐包复算 entry digest（漂移拒绝），再落 pack 布局。
 * 输入的 manifest 来自 descriptor 校验链，storePath 来自 installer 发布回执。
 */
export function buildPackOverlay(input: {
  readonly packDigest: string
  readonly packsRoot: string
  readonly packages: readonly PackOverlayBuildPackage[]
}): PackOverlayResult {
  const records = input.packages.map((pkg) => {
    assertCordisEntryDigest(pkg.manifest, pkg.configDigest)
    if (!existsSync(pkg.storePath)) {
      throw new PluginError('STORE_IO', 'plugin package store tree is missing')
    }
    return {
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      entrypoint: pkg.manifest.entrypoint,
      treeDigest: pkg.treeDigest,
      storePath: pkg.storePath,
    } satisfies PackPackageRecord
  })
  return ensurePackOverlay({
    packDigest: input.packDigest,
    packsRoot: input.packsRoot,
    packages: records,
  })
}

/**
 * 幂等落 pack 目录：marker（pack.json）+ `node_modules/<name>` symlink 锚 +
 * overlay yml（tmp+rename 原子写；内容相同不重写）。marker 已存在但内容不一致
 * 时按当前（已经过完整 digest 链验证的）输入重写——本函数只在 descriptor 校验
 * 或本地 marker 命中后到达，不会被未验证内容驱动。
 */
export function ensurePackOverlay(input: {
  readonly packDigest: string
  readonly packsRoot: string
  readonly packages: readonly PackPackageRecord[]
}): PackOverlayResult {
  if (input.packages.length === 0) {
    throw new PluginError('VALIDATION_FAILED', 'plugin pack must contain at least one package')
  }
  const packDir = join(input.packsRoot, input.packDigest)
  try {
    mkdirSync(packDir, { recursive: true })
  } catch {
    throw new PluginError('STORE_IO', 'failed to create plugin pack directory')
  }
  const sorted = [...input.packages].sort((a, b) => compareCodePoints(a.name, b.name))
  ensureMarker(packDir, input.packDigest, sorted)
  for (const pkg of sorted) ensureAnchor(packDir, pkg.name, pkg.storePath)
  const overlayYaml = renderPackOverlayYaml(
    sorted.map((pkg) => ({
      id: cordisEntryId(pkg.name),
      name: join(join(packDir, 'node_modules', pkg.name), pkg.entrypoint),
      config: {},
    })),
    input.packDigest,
  )
  const overlayPath = join(packDir, PACK_OVERLAY_FILENAME)
  writeFileIfChanged(overlayPath, overlayYaml)
  return { overlayPath, overlayYaml, resolutionBaseDir: packDir }
}

/** marker 期望内容（排序去路径）。 */
function desiredMarker(packDigest: string, packages: readonly PackPackageRecord[]): PackMarker {
  return {
    schemaVersion: 1,
    packDigest,
    packages: packages.map(({ name, version, entrypoint, treeDigest }) => ({
      name,
      version,
      entrypoint,
      treeDigest,
    })),
  }
}

function markerEquals(a: PackMarker, b: PackMarker): boolean {
  return (
    a.packDigest === b.packDigest &&
    a.packages.length === b.packages.length &&
    a.packages.every((pkg, i) => {
      const other = b.packages[i]
      return (
        other !== undefined &&
        pkg.name === other.name &&
        pkg.version === other.version &&
        pkg.entrypoint === other.entrypoint &&
        pkg.treeDigest === other.treeDigest
      )
    })
  )
}

function ensureMarker(
  packDir: string,
  packDigest: string,
  packages: readonly PackPackageRecord[],
): void {
  const desired = desiredMarker(packDigest, packages)
  const path = join(packDir, PACK_MARKER_FILENAME)
  let existing: unknown
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    const parsed = PackMarkerSchema.safeParse(existing)
    if (parsed.success && markerEquals(parsed.data, desired)) return
    // 内容漂移（外部篡改/旧版本残留）：按已验证的期望内容重写。
  }
  writeAtomic(path, `${JSON.stringify(desired, null, 2)}\n`)
}

/** `node_modules/<name>` → store 包目录的 symlink 锚（幂等、dangling 自愈）。 */
function ensureAnchor(packDir: string, name: string, storePath: string): void {
  const anchor = join(packDir, 'node_modules', name)
  try {
    mkdirSync(join(anchor, '..'), { recursive: true })
  } catch {
    throw new PluginError('STORE_IO', 'failed to create plugin pack anchor directory')
  }
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(anchor)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new PluginError('STORE_IO', 'plugin pack anchor path is not a symlink')
    }
    if (readlinkSync(anchor) === storePath) return
    // 只摘链不递归（目标始终是本 Node 管的 store 目录）。注意 macOS/Node 的
    // rmSync 对 dangling symlink 会假成功（目录项残留），摘链必须 unlinkSync：
    // 它只作用于链接本身，绝不会触到 store 目标。
    unlinkSync(anchor)
  }
  try {
    symlinkSync(storePath, anchor, 'dir')
  } catch {
    // 并发竞态（同 pack 重复 preflight）：已被挂成同目标 symlink 即幂等通过。
    try {
      if (lstatSync(anchor).isSymbolicLink() && readlinkSync(anchor) === storePath) return
    } catch {
      // 落入下方失败路径。
    }
    throw new PluginError('STORE_IO', 'failed to anchor plugin package into the pack directory')
  }
}

/** 原子写：同内容不重写（幂等），不同内容 tmp+rename。 */
function writeFileIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    // 不存在/不可读 → 走写入。
  }
  writeAtomic(path, content)
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 })
    renameSync(tmp, path)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响失败上报。
    }
    throw new PluginError('STORE_IO', 'failed to write plugin pack file')
  }
}

/**
 * 本地已就绪 pack 的 digest 列表（node.hello pluginPackDigests 上报源）：
 * packs 目录下 64-hex 子目录且 marker 校验通过（packDigest 与目录名一致、
 * 逐包记录完整）。损坏/半途目录不上报（Hub 不会为其派发 Run；下次 preflight
 * 走 descriptor 全链重装）。
 */
export function installedPackDigests(packsRoot: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(packsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const digests: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
    try {
      const marker = PackMarkerSchema.parse(
        JSON.parse(readFileSync(join(packsRoot, entry.name, PACK_MARKER_FILENAME), 'utf8')),
      )
      if (marker.packDigest === entry.name && marker.packages.length > 0) {
        digests.push(entry.name)
      }
    } catch {
      // 未就绪/损坏：不上报。
    }
  }
  return digests.sort(compareCodePoints)
}
