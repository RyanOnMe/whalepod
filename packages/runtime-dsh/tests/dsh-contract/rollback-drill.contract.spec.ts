/**
 * 探针：升级失败回滚演练（#290）——熔断第四规则「升级失败回滚固定版」的机检半边。
 *
 * 背景：版本锁半边（`lock-drift.spec.ts`，Q3 门）钉的是三方一致；**回滚半边**此前只有
 * `.agents/skills/dsh-upgrade` 的流程文档，没有任何可复跑判据证明「按流程回滚真能回到
 * 能跑的状态」。本探针在**临时副本**上演练，判据与 Q3 门共用同一份检查
 * （`helpers/lock-drift.ts`，不复制逻辑）：
 *
 * - 部分升级（改了两处、漏一处）→ **必红**并点名漏的那处：门有牙；
 * - 版本与 tarball integrity 对不上（装错包/换包没换 integrity）→ **必红**；
 * - catalog 写成 range/tag、runtime-dsh 依赖不再 `catalog:` → **必红**；
 * - 整体升级三处自洽 → 门**不红**（升级本身不是漂移——门判的是一致性，不是"必须是旧版"）；
 * - 回滚 = 把四处文件还原成仓库当前的锁定副本 → 门绿，且**逐字节相同**（回到的是固定版，
 *   不是任意自洽态）；
 * - 锁 ↔ **实际安装树**一致：`dshDistributionInfo()`（#288 的版本自报，与 boot 锚同源）
 *   必须等于 `dsh.lock.json` 里 `@deepseek-ai/dsh` 的版本——回滚只还原 lock 而没重装/重建
 *   会被它抓住，也是"回滚后能跑"的最低含义。
 *
 * 边界（人工门，不在本探针内）：真实「在树上装另一个版本 → 触发一次已知不兼容 → 按流程
 * 回滚安装树」需要 registry/网络与真安装（`pnpm install`），CI 不做；步骤与预期输出写在
 * `.agents/skills/dsh-upgrade` 的「回滚」节，并如实标为人工门。
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { dshDistributionInfo } from '../../src/index.js'
import {
  checkDshLockDrift,
  readDshLockState,
  type DshLockManifest,
  type LockDriftFinding,
} from './helpers/lock-drift.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** 参与锁定态的四份文件（副本的相对布局与仓库一致）。 */
const LOCK_FILES = [
  'dsh.lock.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'packages/runtime-dsh/package.json',
] as const

/** 演练用的探针包：十项直接依赖之一（@deepseek-ai/dsh 自身由下面的安装树断言覆盖）。 */
const PROBE_PACKAGE = '@deepseek-ai/dsh-session'
const NEXT_VERSION = '0.1.0-rc.9'
const NEXT_INTEGRITY = `sha512-${'A'.repeat(86)}==`

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 从仓库当前锁定态复制一份临时副本（本探针只读仓库、只写副本）。 */
function copyLockStateToTemp(): string {
  const root = mkdtempSync(join(tmpdir(), 'whalepod-rollback-drill-'))
  tempDirs.push(root)
  for (const file of LOCK_FILES) {
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(REPO_ROOT, file), target)
  }
  return root
}

/** 「按流程回滚」= back 到仓库当前的锁定副本（真实流程里是 git 还原这四份文件 + 重装）。 */
function rollbackToPinned(root: string): void {
  for (const file of LOCK_FILES) copyFileSync(join(REPO_ROOT, file), join(root, file))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 模拟升级的三种落点（刻意各自独立，用来构造"漏改一处"的漂移）。 */
function setManifestEntry(root: string, name: string, version: string, integrity: string): void {
  const path = join(root, 'dsh.lock.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as DshLockManifest
  manifest.packages[name] = { version, integrity }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function setCatalogEntry(root: string, name: string, spec: string): void {
  const path = join(root, 'pnpm-workspace.yaml')
  const text = readFileSync(path, 'utf8')
  const line = new RegExp(`^(  '${escapeRegExp(name)}': ).*$`, 'm')
  expect(text, `${name} must be in the catalog`).toMatch(line)
  writeFileSync(path, text.replace(line, `$1${spec}`))
}

function setLockfileEntry(
  root: string,
  name: string,
  from: string,
  to: string,
  integrity: string,
): void {
  const path = join(root, 'pnpm-lock.yaml')
  const text = readFileSync(path, 'utf8')
  const block = new RegExp(
    `^(  '${escapeRegExp(name)}@)${escapeRegExp(from)}(':\\n    resolution: \\{integrity: )[^}]+(\\})`,
    'm',
  )
  expect(text, `${name}@${from} must resolve in pnpm-lock.yaml`).toMatch(block)
  writeFileSync(path, text.replace(block, `$1${to}$2${integrity}$3`))
}

function setRuntimeDshDependency(root: string, name: string, spec: string): void {
  const path = join(root, 'packages/runtime-dsh/package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies: Record<string, string>
  }
  manifest.dependencies[name] = spec
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function findingsOf(root: string): LockDriftFinding[] {
  return checkDshLockDrift(readDshLockState(root))
}

function kindsFor(findings: readonly LockDriftFinding[], name: string): string[] {
  return findings.filter((finding) => finding.package === name).map((finding) => finding.kind)
}

describe('probe: DSH rollback drill (#290)', () => {
  it('起点：仓库当前锁定态干净（副本上跑同一份检查，先立基线）', () => {
    const root = copyLockStateToTemp()
    expect(findingsOf(root)).toEqual([])
  })

  it('部分升级（lock + catalog 升了、pnpm-lock 漏改）→ 必红并点名漏的那处', () => {
    const root = copyLockStateToTemp()
    setManifestEntry(root, PROBE_PACKAGE, NEXT_VERSION, NEXT_INTEGRITY)
    setCatalogEntry(root, PROBE_PACKAGE, NEXT_VERSION)
    // pnpm-lock.yaml 不动——这正是"升级升到一半"的形态。

    expect(kindsFor(findingsOf(root), PROBE_PACKAGE)).toEqual(['lockfile-version-mismatch'])
  })

  it('版本换了但 tarball integrity 没换（装错包）→ 必红', () => {
    const root = copyLockStateToTemp()
    const pinned = readDshLockState(REPO_ROOT).manifest.packages[PROBE_PACKAGE]
    expect(pinned).toBeDefined()
    const pinnedIntegrity = pinned?.integrity ?? ''
    setManifestEntry(root, PROBE_PACKAGE, NEXT_VERSION, NEXT_INTEGRITY)
    setCatalogEntry(root, PROBE_PACKAGE, NEXT_VERSION)
    // 三处版本都到了新值，但 lockfile 的 integrity 还是旧包的——版本"对得上"、内容对不上。
    setLockfileEntry(root, PROBE_PACKAGE, pinned?.version ?? '', NEXT_VERSION, pinnedIntegrity)

    expect(kindsFor(findingsOf(root), PROBE_PACKAGE)).toEqual(['lockfile-integrity-mismatch'])
  })

  it('catalog 写成 latest 或 range → 必红（精确版本才作数）', () => {
    const root = copyLockStateToTemp()
    setCatalogEntry(root, PROBE_PACKAGE, 'latest')
    expect(kindsFor(findingsOf(root), PROBE_PACKAGE)).toEqual(['catalog-not-exact'])

    setCatalogEntry(root, PROBE_PACKAGE, '^0.1.0-rc.8')
    expect(kindsFor(findingsOf(root), PROBE_PACKAGE)).toEqual(['catalog-not-exact'])
  })

  it('runtime-dsh 依赖写成具体版本（不再 catalog:）→ 必红', () => {
    const root = copyLockStateToTemp()
    setRuntimeDshDependency(root, PROBE_PACKAGE, NEXT_VERSION)
    expect(kindsFor(findingsOf(root), PROBE_PACKAGE)).toEqual(['dependency-not-catalog'])
  })

  it('manifest 空清单 → 必红（逐包检查会空转成绿，先拦这个形态）', () => {
    const root = copyLockStateToTemp()
    const path = join(root, 'dsh.lock.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as DshLockManifest
    manifest.packages = {}
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(kindsFor(findingsOf(root), '*')).toEqual(['manifest-empty'])
  })

  it('整体升级三处自洽 → 门不红；按流程回滚到锁定副本 → 绿且与仓库文件逐字节相同', () => {
    const root = copyLockStateToTemp()
    const pinned = readDshLockState(REPO_ROOT).manifest.packages[PROBE_PACKAGE]
    expect(pinned).toBeDefined()

    // 升级：三处一起到新版本、integrity 一起换新（自洽的新锁定态）——门判一致性，不判新旧。
    setManifestEntry(root, PROBE_PACKAGE, NEXT_VERSION, NEXT_INTEGRITY)
    setCatalogEntry(root, PROBE_PACKAGE, NEXT_VERSION)
    setLockfileEntry(root, PROBE_PACKAGE, pinned?.version ?? '', NEXT_VERSION, NEXT_INTEGRITY)
    expect(findingsOf(root)).toEqual([])

    // 回滚：还原成仓库当前锁定副本 → 门绿，且回到的是**固定版**（逐字节相同），
    // 不是"某个自洽态"。
    rollbackToPinned(root)
    expect(findingsOf(root)).toEqual([])
    for (const file of LOCK_FILES) {
      expect(readFileSync(join(root, file), 'utf8'), `${file} must be byte-identical`).toBe(
        readFileSync(join(REPO_ROOT, file), 'utf8'),
      )
    }
  })

  it('锁 ↔ 实际安装树一致：版本自报（#288）必须等于 dsh.lock 登记版本', () => {
    // 这一条判的是"回滚只还原了 lock 而没重装/重建"的形态：树里装的是新版、锁是旧版
    // 时，本断言红。它同时是 Q9 设备视图判据（dshDistributionVersion == lock）的本机版。
    const state = readDshLockState(REPO_ROOT)
    const locked = state.manifest.packages['@deepseek-ai/dsh']
    expect(locked).toBeDefined()
    expect(dshDistributionInfo().version).toBe(locked?.version)
  })
})
