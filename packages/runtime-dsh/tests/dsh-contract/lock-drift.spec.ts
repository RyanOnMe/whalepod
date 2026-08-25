/**
 * DSH 版本锁三方漂移检查（02 Task 11 Step 3，Q3 门的一部分）：
 * dsh.lock.json ↔ pnpm catalog（pnpm-workspace.yaml）↔ pnpm-lock.yaml
 * 三处的版本与 tarball integrity 必须一致；catalog 只允许精确版本。
 * 解析是窄而 fail-closed 的：找不到任一登记项即失败，不做通用 YAML 解析。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

interface LockManifest {
  schemaVersion: number
  verifiedAt: string
  packages: Record<string, { version: string; integrity: string }>
  requiredContracts: string[]
}

const REQUIRED_CONTRACTS = [
  'agents.create',
  'agent.followup',
  'agent.cancel',
  'agent.whenIdle',
  'session.event',
  'approval.request',
  'tools.register',
  'sessions.flush',
]

function readLockManifest(): LockManifest {
  return JSON.parse(readFileSync(`${REPO_ROOT}dsh.lock.json`, 'utf8')) as LockManifest
}

/** 从 pnpm-workspace.yaml 的 catalog 段取出登记包的精确版本。 */
function catalogVersion(workspaceYaml: string, name: string): string | undefined {
  const catalog = workspaceYaml.split('\n').find((line) => line.trim() === 'catalog:')
  expect(catalog, 'pnpm-workspace.yaml must declare a catalog').toBeDefined()
  const pattern = new RegExp(`^  '${name.replace(/[.*+?^${'{}()|[\]\\]/g, '\\$&')}': (.+)$`, 'm')
  return pattern.exec(workspaceYaml)?.[1]?.trim()
}

/** 从 pnpm-lock.yaml 的 packages 段取 tarball resolution。 */
function lockfileResolution(
  lockfile: string,
  name: string,
): { version: string; integrity: string } | undefined {
  const escaped = name.replace(/[.*+?^${'{}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `^  '?${escaped}@([0-9][^':]*)'?:\\n    resolution: \\{integrity: ([^}]+)\\}`,
    'm',
  )
  const match = pattern.exec(lockfile)
  if (!match) return undefined
  const [, version, integrity] = match
  return version === undefined || integrity === undefined ? undefined : { version, integrity }
}

describe('dsh.lock.json drift guard', () => {
  const manifest = readLockManifest()
  const workspaceYaml = readFileSync(`${REPO_ROOT}pnpm-workspace.yaml`, 'utf8')
  const lockfile = readFileSync(`${REPO_ROOT}pnpm-lock.yaml`, 'utf8')
  const runtimeDshManifest = JSON.parse(
    readFileSync(`${REPO_ROOT}packages/runtime-dsh/package.json`, 'utf8'),
  ) as { dependencies: Record<string, string> }

  it('declares schemaVersion 1, verifiedAt, and the eight required contracts', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect([...manifest.requiredContracts].sort()).toEqual([...REQUIRED_CONTRACTS].sort())
  })

  it('pins exactly the ten DSH direct dependencies', () => {
    expect(Object.keys(manifest.packages).sort()).toEqual(
      [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-app-boot',
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-replay',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-user-approval',
      ].sort(),
    )
  })

  it.each(Object.keys(manifest.packages))(
    '%s: lock manifest == catalog == pnpm lockfile (version + integrity)',
    (name) => {
      const locked = manifest.packages[name]
      expect(locked).toBeDefined()

      // catalog：精确版本，禁 range/tag。
      const catalog = catalogVersion(workspaceYaml, name)
      expect(catalog, `${name} must be pinned in the pnpm catalog`).toBeDefined()
      expect(catalog).toMatch(/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/)
      expect(catalog).toBe(locked?.version)

      // package manifest：runtime-dsh 只允许以 catalog: 引用。
      expect(runtimeDshManifest.dependencies[name]).toBe('catalog:')

      // pnpm lockfile：解析到同一版本与 integrity。
      const resolution = lockfileResolution(lockfile, name)
      expect(resolution, `${name} must resolve in pnpm-lock.yaml`).toBeDefined()
      expect(resolution?.version).toBe(locked?.version)
      expect(resolution?.integrity).toBe(locked?.integrity)
    },
  )
})
