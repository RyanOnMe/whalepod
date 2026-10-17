import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
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

/**
 * 接线判据的 ground truth 走仓库自己的 tsc（fixture 目录里没有 node_modules）——
 * 判据是 `tsc -p tsconfig.test.json --listFilesOnly` 的实际清单，不是文本解析。
 */
const REPO_TSC = join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules', '.bin', 'tsc')

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
    ).toThrow(
      'declared specifiers for @whalepod/protocol — bare entry included: @whalepod/protocol',
    )
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
      'Import "@whalepod/protocol/plugin-pack-digest" is not allowed from apps/web/ ' +
        '(declared specifiers for @whalepod/protocol — bare entry included: @whalepod/protocol)',
    )
  })

  // #183：声明过 subpaths 的包，裸入口也要逐一列出才放行——否则「白名单挡住主入口」是空话。
  it('#183：apps/node/tests 的 hub 白名单只放行 testing 子路径，裸主入口被拒', () => {
    expect(() =>
      validateImport('apps/node/tests/integration/x.integration.spec.ts', '@whalepod/hub/testing'),
    ).not.toThrow()
    expect(() =>
      validateImport('apps/node/tests/integration/x.integration.spec.ts', '@whalepod/hub'),
    ).toThrow(
      'Import "@whalepod/hub" is not allowed from apps/node/tests/ ' +
        '(declared specifiers for @whalepod/hub — bare entry included: @whalepod/hub/testing)',
    )
    expect(() =>
      validateImport(
        'apps/node/tests/integration/x.integration.spec.ts',
        '@whalepod/hub/src/app.ts',
      ),
    ).toThrow(/not allowed from apps\/node\/tests\//)
    expect(() =>
      validateImport(
        'apps/node/tests/integration/x.integration.spec.ts',
        '@whalepod/testkit/db-support',
      ),
    ).toThrow(/not allowed from apps\/node\/tests\//)
    // 同一条规则的正面：protocol 的裸入口与 digest 子路径都显式在名单里。
    expect(() =>
      validateImport('apps/node/tests/integration/x.integration.spec.ts', '@whalepod/protocol'),
    ).not.toThrow()
    expect(() =>
      validateImport(
        'apps/node/tests/integration/x.integration.spec.ts',
        '@whalepod/protocol/plugin-pack-digest',
      ),
    ).not.toThrow()
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
    testConfigJson?: string,
  ): Promise<void> {
    const dir = join(root, scope, name)
    await mkdir(withTests ? join(dir, 'tests') : dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    // 真实包总有 src/：给 fixture 也放一个，否则收窄 include 的变异会因 TS18003
    // 「no inputs」让 tsc 非零退出，落到 fail-closed 分支而不是精确的缺失清单。
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'sample.ts'), 'export const impl = 1\n')
    if (!withTestConfig) return
    // #183：配置与目录都写成仓库真实形态——判据的 ground truth 是 program 的实际文件
    // 清单，空 tests/ 与空配置都会被判「未覆盖」（那是**特性**：接线要真的把测试编进去）。
    await writeFile(
      join(dir, 'tsconfig.test.json'),
      testConfigJson ??
        JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts', 'tests/**/*.ts'] }),
    )
    if (withTests) {
      await writeFile(join(dir, 'tests', 'sample.spec.ts'), 'export const sample = 1\n')
      // 嵌套一层：单层 glob（tests/*.spec.ts）会漏掉它——判据要求**每一个**测试文件都进 program。
      await mkdir(join(dir, 'tests', 'integration'), { recursive: true })
      await writeFile(join(dir, 'tests', 'integration', 'deep.spec.ts'), 'export const deep = 1\n')
    }
  }

  it('有 tests/ 但没有 typecheck 脚本 → 违规（该包整体静默脱离 Q0）', async () => {
    await makePackage('packages', 'solo', { scripts: {} })
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'packages/solo: has tests/ but no typecheck script (its tests never reach Q0)',
    ])
  })

  it('typecheck 没跑 tsconfig.test.json → 违规（tests/ 仍在门外）', async () => {
    await makePackage('apps', 'portal', { scripts: { typecheck: 'tsc -b' } })
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/portal: typecheck does not run tsconfig.test.json (tests/ excluded from Q0)',
    ])
  })

  it('脚本引用了 tsconfig.test.json 但文件不存在 → 违规', async () => {
    await makePackage('apps', 'portal', {
      scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' },
    })
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/portal: typecheck references tsconfig.test.json but the file is missing',
    ])
  })

  it('include 被收窄到 src（摘掉 tests/）→ 违规：program 里没有 tests/ 文件', async () => {
    await makePackage(
      'apps',
      'narrowed',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    await writeFile(
      join(root, 'apps', 'narrowed', 'tsconfig.test.json'),
      '{\n  // 注释与收窄都要能处理\n  "include": ["src/**/*.ts"]\n}\n',
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/narrowed: 2 个 tests/ 下的文件不在 typecheck program 里（静默脱离 Q0）：' +
        // 顺序 = 目录遍历序（readdirSync 排序：integration/ 在 sample.spec.ts 之前）
        'tests/integration/deep.spec.ts、tests/sample.spec.ts',
    ])
  })

  it('删掉 include 键（extends 继承的 include 生效）→ 违规：不是「默认全覆盖」', async () => {
    // 本仓库的 tsconfig.test.json 都 extends ./tsconfig.json（include 只有 src/**）——
    // 「不写 include 就默认覆盖目录下全部 TS」在这里不成立，是很自然的「去冗余」编辑。
    await makePackage(
      'apps',
      'inherits',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    // 复刻仓库形态：base 的 include 只有 src/**，tsconfig.test.json 靠 extends 继承它，
    // 自己不写 include —— 「不写就默认全覆盖」在这里不成立。
    await writeFile(
      join(root, 'apps', 'inherits', 'tsconfig.json'),
      JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }),
    )
    await writeFile(
      join(root, 'apps', 'inherits', 'tsconfig.test.json'),
      JSON.stringify({ extends: './tsconfig.json', compilerOptions: {} }),
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/inherits: 2 个 tests/ 下的文件不在 typecheck program 里（静默脱离 Q0）：' +
        // 顺序 = 目录遍历序（readdirSync 排序：integration/ 在 sample.spec.ts 之前）
        'tests/integration/deep.spec.ts、tests/sample.spec.ts',
    ])
  })

  it('单层 glob 手滑（tests/*.spec.ts）→ 嵌套目录静默脱离 Q0，必红', async () => {
    await makePackage(
      'apps',
      'shallow',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    await writeFile(
      join(root, 'apps', 'shallow', 'tsconfig.test.json'),
      JSON.stringify({
        compilerOptions: {},
        include: ['src/**/*.ts', 'tests/*.spec.ts'],
      }),
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/shallow: 1 个 tests/ 下的文件不在 typecheck program 里（静默脱离 Q0）：' +
        'tests/integration/deep.spec.ts',
    ])
  })

  it('include 保留 tests/ 但 exclude 把它排掉 → 违规（文本只看一面的旁路）', async () => {
    await makePackage(
      'apps',
      'excluded',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    await writeFile(
      join(root, 'apps', 'excluded', 'tsconfig.test.json'),
      JSON.stringify({
        compilerOptions: {},
        include: ['src/**/*.ts', 'tests/**/*.ts'],
        exclude: ['tests/**'],
      }),
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/excluded: 2 个 tests/ 下的文件不在 typecheck program 里（静默脱离 Q0）：' +
        // 顺序 = 目录遍历序（readdirSync 排序：integration/ 在 sample.spec.ts 之前）
        'tests/integration/deep.spec.ts、tests/sample.spec.ts',
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

  it('路径含空格也判绿（评审 B 的假红：清单行按「含空格就丢」过滤会误报缺失）', async () => {
    await makePackage(
      'apps',
      'with space',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([])
  })

  it('脚本只出现配置名、从不真跑 tsc → 违规（子串匹配会被 echo 骗过，评审 A/B 实测）', async () => {
    await makePackage(
      'packages',
      'echoed',
      { scripts: { typecheck: 'echo tsconfig.test.json' } },
      true,
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'packages/echoed: typecheck 里没有「tsc -p tsconfig.test.json」形态的调用（只出现配置名不算数）；' +
        '脚本：echo tsconfig.test.json',
    ])
  })

  it('配置坏到 tsc 起不来 → fail-closed 违规（不是静默放行）', async () => {
    await makePackage(
      'apps',
      'broken',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
      true,
      JSON.stringify({ compilerOptions: {}, include: [] }),
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/broken: 无法列出 typecheck program（tsc -p tsconfig.test.json 退出非零；配置语法或依赖坏了）' +
        '——测试是否进 Q0 无从判定',
    ])
  })

  it('生效配置 noCheck=true → 违规（文件在 program 里却一个类型都不检查）', async () => {
    await makePackage(
      'packages',
      'unchecked',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
      true,
      JSON.stringify({
        compilerOptions: { noCheck: true },
        include: ['src/**/*.ts', 'tests/**/*.ts'],
      }),
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'packages/unchecked: tsconfig.test.json 的生效配置里 noCheck=true——文件在 program 里' +
        '但一个类型都不检查（清单判据照样命中）',
    ])
  })

  it('tests/ 下的目录 symlink 也枚举（vitest 会跑里面的 spec，判据不许沉默）', async () => {
    const dir = join(root, 'apps', 'linked')
    const outside = join(root, 'outside-cases')
    await mkdir(join(dir, 'tests'), { recursive: true })
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'linked.spec.ts'), 'export const linked = 1\n')
    await symlink(outside, join(dir, 'tests', 'cases'), 'dir')
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } }),
    )
    await writeFile(join(dir, 'src', 'sample.ts'), 'export const impl = 1\n')
    await writeFile(join(dir, 'tests', 'sample.spec.ts'), 'export const sample = 1\n')
    // 单层 glob：包自己的 spec 覆盖，symlink 进来的 cases/ 不覆盖 → 必须报出来
    await writeFile(
      join(dir, 'tsconfig.test.json'),
      JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts', 'tests/*.spec.ts'] }),
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/linked: 1 个 tests/ 下的文件不在 typecheck program 里（静默脱离 Q0）：' +
        'tests/cases/linked.spec.ts',
    ])
  })

  it('脚本指向同前缀的假配置（.orig / ~ 备份名）→ 违规（尾界是白名单不是词边界）', async () => {
    const cases = [
      ['prefixed', 'tsconfig.test.json.orig'],
      ['vimbackup', 'tsconfig.test.json~'],
    ] as const
    for (const [name, config] of cases) {
      await makePackage(
        'packages',
        name,
        { scripts: { typecheck: `tsc -b && tsc -p ${config}` } },
        true,
      )
    }
    // 判据每次扫全 root：两个 fixture 都建好后再断言（顺序 = readdirSync 的字典序）
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual(
      cases.map(
        ([name, config]) =>
          `packages/${name}: typecheck 里没有「tsc -p tsconfig.test.json」形态的调用` +
          `（只出现配置名不算数）；脚本：tsc -b && tsc -p ${config}`,
      ),
    )
  })

  it('串联写法不误伤（`;` / 无空格 `&&` / 重定向）——吞退出码是已声明盲区，不由文本层拦', async () => {
    const scripts = [
      'tsc -p tsconfig.test.json; echo done',
      'tsc -p tsconfig.test.json&&tsc -b',
      'set -e; tsc -p tsconfig.test.json --pretty false 2>&1',
    ]
    for (const [index, script] of scripts.entries()) {
      await makePackage('packages', `chained-${index}`, { scripts: { typecheck: script } }, true)
    }
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([])
  })

  it('路径带引号的合法写法不误伤（-p "tsconfig.test.json"）', async () => {
    await makePackage(
      'packages',
      'quoted',
      { scripts: { typecheck: 'tsc -b && tsc -p "tsconfig.test.json"' } },
      true,
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([])
  })

  it('脚本带 --noCheck → 违规（配置面探测看不到 CLI 旗标）', async () => {
    await makePackage(
      'packages',
      'nocheck-flag',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json --noCheck' } },
      true,
    )
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'packages/nocheck-flag: typecheck 带 --noCheck——编译器被显式要求不检查（配置面探测看不到 CLI 旗标）',
    ])
  })

  it('tests/ 嵌套超过 8 层 → 违规（枚举被截断不许静默）', async () => {
    const dir = join(root, 'apps', 'deep')
    await mkdir(join(dir, 'src'), { recursive: true })
    // 脚本必须已经接线，否则先报「没有 typecheck」（那条先 continue），到不了嵌套面
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } }),
    )
    await writeFile(join(dir, 'src', 'sample.ts'), 'export const impl = 1\n')
    await writeFile(
      join(dir, 'tsconfig.test.json'),
      JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }),
    )
    let nested = join(dir, 'tests')
    const segments: string[] = []
    for (let level = 0; level < 10; level += 1) {
      segments.push(`l${level}`)
      nested = join(nested, segments[segments.length - 1] ?? '')
    }
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'oh.spec.ts'), 'export const oh = 1\n')
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([
      'apps/deep: tests/ 目录嵌套超过 8 层——枚举被截断，「每个测试文件都在 program 里」无从判定' +
        '（评审 A/B 的 P3）',
    ])
  })

  it('接线正确 → 无违规；没有 tests/ 的包不受约束', async () => {
    await makePackage(
      'packages',
      'wired',
      { scripts: { typecheck: 'tsc -b && tsc -p tsconfig.test.json' } },
      true,
    )
    await makePackage('packages', 'no-tests', { scripts: {} }, false, false)
    expect(checkTypecheckWiring(root, { tscBin: REPO_TSC })).toEqual([])
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

describe('harness assembly hygiene (#99)', () => {
  it('未登记的直插即违规，并指出去向（白名单或真人路径）', async () => {
    const { checkHarnessDbSeeds } = await import('./check-boundaries.js')
    const root = mkdtempSync(join(tmpdir(), 'seed-'))
    const dir = join(root, 'scripts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'sneaky.mts'),
      'await database.db.insert(schema.workspaces).values({})\n',
    )
    const violations = checkHarnessDbSeeds(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('sneaky.mts:1')
    expect(violations[0]).toContain('HARNESS_SEED_ALLOWLIST')
  })

  it('白名单只允许缩小：每项在当前仓库必须仍真实存在（删了种子不删登记即红）', async () => {
    const { HARNESS_SEED_ALLOWLIST } = await import('./check-boundaries.js')
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../..')
    for (const key of Object.keys(HARNESS_SEED_ALLOWLIST)) {
      const sep = key.lastIndexOf(':schema.')
      const file = key.slice(0, sep)
      const table = key.slice(sep + ':schema.'.length)
      const source = readFileSync(join(repoRoot, file), 'utf8')
      expect(
        source.includes(`.insert(schema.${table})`),
        `${key} 的种子已删——请把白名单这行也删掉（该表只允许缩小）`,
      ).toBe(true)
    }
  })

  it('spawn 入口写源码路径即违规；createRequire 锚点不误报', async () => {
    const { checkHarnessEntryAssembly } = await import('./check-boundaries.js')
    const root = mkdtempSync(join(tmpdir(), 'entry-'))
    const dir = join(root, 'scripts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'sneaky.mts'),
      "const BIN = join(REPO_ROOT, 'apps/runtime/src/bin.ts')\n",
    )
    writeFileSync(
      join(dir, 'ok.mts'),
      "const BIN = createRequire(join(REPO_ROOT, 'apps/node/src/cli.ts')).resolve('@whalepod/runtime/bin')\n",
    )
    const violations = checkHarnessEntryAssembly(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('sneaky.mts:1')
    expect(violations[0]).toContain('apps/runtime/src/bin.ts')
  })

  it('本仓库当前无违规（两处 pack 种子与 Hub/残留标记均已登记）', async () => {
    const { checkHarnessDbSeeds, checkHarnessEntryAssembly } = await import('./check-boundaries.js')
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../..')
    expect(checkHarnessDbSeeds(repoRoot)).toEqual([])
    expect(checkHarnessEntryAssembly(repoRoot)).toEqual([])
  })
})
