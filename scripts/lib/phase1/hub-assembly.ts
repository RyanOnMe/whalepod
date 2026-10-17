/**
 * E2E（Q5）的 Hub/Runtime 生产装配（#281）。
 *
 * 规则（#99 的 harness 纪律在 Hub 侧的收口）：E2E 只允许 spawn **包解析后的 dist
 * 生产产物**——Hub 走包内 `dist/server.js`（与 `deploy/hub.Dockerfile` 同形），
 * Runtime 走 `@whalepod/runtime` 的 `dist/bin.js`。源码路径入口（`apps/<name>/src/...`）
 * 在 scripts/ 下被 `check-boundaries` 的 `HARNESS_SRC_PATH_ALLOWLIST` 全面封禁，
 * 本模块的存在让「唯一的 Hub 装配点」不必再吃白名单例外。
 *
 * 另有「Q5 前强制 build」这一层：dist 可能是**上一次**构建的产物，源码改了没重建时
 * E2E 测的就是旧代码。装配前跑一次**增量** build（up-to-date 时 ~0.5s），失败即带
 * 输出退出——构建 break（tsc 报错）因此必然红在 Q5 起手上，而不是让浏览器门悄悄
 * 跑旧产物。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 注入点：构建执行器（测试可替换；抛错即视为构建失败）。 */
export interface WorkspaceBuildRunner {
  (input: { repoRoot: string }): string
}

export interface WorkspaceBuildDeps {
  readonly runBuild?: WorkspaceBuildRunner
}

/** E2E 需要的两个生产装配根（Hub server 与 Node 监督器拉起 Runtime 的 bin）。 */
const BUILD_FILTERS: readonly string[] = ['@whalepod/hub...', '@whalepod/runtime...']

const defaultRunBuild: WorkspaceBuildRunner = ({ repoRoot }) => {
  const args = ['--filter', BUILD_FILTERS[0]!, '--filter', BUILD_FILTERS[1]!, 'build']
  return execFileSync('pnpm', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' })
}

/**
 * Q5 前强制 build（#281）：增量构建 Hub 与 Runtime 的 dist 产物。
 * 失败时把构建输出的尾部一起抛出——构建 break 必须响亮、可归因。
 */
export function buildWorkspaceDistArtifacts(
  repoRoot: string | URL,
  deps: WorkspaceBuildDeps = {},
): void {
  const root = typeof repoRoot === 'string' ? repoRoot : fileURLToPath(repoRoot)
  const runBuild = deps.runBuild ?? defaultRunBuild
  try {
    runBuild({ repoRoot: root })
  } catch (error) {
    const tail = buildOutputTail(error)
    throw new Error(`e2e 装配前的增量构建失败（${BUILD_FILTERS.join(' ')}）：${tail}`, {
      cause: error,
    })
  }
}

function buildOutputTail(error: unknown): string {
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
  const stdout = typeof record.stdout === 'string' ? record.stdout : ''
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  const message = typeof record.message === 'string' ? record.message : String(error)
  const text = `${stdout}${stderr}`.trim()
  const tail = text === '' ? message : text.slice(-2_000)
  return tail
}

/**
 * 解析生产 Hub server 入口：借**锚点包**的依赖视角解析 `@whalepod/hub`（工作区
 * 符号链接 → 包内 dist），再取同目录的 `server.js`。锚点通常传
 * `apps/hub/package.json` 的路径/URL——与生产 Docker 入口同一个产物。
 */
export function resolveHubServerEntry(anchor: string | URL): string {
  const anchorPath = typeof anchor === 'string' ? anchor : fileURLToPath(anchor)
  const require = createRequire(anchorPath)
  let packageIndex: string
  try {
    packageIndex = require.resolve('@whalepod/hub')
  } catch (error) {
    throw new Error(
      `无法从锚点 ${anchorPath} 解析 @whalepod/hub（锚点必须位于本仓库内、且依赖已安装）：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  const entry = join(dirname(packageIndex), 'server.js')
  if (!existsSync(entry)) {
    throw new Error(
      `Hub 生产产物缺失：${entry}——先跑 pnpm -r build（或 pnpm --filter @whalepod/hub... build）`,
    )
  }
  return entry
}
