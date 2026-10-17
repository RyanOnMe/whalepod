/**
 * Workspace boundary checker (P1-01).
 *
 * Two rule families:
 * 1. DSH isolation — the whole `@deepseek-ai/` scope may only be imported from
 *    `packages/runtime-dsh/` and `apps/runtime/`. The rule is scope-wide on
 *    purpose (#138, ADR-0008 §3): enumerating known package names left room for
 *    an unlisted companion package (`@deepseek-ai/schemastery` and friends) to
 *    slip into business code unnoticed.
 * 2. Workspace dependency rules — `@whalepod/*` imports must follow the
 *    direction table in 02-第一阶段实施计划.md Task 1:
 *    web -> protocol; hub -> domain/protocol/db; node -> domain/protocol;
 *    runtime -> protocol/runtime-dsh. Reverse imports fail.
 *
 * `validateImport` is pure and dependency-free so its spec runs before
 * `pnpm install`. When executed directly (`pnpm check:boundaries`) the script
 * lazily loads the TypeScript compiler API, scans static and dynamic imports
 * under `apps/*\/src` and `packages/*\/src`, prints every violation as
 * `importer:line -> specifier`, and exits non-zero when any violation is found.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as TS from 'typescript'

/**
 * 整个 DSH scope：`@deepseek-ai/` 下任何包（dsh、cordis、以及未逐个列举的伴随包）
 * 都只准 runtime-dsh adapter 与 apps/runtime 引用。写成 scope 前缀而不是包名清单，
 * 是为了「上游新增包名」这件事不会被漏掉（#138 收紧）。
 */
const DSH_SCOPE_PREFIX = '@deepseek-ai/'
const DSH_OWNERS = ['packages/runtime-dsh/', 'apps/runtime/']
const DSH_ERROR = 'DSH imports are restricted to packages/runtime-dsh and apps/runtime'

const WORKSPACE_SCOPE = '@whalepod/'

/** 判据要覆盖的测试源文件扩展名（tsc 默认只吃 TS 家族）。 */
const TEST_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

/**
 * importer path prefix -> allowed `@whalepod/*` specifiers.
 *
 * `subpaths`（可选）是「该 importer 允许的完整 specifier 名单」（按包名归组）：
 * 一旦某包在名单里出现，来自该 importer 对它的**每一个**说明符都要逐一列出——
 * **含裸入口**（#183 评审 A：旧实现只在有子路径时查名单，于是「白名单里写
 * `@whalepod/hub/testing`」并不能挡住 `@whalepod/hub`）。用途两个：
 * ① 防 node-only 子路径导出（如 `plugin-pack-digest` 引 node:crypto）被带进 web
 * bundle；② 防测试从 hub 主入口拿东西（主入口无 `development` 条件 → vitest 下解析
 * 到 dist，与测试驱动用的 src 深模块形成两套实例）。未声明 `subpaths` 的 importer
 * （hub/node 的 src 等）保留包级归一放行行为。
 */
const DEPENDENCY_RULES: ReadonlyArray<{
  importer: string
  /** Bare package specifiers (`@whalepod/<name>`) allowed from this importer. */
  allowed: readonly string[]
  /** Isomorphic subpath whitelist; see the table doc comment above. */
  subpaths?: Readonly<Record<string, readonly string[]>>
}> = [
  {
    // testkit 是 apps/hub 的 devDependency，只准测试目录引用（Fake DeviceGateway/Fixtures）；
    // 排在 apps/hub/ 之前，靠前缀匹配让 src 侧 import testkit 直接判违规。
    importer: 'apps/hub/tests/',
    allowed: ['@whalepod/domain', '@whalepod/protocol', '@whalepod/db', '@whalepod/testkit'],
  },
  {
    importer: 'apps/hub/',
    allowed: ['@whalepod/domain', '@whalepod/protocol', '@whalepod/db'],
  },
  {
    // 浏览器 bundle：protocol 的已声明子路径导出目前全部 node-only
    // （plugin-pack-digest 引 node:crypto），白名单显式置空；确有同构子路径
    // 时在 subpaths 里显式添加完整 specifier。
    importer: 'apps/web/',
    allowed: ['@whalepod/protocol'],
    // 白名单列的是**允许的完整说明符**（含裸入口）：web 只许同构的裸 protocol，
    // node-only 子路径一律拒。
    subpaths: { '@whalepod/protocol': ['@whalepod/protocol'] },
  },
  {
    // 验收链路测试（P1-13 run-projection-chain）：跨 app 验收需要直接读 DB 判定
    // 落库结果——与 apps/hub/tests/ 同型例外；src 侧仍禁 db（部署边界不变）。
    // #183：node 的 integration spec 还要「起真 Hub 应用跑 HTTP inject」与共享 DB
    // 脚手架——按**包名**引入（`@whalepod/hub/testing` + `@whalepod/testkit`），
    // 不再 relative-import hub 的 tests/ 内部文件（那会把 hub 源码拖进 node 的
    // typecheck program 并让 hub 侧错误污染 node 的 Q0；见 #183）。
    importer: 'apps/node/tests/',
    allowed: [
      '@whalepod/domain',
      '@whalepod/protocol',
      '@whalepod/db',
      '@whalepod/testkit',
      '@whalepod/hub',
    ],
    // 子路径收窄（#183 评审 A）：hub 的**主入口**在 vitest 下解析到 dist（它没有
    // development 条件），而此处的测试还要 relative-import hub 的深模块 src
    // （cli-hello-refresh 的 `vi.spyOn(nodeConnections, 'attach')` 观测的就是那个实例）
    // ——一旦有人从主入口拿东西，同进程就会出现两套 hub 模块实例。只放行已声明用途的
    // 两个子路径；确需新增时在这里显式加一行。
    // （另注：跨 app 的**相对** import 不经过本表——validateImport 只管 @whalepod/ 前缀；
    // 那类耦合由 #99 的 harness 规则与人工评审管。）
    subpaths: {
      '@whalepod/protocol': ['@whalepod/protocol', '@whalepod/protocol/plugin-pack-digest'],
      // 裸 `@whalepod/hub` **不在**名单里：主入口没有 development 条件（vitest 下解析到
      // dist），从它拿东西会让同进程出现两套 hub 模块实例——只许 testing 子路径。
      '@whalepod/hub': ['@whalepod/hub/testing'],
      // testkit 只用裸入口（db-support 由根导出）；子路径不放开，防日后从内部文件拿东西。
      '@whalepod/testkit': ['@whalepod/testkit'],
    },
  },
  { importer: 'apps/node/', allowed: ['@whalepod/domain', '@whalepod/protocol'] },
  { importer: 'apps/runtime/', allowed: ['@whalepod/protocol', '@whalepod/runtime-dsh'] },
  { importer: 'packages/domain/', allowed: [] },
  { importer: 'packages/protocol/', allowed: [] },
  { importer: 'packages/db/', allowed: ['@whalepod/domain', '@whalepod/protocol'] },
  { importer: 'packages/runtime-dsh/', allowed: ['@whalepod/protocol'] },
  {
    importer: 'packages/testkit/',
    allowed: ['@whalepod/domain', '@whalepod/protocol', '@whalepod/db', '@whalepod/runtime-dsh'],
  },
]

/** Throws when the edge importer -> specifier violates a boundary rule. */
export function validateImport(importer: string, specifier: string): void {
  if (specifier.startsWith(DSH_SCOPE_PREFIX)) {
    if (!DSH_OWNERS.some((prefix) => importer.startsWith(prefix))) {
      throw new Error(DSH_ERROR)
    }
    return
  }

  if (!specifier.startsWith(WORKSPACE_SCOPE)) return

  // 子路径导出（如 @whalepod/protocol/plugin-pack-digest）归一到包名再判定——
  // 方向表管的是包级依赖，服务端 importer 的已声明子路径导出继承包的许可。
  // 声明了同构子路径白名单的 importer（apps/web）则子路径默认违规，
  // 只有白名单显式列出的子路径放行，防止 node-only 导出进 web bundle。
  const segments = specifier.split('/')
  const packageSpecifier = `${segments[0]}/${segments[1]}`

  const rule = DEPENDENCY_RULES.find(({ importer: prefix }) => importer.startsWith(prefix))
  if (!rule) return // importers outside apps//packages (e.g. scripts/) are not governed here

  if (!rule.allowed.includes(packageSpecifier)) {
    const allowed = rule.allowed.length > 0 ? rule.allowed.join(', ') : 'none'
    throw new Error(
      `Import "${specifier}" is not allowed from ${rule.importer} (allowed: ${allowed})`,
    )
  }

  // 白名单语义（#183 评审 A）：一旦某包进了 `subpaths`，允许的**每一个**说明符都要逐一
  // 列出——含裸入口。旧实现只在 `hasSubpath` 时查白名单，于是「白名单里写
  // @whalepod/hub/testing」并不能挡住 `@whalepod/hub`（裸 specifier 直接跳过检查）。
  const whitelist = rule.subpaths?.[packageSpecifier]
  if (whitelist !== undefined && !whitelist.includes(specifier)) {
    const listed = whitelist.length > 0 ? whitelist.join(', ') : 'none'
    throw new Error(
      `Import "${specifier}" is not allowed from ${rule.importer} ` +
        `(declared specifiers for ${packageSpecifier} — bare entry included: ${listed})`,
    )
  }
}

export interface ImportEdge {
  specifier: string
  line: number
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const SCAN_ROOTS = ['apps', 'packages']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

/** Collects static, dynamic and import-type module specifiers from one source file. */
export async function collectImportEdges(filePath: string): Promise<ImportEdge[]> {
  const ts: typeof TS = await import('typescript')
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
  const edges: ImportEdge[] = []

  const push = (specifier: string, node: TS.Node): void => {
    const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile))
    edges.push({ specifier, line: line + 1 })
  }

  const visit = (node: TS.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier))
        push(node.moduleSpecifier.text, node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments
      if (arg && ts.isStringLiteral(arg)) push(arg.text, arg)
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        push(argument.literal.text, argument.literal)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return edges
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkSourceFiles(fullPath)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      yield fullPath
    }
  }
}

/**
 * 「有 tests/ 就必须有覆盖它的 typecheck 脚本」（#178 评审 O2）。
 *
 * 为什么需要这条：根 `typecheck` 是 `tsc -p tsconfig.json --noEmit && pnpm -r --if-present
 * typecheck`——`--if-present` 在**缺脚本时静默 exit 0**（实测），而根 `tsc -b` 只构建根项目
 * （无 references），所以每个包的 `src/` 与 `tests/` 能否进 Q0 **完全依赖它自己那条脚本**。
 * 于是「新包漏配 typecheck」= 该包整体静默脱离类型门，没有任何门会红。这条把它变成硬失败：
 * 凡是有 `tests/` 的 workspace 包，`scripts.typecheck` 必须存在且引用 `tsconfig.test.json`。
 *
 * 判据分两层，第二层才是难绕过的那层：脚本文本必须引用 tsconfig.test.json（第一层，纯文本、
 * 好绕过），且 `tsc -p tsconfig.test.json --listFilesOnly` 的**实际文件清单**要含 tests/ 下的
 * **每一个** TS 文件（第二层，ground truth）。第二层是评审 B 第二轮逼出来的：只要求「清单里
 * 有任一 /tests/ 路径」时，include 写成 `tests/*.spec.ts` 这种**单层 glob**（只覆盖 tests/
 * 顶层）就会让 apps/node 的 tests 深层目录里共 9 个 spec 静默脱离 Q0 而门全绿。
 * tsc 列不出清单（非零退出）按**失败**处理——配置坏了就不许判「已接线」。
 *
 * 表 `TYPECHECK_WIRING_DEFERRED` 是**尚未接线**的包（每项必须带 Issue 与实测存量错误数），
 * 只允许**缩小**：收口一片就删一行。新增未接线的包进不来——这就是这条护栏的意义；
 * 「表内条目其实已经接线了却忘了删行」由 `check-boundaries.spec.ts` 的机器判据兜住。
 */
export const TYPECHECK_WIRING_DEFERRED = new Map<string, string>([
  // 存量错误数的**真值**在 scripts/lib/typecheck-test-baseline.ts（机检、只许向下）；
  // 本表的职责只是「声明该包尚未接线」。两处键必须一一对应（有测试盯着）。
])

export interface TypecheckWiringOptions {
  /**
   * 抽查 program 文件清单用的 tsc（默认 `repoRoot/node_modules/.bin/tsc`）。判据的
   * ground truth 是 `tsc -p tsconfig.test.json --listFilesOnly` 的**实际文件清单**：
   * 上一版只看 include 文本，被两条同族旁路绕过——删掉 include 键（extends 继承的
   * include 生效，「不写 include 就默认全覆盖」在本仓库不成立）与 `exclude: ["tests/**"]`。
   * 实测成本：9 个包合计约 3s（各 0.2–0.5s）。
   */
  readonly tscBin?: string
}

/** 该包 tests/ 下的全部 TS 源文件（判据要求它们**每一个**都进 program）。 */
function testSourceFiles(testsDir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    const path = join(testsDir, entry.name)
    if (entry.isDirectory()) files.push(...testSourceFiles(path))
    else if (TEST_SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

/**
 * 不在 typecheck program 里的测试文件（相对包根；空数组 = 全覆盖）。
 *
 * 判据要的是「**每一个** tests/ 文件都进 program」，不是「至少有一个」——后者会被
 * 「单层 glob 手滑」放过去（评审 B 的实测：`include: [..., "tests/*.spec.ts"]` 让
 * apps/node 的 `tests/integration/**` 与 `tests/resilience/**` 共 9 个 spec 静默脱离 Q0，
 * 门全绿）。清单已经在手里，逐个对比的代价为 0。
 * tsc 起不来（缺依赖、配置语法错）返回 null，调用方按 fail-closed 处理。
 */
function uncoveredTestFiles(packageDir: string, tscBin: string): string[] | null {
  let output: string
  try {
    output = execFileSync(tscBin, ['-p', 'tsconfig.test.json', '--listFilesOnly'], {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
  // 两侧都过 realpath：macOS 的 os.tmpdir() 是 /var/folders/…，而 tsc 打的是
  // /private/var/folders/…（同一目录的两种写法）——不归一就会把「在 program 里」
  // 误判成缺失（fixture 实测踩到）。
  const realPackageDir = realpathSync(packageDir)
  const inProgram = new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.includes(' '))
      .map((line) => safeRealpath(resolve(line))),
  )
  return testSourceFiles(join(realPackageDir, 'tests'))
    .filter((file) => !inProgram.has(safeRealpath(resolve(file))))
    .map((file) => relative(realPackageDir, file))
}

/** realpath，失败时退回原路径（tsc 清单里可能有已消失的路径）。 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function checkTypecheckWiring(
  repoRoot: string,
  options: TypecheckWiringOptions = {},
): string[] {
  const violations: string[] = []
  for (const scope of ['apps', 'packages']) {
    const scopeDir = join(repoRoot, scope)
    if (!existsSync(scopeDir)) continue
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(scopeDir, entry.name)
      if (!existsSync(join(dir, 'tests'))) continue
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        scripts?: Record<string, string>
      }
      const typecheck = manifest.scripts?.['typecheck']
      const where = `${scope}/${entry.name}`
      if (TYPECHECK_WIRING_DEFERRED.has(where)) continue
      if (typecheck === undefined) {
        violations.push(`${where}: has tests/ but no typecheck script (its tests never reach Q0)`)
        continue
      }
      if (!typecheck.includes('tsconfig.test.json')) {
        violations.push(
          `${where}: typecheck does not run tsconfig.test.json (tests/ excluded from Q0)`,
        )
        continue
      }
      const testConfigPath = join(dir, 'tsconfig.test.json')
      if (!existsSync(testConfigPath)) {
        violations.push(`${where}: typecheck references tsconfig.test.json but the file is missing`)
        continue
      }
      const tscBin = options.tscBin ?? join(repoRoot, 'node_modules', '.bin', 'tsc')
      const uncovered = uncoveredTestFiles(dir, tscBin)
      if (uncovered === null) {
        violations.push(
          `${where}: 无法列出 typecheck program（tsc -p tsconfig.test.json 退出非零；` +
            `配置语法或依赖坏了）——测试是否进 Q0 无从判定`,
        )
      } else if (uncovered.length > 0) {
        const shown = uncovered.slice(0, 5).join('、')
        violations.push(
          `${where}: ${uncovered.length} 个 tests/ 下的文件不在 typecheck program 里（静默脱离 Q0）：` +
            `${shown}${uncovered.length > 5 ? '、…' : ''}`,
        )
      }
    }
  }
  return violations
}

/**
 * 唯一写入口判据（P1-192 评审 B1/①）：Hub 里把 Run 写成 `running` 必须经
 * `apps/hub/src/modules/run/run-status.ts` 的 `applyRunStatus`——它顺带放行排队中的指令。
 *
 * 为什么需要机器判据：ADR-0009 决策 5 的补发原先「在每个入口各挂一次」，而 Hub 里能写
 * `running` 的入口有 5 条，作者（我）漏了 3 条、其中包含真人主路径 `decide.ts`，评审用探针
 * 才挖出来。人肉枚举会漏，所以这里钉住**字面量直调**这种最常见的漏法。
 *
 * 覆盖面（诚实标注）：只扫 `setRunStatus(...)` 实参里出现**字面量** `'running'` 的调用；
 * 变量形式（如 `next.status`）由 `instruction-queue.integration.spec.ts` 的 5 条路径判据覆盖
 *（含真人路径、reconciler 探活、审批过期清扫）。
 */
export const RUN_STATUS_CHOKE_POINT = 'apps/hub/src/modules/run/run-status.ts'

export function checkRunStatusChokePoint(repoRoot: string): string[] {
  const violations: string[] = []
  const hubRoot = join(repoRoot, 'apps/hub/src')
  if (!existsSync(hubRoot)) return violations
  for (const filePath of walkSourceFiles(hubRoot)) {
    const relativePath = relative(repoRoot, filePath).split(sep).join('/')
    if (relativePath === RUN_STATUS_CHOKE_POINT) continue
    const source = readFileSync(filePath, 'utf8')
    source.split('\n').forEach((line, index) => {
      // 只认调用形态，且要求同一行里同时出现 `setRunStatus(` 与字面量 'running'。
      if (!line.includes('setRunStatus(')) return
      if (!/['"]running['"]/.test(line)) return
      violations.push(
        `${relativePath}:${index + 1}: writes run status 'running' directly; ` +
          `use applyRunStatus (${RUN_STATUS_CHOKE_POINT}) so queued instructions are released`,
      )
    })
  }
  return violations
}

/**
 * Harness assembly hygiene (#99): production entries and test/harness entries
 * must walk the same assembly. Two machine checks, both scoped to `scripts/`
 * (harness assembly runtime; `tests/` setup fixtures are declarative
 * preconditions, out of scope):
 *
 * 1. checkHarnessDbSeeds: no direct business-table writes. A line matching
 *    `.insert(schema.<Table>)` in scripts/ is a violation unless the
 *    (file, table) pair is registered in HARNESS_SEED_ALLOWLIST with
 *    reason + removeWhen. (Docstring prose must not spell the full call
 *    shape, or this file flags itself.)
 * 2. checkHarnessEntryAssembly: no source paths standing in for package
 *    resolution. A string literal containing `apps/<app>/src/` in scripts/ is
 *    a violation (spawn entries and argv markers must match the production
 *    artifact), except inside a `createRequire(...)` anchor: borrowing a
 *    package's dependency view to resolve the dist artifact is the fix, not
 *    the violation. Import statements (`from '../../../apps/...'`) are
 *    compile-time reuse and out of scope; only string literals are scanned.
 */
export interface HarnessSeedException {
  /** 理由（一句话）：为什么走不通真人路径。 */
  reason: string
  /** 删除条件：什么落地后这条种子必须删除。 */
  removeWhen: string
}

export const HARNESS_SEED_ALLOWLIST: Record<string, HarnessSeedException> = {
  'scripts/lib/phase1/chain.ts:schema.pluginPacks': {
    reason:
      'Pack 管理流要求 catalog 安装校验；chain 用假 digest（aa..aa）种子，走真人 POST /plugin-packs 会被 fail-closed 拒绝',
    removeWhen: 'Pack 管理流支持测试 fixture 安装（或 chain 改走真 digest 种子）后删除',
  },
  'scripts/e2e-serve.mts:schema.pluginPacks': {
    reason:
      '/control/plugin-pack/seed 是 E2E 控制面种子（真 digest 实算），Pack 管理流不在 E2E 复跑',
    removeWhen: 'E2E 改走真人 Pack 管理流后删除该控制面路由与种子',
  },
}

/** 源码位置常量（非执行入口）：文件身份引用，不 spawn。 */
export const HARNESS_SRC_PATH_ALLOWLIST: readonly string[] = [
  // check-boundaries 自身的判据常量与测试字符串。
  'scripts/check-boundaries.ts',
  'scripts/check-boundaries.spec.ts',
  // 陈旧残留清理：切装配前的历史进程仍需覆盖一轮（e2e-serve.mts 内已注记）。
  'scripts/e2e-serve.mts:apps/runtime/src/bin.ts',
  // #281 起 e2e-serve 的 Hub 装配唯一走包解析 dist 产物，源码路径例外已摘除。
]

export function checkHarnessDbSeeds(repoRoot: string): string[] {
  const violations: string[] = []
  const scriptsDir = join(repoRoot, 'scripts')
  if (!existsSync(scriptsDir)) return violations
  for (const filePath of walkSourceFiles(scriptsDir)) {
    const relativePath = relative(repoRoot, filePath).split(sep).join('/')
    // spec 是断言（含本规则的红测试固件字符串），不是装配运行时。
    if (relativePath.endsWith('.spec.ts')) continue
    const source = readFileSync(filePath, 'utf8')
    source.split('\n').forEach((line, index) => {
      const match = /\.insert\(schema\.([A-Za-z0-9_]+)\)/.exec(line)
      if (!match) return
      const key = `${relativePath}:schema.${match[1]}`
      if (HARNESS_SEED_ALLOWLIST[key] !== undefined) return
      violations.push(
        `${relativePath}:${index + 1}: harness writes business table directly (.insert(schema.${match[1]})); ` +
          `route via the human path or register in HARNESS_SEED_ALLOWLIST with reason + removeWhen (#99)`,
      )
    })
  }
  return violations
}

export function checkHarnessEntryAssembly(repoRoot: string): string[] {
  const violations: string[] = []
  const scriptsDir = join(repoRoot, 'scripts')
  if (!existsSync(scriptsDir)) return violations
  for (const filePath of walkSourceFiles(scriptsDir)) {
    const relativePath = relative(repoRoot, filePath).split(sep).join('/')
    if (relativePath === 'scripts/check-boundaries.ts') continue
    // spec 是断言（含本规则的红测试固件字符串），不是装配运行时。
    if (relativePath.endsWith('.spec.ts')) continue
    const source = readFileSync(filePath, 'utf8')
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      // createRequire 锚点除外：借某包的依赖视角解析 dist 产物正是修复手法，不是违规。
      // 锚点可能跨行（createRequire( 换行 join(...)），故看本行与上一行。
      if (line.includes('createRequire(') || (lines[index - 1] ?? '').includes('createRequire('))
        return
      const match = /['"]apps\/[a-z-]+\/src\/[^'"]*['"]/.exec(line)
      if (!match) return
      const key = `${relativePath}:${match[0].slice(1, -1)}`
      if (HARNESS_SRC_PATH_ALLOWLIST.some((allowed) => relativePath === allowed || key === allowed))
        return
      violations.push(
        `${relativePath}:${index + 1}: harness references source path ${match[0]}; ` +
          `resolve the production artifact (dist) via package exports instead (#99-A)`,
      )
    })
  }
  return violations
}

/** Scans the repo and returns one human-readable line per violation. */
export async function checkBoundaries(repoRoot: string): Promise<string[]> {
  const violations: string[] = []
  for (const scope of SCAN_ROOTS) {
    const scopeDir = join(repoRoot, scope)
    if (!existsSync(scopeDir)) continue
    for (const filePath of walkSourceFiles(scopeDir)) {
      const importer = relative(repoRoot, filePath).split(sep).join('/')
      for (const edge of await collectImportEdges(filePath)) {
        try {
          validateImport(importer, edge.specifier)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          violations.push(`${importer}:${edge.line} -> ${edge.specifier}: ${message}`)
        }
      }
    }
  }
  return violations
}

const invokedAsScript =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsScript) {
  const repoRoot = resolve(fileURLToPath(import.meta.url), '../..')
  const violations = [
    ...(await checkBoundaries(repoRoot)),
    ...checkTypecheckWiring(repoRoot),
    ...checkRunStatusChokePoint(repoRoot),
    ...checkHarnessDbSeeds(repoRoot),
    ...checkHarnessEntryAssembly(repoRoot),
  ]
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) {
    console.error(`check-boundaries: ${violations.length} violation(s) found`)
    process.exitCode = 1
  } else {
    console.log('check-boundaries: no violations')
  }
}
