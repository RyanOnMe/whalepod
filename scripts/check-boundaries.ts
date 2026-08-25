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

/** importer path prefix -> allowed `@project311/*` specifiers. */
const DEPENDENCY_RULES: ReadonlyArray<{ importer: string; allowed: readonly string[] }> = [
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
  { importer: 'apps/web/', allowed: ['@project311/protocol'] },
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

  const rule = DEPENDENCY_RULES.find(({ importer: prefix }) => importer.startsWith(prefix))
  if (!rule) return // importers outside apps//packages (e.g. scripts/) are not governed here

  if (!rule.allowed.includes(specifier)) {
    const allowed = rule.allowed.length > 0 ? rule.allowed.join(', ') : 'none'
    throw new Error(
      `Import "${specifier}" is not allowed from ${rule.importer} (allowed: ${allowed})`,
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
