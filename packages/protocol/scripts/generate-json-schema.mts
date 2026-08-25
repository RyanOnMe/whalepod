/**
 * JSON Schema 生成与漂移检查（02-第一阶段实施计划.md Task 3 Step 4）。
 *
 *   tsx scripts/generate-json-schema.mts           重新生成 generated/*.schema.json
 *   tsx scripts/generate-json-schema.mts --check   在临时目录再生成并 byte-compare，
 *                                                  不一致退出码 1（接在 pnpm check）
 *
 * generated/ 是纯生成物：改 wire 请先改 src/ 的 Zod schema 再重新生成，
 * 手改生成物会被 --check 拒绝。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ClientFrameSchema } from '../src/client-events.js'
import { ApiFailureSchema } from '../src/http.js'
import {
  NodeDownstreamSchema,
  NodeUpstreamSchema,
  ProjectedRunEventSchema,
} from '../src/node-wire.js'
import { RuntimeCommandSchema, RuntimeOutputSchema } from '../src/runtime-wire.js'

/** 生成清单：产物基名 → Zod schema。HTTP 请求 DTO 的 SSoT 是 Zod + fixtures/http/。 */
const ARTIFACTS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['node-upstream', NodeUpstreamSchema],
  ['node-downstream', NodeDownstreamSchema],
  ['runtime-command', RuntimeCommandSchema],
  ['runtime-output', RuntimeOutputSchema],
  ['client-frame', ClientFrameSchema],
  ['projected-run-event', ProjectedRunEventSchema],
  ['api-failure', ApiFailureSchema],
]

const GENERATED_DIR = fileURLToPath(new URL('../generated/', import.meta.url))
const checkMode = process.argv.includes('--check')

function renderArtifact(schema: z.ZodType): string {
  return `${JSON.stringify(z.toJSONSchema(schema, { reused: 'ref' }), null, 2)}\n`
}

function generateInto(dir: string): Map<string, string> {
  mkdirSync(dir, { recursive: true })
  const written = new Map<string, string>()
  for (const [name, schema] of ARTIFACTS) {
    const content = renderArtifact(schema)
    writeFileSync(join(dir, `${name}.schema.json`), content)
    written.set(`${name}.schema.json`, content)
  }
  return written
}

if (!checkMode) {
  const written = generateInto(GENERATED_DIR)
  // 清单外的滞留文件属于漂移，生成时一并清掉（--check 会在比对时发现它们）。
  for (const entry of readdirSync(GENERATED_DIR)) {
    if (!written.has(entry)) rmSync(join(GENERATED_DIR, entry))
  }
  console.log(`generated ${written.size} JSON schema artifacts in ${GENERATED_DIR}`)
} else {
  const tempDir = mkdtempSync(join(tmpdir(), 'protocol-json-schema-'))
  try {
    const expected = generateInto(tempDir)
    const problems: string[] = []
    const actualFiles = existsSync(GENERATED_DIR) ? readdirSync(GENERATED_DIR).sort() : []
    const expectedFiles = [...expected.keys()].sort()
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      problems.push(
        `file list mismatch: expected [${expectedFiles.join(', ')}], got [${actualFiles.join(', ')}]`,
      )
    }
    for (const [name, content] of expected) {
      const path = join(GENERATED_DIR, name)
      if (!existsSync(path)) {
        problems.push(`${name}: missing (run pnpm --filter @project311/protocol generate)`)
        continue
      }
      if (readFileSync(path, 'utf8') !== content) {
        problems.push(
          `${name}: stale or hand-edited (run pnpm --filter @project311/protocol generate)`,
        )
      }
    }
    if (problems.length > 0) {
      console.error('generated JSON schema drift detected:')
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
    } else {
      console.log(`generated JSON schemas are up to date (${expected.size} artifacts)`)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
