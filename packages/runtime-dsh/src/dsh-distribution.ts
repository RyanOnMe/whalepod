/**
 * 本机 DSH 发行版身份（#288）。
 *
 * 熔断规则「敏感不兼容禁启动」需要一个**真实的**左侧操作数：本机会实际加载哪一版
 * DSH。这个答案只有 Runtime 一侧给得出——它是唯一允许 import `@deepseek-ai/*` 的
 * 层（02 依赖方向），业务层（Node/Hub）不得自己解析这个包。
 *
 * 解析锚与 boot 的 bare plugin 锚（bridge 的 dshAnchorUrl）同源：同一个
 * `@deepseek-ai/dsh/package.json` realpath。所以这里报出的版本就是本 Runtime 真要
 * 加载的那棵树里的版本，而不是操作者声明的字符串；两处若漂移，契约探针当场红
 *（tests/dsh-contract/dsh-distribution.contract.spec.ts）。
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export interface DshDistributionInfo {
  readonly name: string
  readonly version: string
  /** 包根目录绝对路径（本地事实：不进 Hub、日志与证据，红线同 workspacePath）。 */
  readonly packageDir: string
}

/** `@deepseek-ai/dsh` 的 package.json realpath。 */
function resolveDshPackageJson(): string {
  return realpathSync(require.resolve('@deepseek-ai/dsh/package.json'))
}

/**
 * boot 的 bare plugin 解析锚：`@deepseek-ai/dsh` CLI 包的真实路径（realpath 后进
 * pnpm 虚拟 store，bare plugin specifier 经父目录遍历命中其依赖与 hoist 面，
 * 与 dsh-app-boot `boot()` 的 bareModuleBaseUrl 契约一致——宿主拥有完整插件集）。
 */
export function dshAnchorUrl(): string {
  return pathToFileURL(resolveDshPackageJson()).href
}

/**
 * 自报本机 DSH 发行版身份。package.json 缺 name/version 时 fail loud（畸形安装树
 * 不猜版本——调用方按「不可知」fail-closed 处理）。
 */
export function dshDistributionInfo(): DshDistributionInfo {
  const packageJsonPath = resolveDshPackageJson()
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  if (
    typeof parsed.name !== 'string' ||
    parsed.name === '' ||
    typeof parsed.version !== 'string' ||
    parsed.version === ''
  ) {
    throw new Error('dsh distribution package.json is missing name/version')
  }
  return {
    name: parsed.name,
    version: parsed.version,
    packageDir: dirname(packageJsonPath),
  }
}

/** `file://` 锚对应的本地路径（探针断言与观测用；不进 wire）。 */
export function dshAnchorPath(): string {
  return fileURLToPath(dshAnchorUrl())
}
