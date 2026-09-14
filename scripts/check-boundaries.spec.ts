import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkRunStatusChokePoint,
  checkTypecheckWiring,
  validateImport,
} from './check-boundaries.js'

const DSH_ERROR = 'DSH imports are restricted to packages/runtime-dsh and apps/runtime'

describe('DSH isolation', () => {
  it('blocks DSH imports outside runtime packages', () => {
    expect(() => validateImport('apps/hub/src/app.ts', '@deepseek-ai/dsh-agent')).toThrow(DSH_ERROR)
  })

  it('blocks the DSH root package and cordis outside runtime packages', () => {
    for (const specifier of [
      '@deepseek-ai/dsh',
      '@deepseek-ai/cordis',
      '@deepseek-ai/cordis/plugin',
    ]) {
      expect(() => validateImport('packages/domain/src/index.ts', specifier)).toThrow(DSH_ERROR)
    }
  })

  it('blocks the whole @deepseek-ai scope, not just the enumerated names (#138 收紧)', () => {
    for (const specifier of [
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-something-new',
      '@deepseek-ai/anything/subpath',
    ]) {
      expect(() => validateImport('apps/hub/src/app.ts', specifier)).toThrow(DSH_ERROR)
      expect(() => validateImport('apps/web/src/main.tsx', specifier)).toThrow(DSH_ERROR)
    }
    // 边界门只管 DSH scope：形近但不同 scope 的说明符不得误伤。
    expect(() => validateImport('apps/hub/src/app.ts', '@deepseek-ai-other/pkg')).not.toThrow()
    expect(() => validateImport('apps/hub/src/app.ts', '@whalepod/protocol')).not.toThrow()
  })

  it('allows the runtime adapter to import DSH', () => {
    expect(() =>
      validateImport('packages/runtime-dsh/src/bridge.ts', '@deepseek-ai/dsh-agent'),
    ).not.toThrow()
    expect(() => validateImport('apps/runtime/src/bin.ts', '@deepseek-ai/cordis')).not.toThrow()
    // scope 收紧后，runtime 侧同样放行未列举的伴随包。
    expect(() =>
      validateImport('packages/runtime-dsh/src/bridge.ts', '@deepseek-ai/schemastery'),
    ).not.toThrow()
  })
})

describe('workspace dependency rules', () => {
  it('allows hub -> domain/protocol/db', () => {
    for (const specifier of ['@whalepod/domain', '@whalepod/protocol', '@whalepod/db']) {
      expect(() => validateImport('apps/hub/src/app.ts', specifier)).not.toThrow()
    }
  })

  it('inherits the package grant for subpath exports from server-side importers (P1-17 digest)', () => {
    expect(() =>
      validateImport('apps/node/src/plugin/lockfile.ts', '@whalepod/protocol/plugin-pack-digest'),
    ).not.toThrow()
    expect(() =>
      validateImport(
        'apps/hub/src/modules/plugin/pack-resolver.ts',
        '@whalepod/protocol/plugin-pack-digest',
      ),
    ).not.toThrow()
    expect(() => validateImport('apps/web/src/main.ts', '@whalepod/db/anything')).toThrow(
      'not allowed from apps/web/',
    )
  })

  it('denies web -> protocol subpaths not on the isomorphic whitelist (P1-17 regression)', () => {
    expect(() =>
      validateImport('apps/web/src/main.ts', '@whalepod/protocol/plugin-pack-digest'),
    ).toThrow('not allowed from apps/web/')
    expect(() =>
      validateImport('apps/web/src/main.ts', '@whalepod/protocol/plugin-pack-digest'),
    ).toThrow('isomorphic subpaths of @whalepod/protocol: none')
  })

  it('blocks hub -> runtime-dsh', () => {
    expect(() => validateImport('apps/hub/src/app.ts', '@whalepod/runtime-dsh')).toThrow(
      'not allowed from apps/hub/',
    )
  })

  it('allows web -> protocol only', () => {
    expect(() => validateImport('apps/web/src/main.ts', '@whalepod/protocol')).not.toThrow()
    for (const specifier of ['@whalepod/domain', '@whalepod/db', '@whalepod/runtime-dsh']) {
      expect(() => validateImport('apps/web/src/main.ts', specifier)).toThrow(
        'not allowed from apps/web/',
      )
    }
  })

  it('allows node -> domain/protocol only', () => {
    expect(() =>
      validateImport('apps/node/src/gateway/client.ts', '@whalepod/domain'),
    ).not.toThrow()
    expect(() =>
      validateImport('apps/node/src/gateway/client.ts', '@whalepod/protocol'),
    ).not.toThrow()
    expect(() => validateImport('apps/node/src/gateway/client.ts', '@whalepod/db')).toThrow(
      'not allowed from apps/node/',
    )
  })

  it('allows runtime -> protocol/runtime-dsh only', () => {
    expect(() => validateImport('apps/runtime/src/bin.ts', '@whalepod/protocol')).not.toThrow()
    expect(() => validateImport('apps/runtime/src/bin.ts', '@whalepod/runtime-dsh')).not.toThrow()
    expect(() => validateImport('apps/runtime/src/bin.ts', '@whalepod/domain')).toThrow(
      'not allowed from apps/runtime/',
    )
  })

  it('allows db/runtime-dsh/testkit package edges', () => {
    expect(() => validateImport('packages/db/src/schema.ts', '@whalepod/domain')).not.toThrow()
    expect(() => validateImport('packages/db/src/schema.ts', '@whalepod/protocol')).not.toThrow()
    expect(() =>
      validateImport('packages/runtime-dsh/src/bridge.ts', '@whalepod/protocol'),
    ).not.toThrow()
    expect(() =>
      validateImport('packages/testkit/src/fakes.ts', '@whalepod/runtime-dsh'),
    ).not.toThrow()
  })

  it('blocks reverse imports from leaf packages', () => {
    expect(() => validateImport('packages/domain/src/task.ts', '@whalepod/protocol')).toThrow(
      'not allowed from packages/domain/',
    )
    expect(() => validateImport('packages/protocol/src/run.ts', '@whalepod/domain')).toThrow(
      'not allowed from packages/protocol/',
    )
    expect(() => validateImport('packages/protocol/src/run.ts', '@whalepod/db')).toThrow(
      'not allowed from packages/protocol/',
    )
  })

  it('blocks packages from importing apps', () => {
    expect(() => validateImport('packages/protocol/src/run.ts', '@whalepod/hub')).toThrow(
      'not allowed from packages/protocol/',
    )
  })

  it('ignores third-party and relative specifiers', () => {
    expect(() => validateImport('apps/hub/src/app.ts', 'fastify')).not.toThrow()
    expect(() => validateImport('apps/hub/src/app.ts', './config.js')).not.toThrow()
    expect(() => validateImport('scripts/check-boundaries.ts', '@whalepod/protocol')).not.toThrow()
  })
})

// P1-17 回归钉：子路径归一不得 blanket 放行 web（Q0 边界门）。
describe('isomorphic subpath whitelist: pinned edges (P1-17 regression)', () => {
  it('web -> @whalepod/protocol/plugin-pack-digest is DENY (node:crypto subpath)', () => {
    expect(() =>
      validateImport('apps/web/src/main.ts', '@whalepod/protocol/plugin-pack-digest'),
    ).toThrow(
      'Subpath import "@whalepod/protocol/plugin-pack-digest" is not allowed from apps/web/ ' +
        '(isomorphic subpaths of @whalepod/protocol: none)',
    )
  })

  it('node -> @whalepod/protocol/plugin-pack-digest is ALLOW (server-side package grant)', () => {
    expect(() =>
      validateImport('apps/node/src/plugin/lockfile.ts', '@whalepod/protocol/plugin-pack-digest'),
    ).not.toThrow()
  })

  it('web -> @whalepod/protocol bare package is ALLOW (isomorphic entry)', () => {
    expect(() => validateImport('apps/web/src/main.ts', '@whalepod/protocol')).not.toThrow()
  })
})

describe('tests/ 的 typecheck 接线护栏（#178 评审 O2）', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'whalepod-typecheck-wiring-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** 造一个最小 workspace 片段：`<scope>/<name>/{tests,package.json,tsconfig.test.json?}`。 */
  async function makePackage(
    scope: 'apps' | 'packages',
    name: string,
    manifest: Record<string, unknown>,
    withTestConfig = false,
    withTests = true,
  ): Promise<void> {
    const dir = join(root, scope, name)
    await mkdir(withTests ? join(dir, 'tests') : dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    if (withTestConfig) await writeFile(join(dir, 'tsconfig.test.json'), '{}')
  }

  it('有 tests/ 但没有 typecheck 脚本 → 违规（该包整体静默脱离 Q0）', async () => {
    await makePackage('packages', 'solo', { scripts: {} })
    expect(checkTypecheckWiring(root)).toEqual([
      'packages/solo: has tests/ but no typecheck script (its tests never reach Q0)',
    ])
  })

  it('typecheck 没跑 tsconfig.test.json → 违规（tests/ 仍在门外）', async () => {
    await makePackage('apps', 'portal', { scripts: { typecheck: 'tsc -b' } })
    expect(checkTypecheckWiring(root)).toEqual([
      'apps/portal: typecheck does not run tsconfig.test.json (tests/ excluded from Q0)',
    ])
  })

  it('脚本引用了 tsconfig.test.json 但文件不存在 → 违规', async () => {
    await makePackage('apps', 'portal', {
      scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' },
    })
    expect(checkTypecheckWiring(root)).toEqual([
      'apps/portal: typecheck references tsconfig.test.json but the file is missing',
    ])
  })

  it('豁免表只允许缩小：表内每个包在**当前仓库**里必须真的仍未接线', async () => {
    // 为什么需要这条（#178 评审 O-a）：豁免表是 `continue` 跳过，什么都不查，所以
    // 「某个包其实已经接线了、行却没删」会变成**永久静默豁免**。这里把承诺变成机检：
    // 谁把某个包接上 typecheck，这条就会红，逼他删掉表里那一行。
    const { TYPECHECK_WIRING_DEFERRED } = await import('./check-boundaries.js')
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../..')
    for (const where of TYPECHECK_WIRING_DEFERRED.keys()) {
      const manifestPath = join(repoRoot, where, 'package.json')
      expect(existsSync(manifestPath), `${where} 的 package.json 不见了`).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        scripts?: Record<string, string>
      }
      const typecheck = manifest.scripts?.['typecheck'] ?? ''
      expect(
        typecheck.includes('tsconfig.test.json'),
        `${where} 已经接线了——请把它从 TYPECHECK_WIRING_DEFERRED 里删掉（该表只允许缩小）`,
      ).toBe(false)
    }
  })

  it('接线正确 → 无违规；没有 tests/ 的包不受约束', async () => {
    await makePackage(
      'packages',
      'wired',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    await makePackage('packages', 'no-tests', { scripts: {} }, false, false)
    expect(checkTypecheckWiring(root)).toEqual([])
  })
})

describe('checkRunStatusChokePoint（P1-192：Run 唯一写入口）', () => {
  const repoRoot = resolve(fileURLToPath(import.meta.url), '../..')

  it('本仓库当前无违规（要写 running 只能走 applyRunStatus）', () => {
    expect(checkRunStatusChokePoint(repoRoot)).toEqual([])
  })

  it("抓到「字面量直调 setRunStatus(..., 'running', ...)」的写法，并指出该走收口", () => {
    const root = mkdtempSync(join(tmpdir(), 'choke-'))
    const dir = join(root, 'apps/hub/src/modules/run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'sneaky.ts'),
      "export const go = (tx: Tx) => setRunStatus(tx, 'id', 'running', {})\n",
    )
    const violations = checkRunStatusChokePoint(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('sneaky.ts:1')
    expect(violations[0]).toContain('applyRunStatus')
  })

  it('收口文件自己不受这条判据限制（它就是那个入口）', () => {
    const root = mkdtempSync(join(tmpdir(), 'choke-ok-'))
    const dir = join(root, 'apps/hub/src/modules/run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'run-status.ts'),
      "export const go = (tx: Tx) => setRunStatus(tx, 'id', 'running', {})\n",
    )
    expect(checkRunStatusChokePoint(root)).toEqual([])
  })

  it('变量形式的写不误报（那条由集成判据覆盖，见函数注释的覆盖面声明）', () => {
    const root = mkdtempSync(join(tmpdir(), 'choke-var-'))
    const dir = join(root, 'apps/hub/src/modules/run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'ok.ts'),
      "export const go = (tx: Tx, next: { status: S }) => setRunStatus(tx, 'id', next.status, {})\n",
    )
    expect(checkRunStatusChokePoint(root)).toEqual([])
  })
})
