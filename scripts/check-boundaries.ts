/**
 * Workspace boundary checker (P1-01).
 *
 * Two rule families:
 * 1. DSH isolation — `@deepseek-ai/dsh*` and `@deepseek-ai/cordis` may only be
 *    imported from `packages/runtime-dsh/` and `apps/runtime/`.
 * 2. Workspace dependency rules — `@project311/*` imports must follow the
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

const DSH_PREFIXES = ['@deepseek-ai/dsh-', '@deepseek-ai/dsh', '@deepseek-ai/cordis']
const DSH_OWNERS = ['packages/runtime-dsh/', 'apps/runtime/']
const DSH_ERROR = 'DSH imports are restricted to packages/runtime-dsh and apps/runtime'

const WORKSPACE_SCOPE = '@project311/'

/**
 * importer path prefix -> allowed `@project311/*` specifiers.
 *
 * `subpaths`（可选）是该 importer 的「同构子路径白名单」：一旦声明，来自该
 * importer 的子路径 specifier 一律默认违规，只有白名单里显式列出的完整子路径
 * （按包名归组）才放行——防止 node-only 子路径导出（如 `plugin-pack-digest`
 * 引 node:crypto）被包级归一规则带进 web bundle。未声明 `subpaths` 的
 * 服务端 importer（hub/node 等）保留归一放行行为。
 */
const DEPENDENCY_RULES: ReadonlyArray<{
  importer: string
  /** Bare package specifiers (`@project311/<name>`) allowed from this importer. */
  allowed: readonly string[]
  /** Isomorphic subpath whitelist; see the table doc comment above. */
  subpaths?: Readonly<Record<string, readonly string[]>>
}> = [
  {
    // testkit 是 apps/hub 的 devDependency，只准测试目录引用（Fake DeviceGateway/Fixtures）；
    // 排在 apps/hub/ 之前，靠前缀匹配让 src 侧 import testkit 直接判违规。
    importer: 'apps/hub/tests/',
    allowed: [
      '@project311/domain',
      '@project311/protocol',
      '@project311/db',
      '@project311/testkit',
    ],
  },
  {
    importer: 'apps/hub/',
    allowed: ['@project311/domain', '@project311/protocol', '@project311/db'],
  },
  {
    // 浏览器 bundle：protocol 的已声明子路径导出目前全部 node-only
    // （plugin-pack-digest 引 node:crypto），白名单显式置空；确有同构子路径
    // 时在 subpaths 里显式添加完整 specifier。
    importer: 'apps/web/',
    allowed: ['@project311/protocol'],
    subpaths: { '@project311/protocol': [] },
  },
  {
    // 验收链路测试（P1-13 run-projection-chain）：跨 app 验收需要直接读 DB 判定
    // 落库结果——与 apps/hub/tests/ 同型例外；src 侧仍禁 db（部署边界不变）。
    importer: 'apps/node/tests/',
    allowed: ['@project311/domain', '@project311/protocol', '@project311/db'],
  },
  { importer: 'apps/node/', allowed: ['@project311/domain', '@project311/protocol'] },
  { importer: 'apps/runtime/', allowed: ['@project311/protocol', '@project311/runtime-dsh'] },
  { importer: 'packages/domain/', allowed: [] },
  { importer: 'packages/protocol/', allowed: [] },
  { importer: 'packages/db/', allowed: ['@project311/domain', '@project311/protocol'] },
  { importer: 'packages/runtime-dsh/', allowed: ['@project311/protocol'] },
  {
    importer: 'packages/testkit/',
    allowed: [
      '@project311/domain',
      '@project311/protocol',
      '@project311/db',
      '@project311/runtime-dsh',
    ],
  },
]

/** Throws when the edge importer -> specifier violates a boundary rule. */
export function validateImport(importer: string, specifier: string): void {
  if (DSH_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    if (!DSH_OWNERS.some((prefix) => importer.startsWith(prefix))) {
      throw new Error(DSH_ERROR)
    }
    return
  }

  if (!specifier.startsWith(WORKSPACE_SCOPE)) return

  // 子路径导出（如 @project311/protocol/plugin-pack-digest）归一到包名再判定——
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
  const violations = await checkBoundaries(repoRoot)
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) {
    console.error(`check-boundaries: ${violations.length} violation(s) found`)
    process.exitCode = 1
  } else {
    console.log('check-boundaries: no violations')
  }
}
