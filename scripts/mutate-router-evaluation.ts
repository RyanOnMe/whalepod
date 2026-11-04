#!/usr/bin/env tsx
/** #519: one predicate at a time; assertion failures must kill it, then restore the source. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactText } from './lib/phase1/events.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = 'scripts/mutate-router-evaluation.ts'
// reason: single-point mutation edits the production predicate; this path is never
// a spawn/import entry. Vitest still drives the production HTTP/WS module assembly.
// removeWhen: a mutation engine replaces source-file patching, remove this path and
// its exact HARNESS_SRC_PATH_ALLOWLIST entry together.
const sourcePath = 'apps/hub/src/modules/router/service.ts'
const spec = 'apps/hub/tests/router-evaluation.integration.spec.ts'
const output = join(root, 'artifacts/evidence/router-evaluation/mutations')
const summaryPath = join(output, 'result.json')

interface Mutation {
  id: string
  criterion: string
  needle: string
  replacement: string
  test: string
}
const mutations: readonly Mutation[] = [
  {
    id: 'R01',
    criterion: 'completed usage is mandatory',
    needle: "if (payload.status === 'completed' && !usage) rejection = 'usage_missing'",
    replacement: "if (false) rejection = 'usage_missing'",
    test: 'rejects missing_usage and settles without a proposal',
  },
  {
    id: 'R02',
    criterion: 'citations must name a read manifest entry',
    needle: "rejection = 'invalid_citation'",
    replacement: 'rejection = undefined',
    test: 'rejects forged_citation and settles without a proposal',
  },
  {
    id: 'R03',
    criterion: 'result evaluation identity must match',
    needle:
      "if (payload.evaluationDigest !== row.evaluationDigest) rejection = 'evaluation_digest_mismatch'",
    replacement: "if (false) rejection = 'evaluation_digest_mismatch'",
    test: 'rejects wrong_digest and settles without a proposal',
  },
  {
    id: 'R04',
    criterion: 'a lease cannot be forged',
    needle: 'row.leaseToken === payload.leaseToken',
    replacement: 'true',
    test: 'rejects wrong lease and attempt without consuming the valid attempt',
  },
  {
    id: 'R05',
    criterion: 'another attempt cannot claim this result',
    needle: 'row.attempt === payload.attempt',
    replacement: 'true',
    test: 'rejects wrong lease and attempt without consuming the valid attempt',
  },
  {
    id: 'R06',
    criterion: 'a deadline is rechecked after rebuilding inputs',
    needle: 'row.deadlineAt > now',
    replacement: 'true',
    test: 'rechecks a lease that expires while rebuilding authorized input',
  },
  {
    id: 'R07',
    criterion: 'unknown coverage cannot dispatch',
    needle: "rejection = 'unsupported_dispatch'",
    replacement: 'rejection = undefined',
    test: 'rejects unknown_coverage and settles without a proposal',
  },
  {
    id: 'R08',
    criterion: 'current authority and configuration fence acceptance',
    needle: "rejection = 'input_or_authority_changed'",
    replacement: 'rejection = undefined',
    test: 'ignores a stale result after explicit model configuration changes',
  },
  {
    id: 'R09',
    criterion: 'wait cannot extend the Mandate deadline',
    needle: "rejection = 'invalid_wait_deadline'",
    replacement: 'rejection = undefined',
    test: 'enforces the current Mandate wait deadline instead of allowing an arbitrary day',
  },
  {
    id: 'R10',
    criterion: 'cached command reads reauthorize the current assignee',
    needle:
      'const { task } = await lockRouterContext(tx, workKey)\n    await requireAssignee(tx, task, actor.userId)',
    replacement: 'await lockRouterContext(tx, workKey)',
    test: 'reauthorizes cached evaluation receipts after reassignment and hides old principal history',
  },
  {
    id: 'R11',
    criterion: 'same-identity concurrent commands reuse one evaluation',
    needle: "if (previous && previous.status !== 'failed') return previous",
    replacement: "if (false && previous && previous.status !== 'failed') return previous",
    test: 'deduplicates concurrent requests and redelivery without another reservation',
  },
  {
    id: 'R12',
    criterion: 'model start requires every input read receipt',
    needle:
      'payload.modelStartedAt !== undefined &&\n        manifest.some((e) => ![...row.readEntryIds, ...payload.readEntryIds].includes(e.id))',
    replacement: 'false',
    test: 'does not acknowledge model start until every manifest input has a read receipt',
  },
  {
    id: 'R13',
    criterion: 'each source receives exactly one coverage judgment',
    needle: 'proposal.coverage.length !== sources.length ||',
    replacement: 'false ||',
    test: 'rejects duplicate source coverage even when all unique sources are present',
  },
  {
    id: 'R14',
    criterion: 'Mandate revisions do not reset charged work failures',
    needle: 'failedRouter + failedExecutor >= input.mandate.maxAttempts',
    replacement: 'false',
    test: 'keeps charged failures across new Mandate versions instead of resetting attempts',
  },
  {
    id: 'R15',
    criterion: 'Hub cancellation alone never proves zero model spend',
    needle: 'row.preModelFailureConfirmed &&',
    replacement: 'true &&',
    test: 'a source cancellation without model-start acknowledgement never proves a free model call',
  },
  {
    id: 'R16',
    criterion: 'completed output needs a persisted model-start marker after reads',
    needle: "if (payload.status === 'completed' && row.modelStartedAt === null)",
    replacement: 'if (false)',
    test: 'requires persisted model-start evidence even after complete read receipts',
  },
  {
    id: 'R17',
    criterion: 'usage cannot exceed the reserved token and cost limits',
    needle: "if (!usageValid) rejection = 'over_budget'",
    replacement: "if (false) rejection = 'over_budget'",
    test: 'rejects over_usage and settles without a proposal',
  },
  {
    id: 'R18',
    criterion: 'unknown coverage cannot be ignored',
    needle: "rejection = 'unsupported_ignore'",
    replacement: 'rejection = undefined',
    test: 'rejects unknown_ignore and settles without a proposal',
  },
  {
    id: 'R19',
    criterion: 'the result digest must cover the exact accepted proposal',
    needle: "rejection = 'result_digest_mismatch'",
    replacement: 'rejection = undefined',
    test: 'rejects wrong_result_digest and settles without a proposal',
  },
]

interface AssertionResult {
  fullName: string
  status: string
  failureMessages?: string[]
}
interface VitestReport {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numRuntimeErrorTestSuites?: number
  testResults: Array<{ assertionResults: AssertionResult[] }>
}
interface RunResult {
  exitCode: number
  report: VitestReport
  assertionFailures: string[]
}
interface MutationResult {
  id: string
  criterion: string
  test: string
  status: 'killed' | 'survived' | 'invalid'
  exitCode: number
  failedTests: number
  assertionFailures: string[]
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
/** Vitest's promise matchers use Error, rather than AssertionError, for mismatches. */
export function isRouterMutationAssertionFailure(message: string): boolean {
  return (
    /^AssertionError:/.test(message) ||
    /^Error: promise (?:resolved [^\n]+ instead of rejecting|rejected [^\n]+ instead of resolving)(?:\n|$)/.test(
      message,
    )
  )
}
async function command(args: readonly string[], signal?: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    })
    let forcedStop: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      const kill = (name: NodeJS.Signals): void => {
        if (child.pid === undefined) return
        try {
          if (process.platform === 'win32') child.kill(name)
          else process.kill(-child.pid, name)
        } catch {
          // The process group may already have exited.
        }
      }
      kill('SIGTERM')
      forcedStop = setTimeout(() => kill('SIGKILL'), 3000)
      forcedStop.unref()
    }
    const timeout = setTimeout(stop, 120_000)
    timeout.unref()
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const cleanup = (): void => {
      clearTimeout(timeout)
      if (forcedStop !== undefined) clearTimeout(forcedStop)
      signal?.removeEventListener('abort', stop)
    }
    child.once('error', () => cleanup())
    child.once('error', reject)
    child.once('exit', (code, exitSignal) => {
      cleanup()
      if (code !== null) resolve(code)
      else reject(new Error(`test command ended by ${exitSignal ?? 'unknown signal'}`))
    })
  })
}

async function runSuite(
  id: string,
  reportRoot: string,
  signal: AbortSignal,
  test?: string,
): Promise<RunResult> {
  // Raw Vitest reports can include request bodies on failure. Keep them private and
  // emit only a fixed metadata projection to the evidence directory.
  const reportPath = join(reportRoot, `${id}.json`)
  const args = [
    'exec',
    'vitest',
    'run',
    '--project',
    'integration',
    spec,
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ]
  if (test !== undefined) args.push('--testNamePattern', regexLiteral(test))
  const exitCode = await command(args, signal)
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as VitestReport
  assert.ok(Number.isInteger(report.numTotalTests) && report.numTotalTests > 0, 'no tests executed')
  assert.ok(Array.isArray(report.testResults), 'missing test suites')
  const assertionFailures = report.testResults.flatMap((suite) =>
    suite.assertionResults
      .filter(
        (testCase) =>
          testCase.status === 'failed' &&
          testCase.failureMessages?.some(isRouterMutationAssertionFailure),
      )
      .map((testCase) => redactText(testCase.fullName)),
  )
  return { exitCode, report, assertionFailures }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    assert.ok(!process.argv.includes('--database-ready'), 'PostgreSQL wrapper supplied no database')
    process.exitCode = await command([
      'exec',
      'tsx',
      'scripts/with-test-postgres.mts',
      'pnpm',
      'exec',
      'tsx',
      script,
      '--database-ready',
    ])
    return
  }
  await mkdir(output, { recursive: true })
  await rm(summaryPath, { force: true })
  const original = await readFile(join(root, sourcePath), 'utf8')
  const sourceDigest = digest(original)
  const specSource = await readFile(join(root, spec), 'utf8')
  for (const mutation of mutations) {
    assert.equal(
      original.split(mutation.needle).length - 1,
      1,
      `${mutation.id}: mutation predicate changed or is not unique`,
    )
    assert.ok(
      specSource.includes(
        mutation.test.replace(
          /^rejects (missing_usage|forged_citation|wrong_digest|unknown_coverage|over_usage|wrong_model|underreported_cost|unknown_ignore|missing_coverage|wrong_result_digest) and settles without a proposal$/,
          'rejects %s and settles without a proposal',
        ),
      ),
      `${mutation.id}: target regression test is missing`,
    )
  }
  const reportRoot = await mkdtemp(join(tmpdir(), 'whalepod-router-mutation-'))
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const results: MutationResult[] = []
  let baselineBefore = false
  let baselineAfter = false
  let baselineBeforeTests = 0
  let baselineAfterTests = 0
  let restored = false
  try {
    const baseline = await runSuite('baseline-before', reportRoot, controller.signal)
    assert.equal(baseline.exitCode, 0, 'baseline is red before mutation')
    assert.equal(baseline.report.numFailedTests, 0, 'baseline contains failed tests')
    assert.ok(baseline.report.numPassedTests > 0, 'baseline has no successful executions')
    baselineBefore = true
    baselineBeforeTests = baseline.report.numPassedTests
    for (const mutation of mutations) {
      assert.equal(
        await readFile(join(root, sourcePath), 'utf8'),
        original,
        'source changed while mutation harness was running',
      )
      await writeFile(
        join(root, sourcePath),
        original.replace(mutation.needle, mutation.replacement),
      )
      try {
        const run = await runSuite(mutation.id, reportRoot, controller.signal, mutation.test)
        const killed =
          run.exitCode !== 0 &&
          run.report.numFailedTests > 0 &&
          run.assertionFailures.length > 0 &&
          (run.report.numRuntimeErrorTestSuites ?? 0) === 0
        const status = killed ? 'killed' : run.exitCode === 0 ? 'survived' : 'invalid'
        results.push({
          id: mutation.id,
          criterion: mutation.criterion,
          test: mutation.test,
          status,
          exitCode: run.exitCode,
          failedTests: run.report.numFailedTests,
          assertionFailures: run.assertionFailures,
        })
        console.log(`${mutation.id} ${status.toUpperCase()}: ${mutation.criterion}`)
      } finally {
        await writeFile(join(root, sourcePath), original)
      }
    }
  } finally {
    // Restore even when a test process fails, a JSON report is absent, or a signal
    // interrupts the runner. Do not retain raw reports or source copies as evidence.
    await writeFile(join(root, sourcePath), original)
    restored = digest(await readFile(join(root, sourcePath), 'utf8')) === sourceDigest
    try {
      if (baselineBefore && !controller.signal.aborted) {
        const after = await runSuite('baseline-after', reportRoot, controller.signal)
        baselineAfter =
          after.exitCode === 0 &&
          after.report.numFailedTests === 0 &&
          after.report.numPassedTests > 0
        baselineAfterTests = after.report.numPassedTests
      }
    } finally {
      await rm(reportRoot, { recursive: true, force: true })
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      const pass =
        baselineBefore &&
        baselineAfter &&
        restored &&
        results.length === mutations.length &&
        results.every((result) => result.status === 'killed')
      await writeFile(
        summaryPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            issue: 519,
            component: 'harness.router_mutation',
            generatedAt: new Date().toISOString(),
            source: sourcePath,
            sourceDigest,
            baselineBefore,
            baselineAfter,
            baselineBeforeTests,
            baselineAfterTests,
            restored,
            expectedMutations: mutations.length,
            mutations: results,
            status: pass ? 'pass' : 'fail',
          },
          null,
          2,
        ),
      )
      if (!pass) process.exitCode = 1
    }
  }
  assert.ok(baselineAfter && restored, 'source restoration or final baseline failed')
  assert.equal(results.length, mutations.length, 'mutation evidence is incomplete')
  assert.ok(
    results.every((result) => result.status === 'killed'),
    'a mutation survived or failed without an assertion',
  )
  console.log(`Router mutation evidence PASS (${results.length}/${mutations.length})`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(redactText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
