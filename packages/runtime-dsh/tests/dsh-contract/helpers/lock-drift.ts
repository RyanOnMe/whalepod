/**
 * DSH 版本锁状态的**单一读取面与三方一致性检查**（Q3 门与回滚演练共用，#290）：
 * `dsh.lock.json` ↔ pnpm catalog（`pnpm-workspace.yaml`）↔ `pnpm-lock.yaml` 三处的
 * 版本与 tarball integrity 必须一致；catalog 只允许精确版本；`packages/runtime-dsh`
 * 只允许以 `catalog:` 引用。解析窄而 fail-closed：登记项缺失即**报告**（不抛、不跳过），
 * 不引入 YAML 解析库。
 *
 * 为什么抽成可参数化根目录的函数（#290）：「升级失败回滚固定版」的机检半边要在
 * **临时副本**上演练（部分升级必红 / 回滚到锁定副本必绿 / 伪造 integrity 必红），
 * 而演练必须跑**与 Q3 门同一份**检查——复制一套逻辑就失去了演练意义。
 *
 * 覆盖边界（如实）：本检查判的是**仓库文件之间**的一致性，不判「实际安装树」是否
 * 等于锁定版本；那一环由 `dshDistributionInfo()` 的版本自报（#288）与 Q9 的设备视图
 * 覆盖，回滚演练里有一条把两者串起来的断言。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DshLockManifest {
  schemaVersion: number
  verifiedAt: string
  packages: Record<string, { version: string; integrity: string }>
  requiredContracts: string[]
}

export interface DshLockState {
  manifest: DshLockManifest
  workspaceYaml: string
  lockfile: string
  runtimeDshDependencies: Record<string, string>
}

export type LockDriftKind =
  | 'manifest-empty'
  | 'catalog-missing'
  | 'catalog-not-exact'
  | 'catalog-version-mismatch'
  | 'dependency-not-catalog'
  | 'lockfile-missing'
  | 'lockfile-version-mismatch'
  | 'lockfile-integrity-mismatch'

export interface LockDriftFinding {
  kind: LockDriftKind
  /** 出问题的包；`manifest-empty` 这类全局项为 `*`。 */
  package: string
  detail: string
}

/** 读四处文件（缺任一即抛——读取失败不是漂移，是环境坏了，不该被当成"绿"）。 */
export function readDshLockState(root: string): DshLockState {
  return {
    manifest: JSON.parse(readFileSync(join(root, 'dsh.lock.json'), 'utf8')) as DshLockManifest,
    workspaceYaml: readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    lockfile: readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
    runtimeDshDependencies: (
      JSON.parse(readFileSync(join(root, 'packages/runtime-dsh/package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }
    ).dependencies,
  }
}

/** 从 pnpm-workspace.yaml 的 catalog 段取登记包的版本声明原文（窄解析：只认那一行）。 */
export function catalogVersion(workspaceYaml: string, name: string): string | undefined {
  const catalog = workspaceYaml.split('\n').find((line) => line.trim() === 'catalog:')
  if (catalog === undefined) return undefined
  const pattern = new RegExp(`^  '${escapeRegExp(name)}': (.+)$`, 'm')
  return pattern.exec(workspaceYaml)?.[1]?.trim()
}

/** 从 pnpm-lock.yaml 的 packages 段取 tarball resolution（窄解析：只认版本键 + integrity 行）。 */
export function lockfileResolution(
  lockfile: string,
  name: string,
): { version: string; integrity: string } | undefined {
  const pattern = new RegExp(
    `^  '?${escapeRegExp(name)}@([0-9][^':]*)'?:\\n    resolution: \\{integrity: ([^}]+)\\}`,
    'm',
  )
  const match = pattern.exec(lockfile)
  if (!match) return undefined
  const [, version, integrity] = match
  return version === undefined || integrity === undefined ? undefined : { version, integrity }
}

/** 精确版本（禁 range/tag/latest）。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/

/**
 * 三方一致性检查：返回全部 findings（空数组 = 一致）。逐包逐项报告，
 * 归因信息（kind + package）足以定位到「哪一处漏改」。
 */
export function checkDshLockDrift(state: DshLockState): LockDriftFinding[] {
  const findings: LockDriftFinding[] = []
  const names = Object.keys(state.manifest.packages)
  // 防空转绿：packages 为空时下面逐包循环一条都不报——先拦住这个形态。
  if (names.length === 0) {
    findings.push({
      kind: 'manifest-empty',
      package: '*',
      detail: 'dsh.lock.json declares no packages; the per-package checks below would be vacuous',
    })
  }
  for (const name of names) {
    const locked = state.manifest.packages[name]
    if (locked === undefined) continue

    // catalog：必须登记、必须是精确版本、必须等于锁。
    const catalog = catalogVersion(state.workspaceYaml, name)
    if (catalog === undefined) {
      findings.push({
        kind: 'catalog-missing',
        package: name,
        detail: 'pinned in dsh.lock.json but missing from the pnpm catalog',
      })
    } else if (!EXACT_VERSION.test(catalog)) {
      findings.push({
        kind: 'catalog-not-exact',
        package: name,
        detail: `catalog declares ${JSON.stringify(catalog)}; only exact versions are allowed`,
      })
    } else if (catalog !== locked.version) {
      findings.push({
        kind: 'catalog-version-mismatch',
        package: name,
        detail: `catalog=${catalog} vs lock=${locked.version}`,
      })
    }

    // package manifest：runtime-dsh 只允许 catalog: 引用。
    if (state.runtimeDshDependencies[name] !== 'catalog:') {
      findings.push({
        kind: 'dependency-not-catalog',
        package: name,
        detail: `packages/runtime-dsh/package.json declares ${JSON.stringify(
          state.runtimeDshDependencies[name] ?? null,
        )}; DSH dependencies must be "catalog:"`,
      })
    }

    // pnpm lockfile：必须解析到同一版本与 integrity。
    const resolution = lockfileResolution(state.lockfile, name)
    if (resolution === undefined) {
      findings.push({
        kind: 'lockfile-missing',
        package: name,
        detail: `no resolution for @${locked.version} in pnpm-lock.yaml`,
      })
    } else if (resolution.version !== locked.version) {
      findings.push({
        kind: 'lockfile-version-mismatch',
        package: name,
        detail: `pnpm-lock=${resolution.version} vs lock=${locked.version}`,
      })
    } else if (resolution.integrity !== locked.integrity) {
      findings.push({
        kind: 'lockfile-integrity-mismatch',
        package: name,
        detail: `pnpm-lock integrity differs from dsh.lock.json for @${locked.version}`,
      })
    }
  }
  return findings
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?${}()|[\]\\]/g, '\\$&')
}
