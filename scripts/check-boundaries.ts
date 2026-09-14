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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

/**
 * importer path prefix -> allowed `@whalepod/*` specifiers.
 *
 * `subpaths`（可选）是该 importer 的「同构子路径白名单」：一旦声明，来自该
 * importer 的子路径 specifier 一律默认违规，只有白名单里显式列出的完整子路径
 * （按包名归组）才放行——防止 node-only 子路径导出（如 `plugin-pack-digest`
 * 引 node:crypto）被包级归一规则带进 web bundle。未声明 `subpaths` 的
 * 服务端 importer（hub/node 等）保留归一放行行为。
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
    subpaths: { '@whalepod/protocol': [] },
  },
  {
    // 验收链路测试（P1-13 run-projection-chain）：跨 app 验收需要直接读 DB 判定
    // 落库结果——与 apps/hub/tests/ 同型例外；src 侧仍禁 db（部署边界不变）。
    importer: 'apps/node/tests/',
    allowed: ['@whalepod/domain', '@whalepod/protocol', '@whalepod/db'],
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
  const hasSubpath = segments.length > 2

  const rule = DEPENDENCY_RULES.find(({ importer: prefix }) => importer.startsWith(prefix))
  if (!rule) return // importers outside apps//packages (e.g. scripts/) are not governed here

  if (!rule.allowed.includes(packageSpecifier)) {
    const allowed = rule.allowed.length > 0 ? rule.allowed.join(', ') : 'none'
    throw new Error(
      `Import "${specifier}" is not allowed from ${rule.importer} (allowed: ${allowed})`,
    )
  }

  if (hasSubpath && rule.subpaths !== undefined) {
    const whitelisted = rule.subpaths[packageSpecifier] ?? []
    if (!whitelisted.includes(specifier)) {
      const listed = whitelisted.length > 0 ? whitelisted.join(', ') : 'none'
      throw new Error(
        `Subpath import "${specifier}" is not allowed from ${rule.importer} ` +
          `(isomorphic subpaths of ${packageSpecifier}: ${listed})`,
      )
    }
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
 * 表 `TYPECHECK_WIRING_DEFERRED` 是**尚未接线**的包（每项必须带 Issue 与实测存量错误数），
 * 只允许**缩小**：收口一片就删一行。新增未接线的包进不来——这就是这条护栏的意义；
 * 「表内条目其实已经接线了却忘了删行」由 `check-boundaries.spec.ts` 的机器判据兜住。
 */
export const TYPECHECK_WIRING_DEFERRED = new Map<string, string>([
  ['apps/hub', '#183：30 个存量错误'],
  ['apps/node', '#183：29 个存量错误（另需先拆对 hub/tests/helpers.js 的跨包 import）'],
  ['packages/db', '#183：1 个存量错误'],
  ['packages/protocol', '#183：1 个存量错误'],
])

export function checkTypecheckWiring(repoRoot: string): string[] {
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
      if (!existsSync(join(dir, 'tsconfig.test.json'))) {
        violations.push(`${where}: typecheck references tsconfig.test.json but the file is missing`)
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
  ]
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) {
    console.error(`check-boundaries: ${violations.length} violation(s) found`)
    process.exitCode = 1
  } else {
    console.log('check-boundaries: no violations')
  }
}
