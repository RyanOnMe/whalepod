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
// reason: single-point mutation edits production predicates; these paths are never
// spawn/import entries. Vitest drives the HTTP/WS handlers and process-recovery modules.
// removeWhen: a mutation engine replaces source-file patching, remove these paths
// and their exact HARNESS_SRC_PATH_ALLOWLIST entries together.
const sourcePath = 'apps/hub/src/modules/router/service.ts'
const routerRoutesSource = 'apps/hub/src/modules/router/routes.ts'
const spec = 'apps/hub/tests/router-evaluation.integration.spec.ts'
const applicationSource = 'apps/hub/src/modules/router/application.ts'
const dispatchSource = 'apps/hub/src/modules/dispatch/service.ts'
const executorLedgerSource = 'packages/db/src/repositories/router.ts'
const applicationSpec = 'apps/hub/tests/router-application.integration.spec.ts'
const dbLedgerSpec = 'packages/db/tests/executor-ledger.integration.spec.ts'
const questionSource = 'apps/hub/src/modules/work/questions.ts'
const proposalSource = 'apps/hub/src/modules/work/scope-proposals.ts'
const workCommandSource = 'apps/hub/src/modules/work/commands.ts'
const workQuerySource = 'apps/hub/src/modules/work/queries.ts'
const workRepositorySource = 'packages/db/src/repositories/work.ts'
const scopeSpec = 'apps/hub/tests/work-scope-proposal.integration.spec.ts'
const nodeRecoverySource = 'apps/node/src/coordination/manager.ts'
const nodeRecoverySpec = 'apps/node/tests/coordination-recovery.spec.ts'
const output = join(root, 'artifacts/evidence/router-evaluation/mutations')
const summaryPath = join(output, 'result.json')

interface Mutation {
  id: string
  criterion: string
  needle: string
  replacement: string
  test: string
  source?: string
  spec?: string
  project?: 'integration' | 'unit'
  testTemplate?: string
}
interface Suite {
  spec: string
  project: 'integration' | 'unit'
}
const baselineSuites: readonly Suite[] = [
  { spec, project: 'integration' },
  { spec: applicationSpec, project: 'integration' },
  { spec: dbLedgerSpec, project: 'integration' },
  { spec: scopeSpec, project: 'integration' },
  { spec: nodeRecoverySpec, project: 'unit' },
]
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
      "// Receipt hits skip the command callback. Authorize the current read while holding\n  // Task before Work so reassignment cannot expose the former principal's proposal.\n  return deps.database.transaction(async (tx) => {\n    const { task } = await lockRouterContext(tx, workKey)\n    await requireAssignee(tx, task, actor.userId)",
    replacement:
      "// Receipt hits skip the command callback. Authorize the current read while holding\n  // Task before Work so reassignment cannot expose the former principal's proposal.\n  return deps.database.transaction(async (tx) => {\n    await lockRouterContext(tx, workKey)",
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
  {
    id: 'R20',
    criterion: 'a persisted terminal result does not prove its orphan process stopped',
    source: nodeRecoverySource,
    spec: nodeRecoverySpec,
    project: 'unit',
    needle: 'if (current === undefined || !(await this.ensureProcessStopped(current))) {',
    replacement: 'if (current === undefined) {',
    test: 'stops the owned result orphan before removing inputs and preserves terminal records',
    testTemplate: 'stops the owned %s orphan before removing inputs and preserves terminal records',
  },
  {
    id: 'R21',
    criterion: 'unknown live-process identity must keep private inputs pending',
    source: nodeRecoverySource,
    spec: nodeRecoverySpec,
    project: 'unit',
    needle: "if (state === 'unknown') return false",
    replacement: "if (state === 'unknown') return true",
    test: 'keeps cleanup pending when the live process identity cannot be confirmed',
  },
  {
    id: 'R22',
    criterion: 'EPERM is not proof that the broker process died',
    source: nodeRecoverySource,
    spec: nodeRecoverySpec,
    project: 'unit',
    needle: "? 'dead'\n      : 'unknown'",
    replacement: "? 'dead'\n      : 'dead'",
    test: 'does not treat EPERM from kill(0) as proof that the broker exited',
  },
  {
    id: 'R23',
    criterion: 'invalid journal UUIDs cannot authorize filesystem cleanup',
    source: nodeRecoverySource,
    spec: nodeRecoverySpec,
    project: 'unit',
    needle:
      '!CoordinationRequestPayloadSchema.shape.evaluationId.safeParse(row.evaluationId).success ||',
    replacement: 'false ||',
    test: 'keeps an invalid journal identity pending before filesystem cleanup',
  },
  {
    id: 'R24',
    criterion: 'private Router history must disable shared and stored caching',
    source: routerRoutesSource,
    needle:
      "app.get('/works/:workKey/router/evaluations', async (request, reply) => {\n    reply.header('cache-control', 'private, no-store')",
    replacement: "app.get('/works/:workKey/router/evaluations', async (request, reply) => {",
    test: 'exposes an empty owner-only evaluation history before a model is configured',
  },
  {
    id: 'R25',
    criterion: 'a dead leader cannot authorize cleanup while its process group survives',
    source: nodeRecoverySource,
    spec: nodeRecoverySpec,
    project: 'unit',
    needle: "return process.platform === 'win32' || coordinationPidState(-row.pid) === 'dead'",
    replacement: 'return true',
    test: 'keeps inputs until both the dead leader and its surviving process group have exited',
  },
  {
    id: 'A01',
    criterion: 'router application is idempotent by evaluation id',
    source: applicationSource,
    spec: applicationSpec,
    needle:
      'const existing = await getRouterApplication(tx, evaluationId)\n    if (existing !== undefined) return existing',
    replacement: 'const existing = await getRouterApplication(tx, evaluationId)',
    test: 'applies dispatch to a proposed intent and settles the machine Run usage',
  },
  {
    id: 'A02',
    criterion: 'an active Run prevents a second dispatch application',
    source: applicationSource,
    spec: applicationSpec,
    needle: "if ((await listActiveRunsByTask(tx, task.id)).length > 0) return stale('active_run')",
    replacement: "if (false) return stale('active_run')",
    test: 'refuses dispatch application while a machine Run is active',
  },
  {
    id: 'A03',
    criterion: 'dispatch action class must stay inside the Mandate',
    source: applicationSource,
    spec: applicationSpec,
    needle:
      "if (!mandate.allowedActionClasses.includes(proposal.actionClass))\n    return stale('action_class_forbidden')",
    replacement: "if (false) return stale('action_class_forbidden')",
    test: 'refuses dispatch proposals whose action class is outside the mandate',
  },
  {
    id: 'A04',
    criterion: 'explicit re-evaluation restores the work from router wait',
    source: sourcePath,
    spec: applicationSpec,
    needle:
      "work.state === 'waiting' &&\n          work.resumeMode === 'auto' &&\n          work.resumeCondition !== null &&\n          work.resumeCondition.startsWith('router:')",
    replacement: 'false',
    test: 'persists wait and re-evaluates explicitly without treating it as execution',
  },
  {
    id: 'A05',
    criterion: 'unpriced Executor dispatch fails closed',
    source: dispatchSource,
    spec: applicationSpec,
    needle:
      'candidate.inputPriceMicrosPerMillionTokens === null ||\n    candidate.outputPriceMicrosPerMillionTokens === null',
    replacement: 'false',
    test: 'shares work lifetime budget between Router and Executor and blocks unpriced dispatch',
  },
  {
    id: 'A06',
    criterion: 'Executor settlement records actual usage when available',
    source: executorLedgerSource,
    spec: applicationSpec,
    needle:
      "const chargeMode = zeroCharge\n    ? 'zero'\n    : usage === undefined || overReserved\n      ? 'reserved'\n      : 'actual'",
    replacement: "const chargeMode = 'reserved' as const",
    test: 'applies dispatch to a proposed intent and settles the machine Run usage',
  },
  {
    id: 'A07',
    criterion: 'Executor dispatch reserves usage in the Run-creation transaction',
    source: dispatchSource,
    spec: applicationSpec,
    needle:
      'await reserveExecutorForMachineRun(tx, {\n    work,\n    intent,\n    candidate,\n    runId: run.id,\n    ...(workInputItemIds === undefined ? {} : { workInputItemIds }),\n    now,\n  })',
    replacement: 'void reserveExecutorForMachineRun',
    test: 'shares work lifetime budget between Router and Executor and blocks unpriced dispatch',
  },
  {
    id: 'A08',
    criterion: 'Executor settlement only rolls back reserved budget scopes',
    source: executorLedgerSource,
    spec: dbLedgerSpec,
    needle:
      "...(reserved.teamReserved\n      ? [{ scope: 'team' as const, id: reserved.teamId, date: reserved.utcDate }]\n      : []),",
    replacement: "...[{ scope: 'team' as const, id: reserved.teamId, date: reserved.utcDate }],",
    test: 'does not decrement team/project rows that were not part of the reservation',
  },
  {
    id: 'S01',
    criterion: 'authorize_scope answers must carry a scope',
    source: questionSource,
    spec: scopeSpec,
    needle:
      "      if (input.scope === undefined) {\n        throw new ApiError(400, 'VALIDATION_FAILED', 'scope is required for authorize_scope')\n      }",
    replacement:
      "      if (false) {\n        throw new ApiError(400, 'VALIDATION_FAILED', 'scope is required for authorize_scope')\n      }",
    test: 'rejects wrong answer types, missing or invalid scope, and non-assignee actors',
  },
  {
    id: 'S02',
    criterion: 'authorize_scope questions cannot be downgraded to choose_option',
    source: questionSource,
    spec: scopeSpec,
    needle:
      "    if (input.answerType === 'choose_option') {\n      throw new ApiError(\n        400,\n        'UNSUPPORTED_ANSWER',\n        'authorize_scope question cannot be answered with choose_option',\n      )\n    }",
    replacement:
      "    if (false) {\n      throw new ApiError(\n        400,\n        'UNSUPPORTED_ANSWER',\n        'authorize_scope question cannot be answered with choose_option',\n      )\n    }",
    test: 'rejects wrong answer types, missing or invalid scope, and non-assignee actors',
  },
  {
    id: 'S04',
    criterion: 'an authorize_scope answer creates a pending proposal, not a confirmed mandate',
    source: questionSource,
    spec: scopeSpec,
    needle: "status: 'pending',",
    replacement: "status: 'confirmed',",
    test: 'records a pending proposal without expanding the current mandate, then confirms one new version',
  },
  {
    id: 'S05',
    criterion: 'only the task assignee can confirm a scope proposal',
    source: proposalSource,
    spec: scopeSpec,
    needle: 'await requireAssignee(tx, task, actorUserId)',
    replacement: 'void requireAssignee',
    test: 'rejects wrong answer types, missing or invalid scope, and non-assignee actors',
  },
  {
    id: 'S06',
    criterion: 'confirmation requires the proposal base mandate to still be current',
    source: proposalSource,
    spec: scopeSpec,
    needle:
      "if (\n        latest === undefined ||\n        latest.id !== proposal.baseMandateId ||\n        latest.version !== proposal.baseMandateVersion ||\n        work.mandateId !== latest.id\n      ) {\n        stale(proposal, 'mandate_changed')\n      }",
    replacement: "if (false) {\n        stale(proposal, 'mandate_changed')\n      }",
    test: 'refuses confirmation when the base mandate advanced without a pending supersede',
  },
  {
    id: 'S07',
    criterion: 'confirmation closes the old decision as superseded',
    source: proposalSource,
    spec: scopeSpec,
    needle:
      'const closedQuestion =\n        (await markWorkQuestionSuperseded(tx, proposal.questionId, now)) ?? question',
    replacement: 'const closedQuestion = question',
    test: 'records a pending proposal without expanding the current mandate, then confirms one new version',
  },
  {
    id: 'S08',
    criterion: 'a new mandate version supersedes pending scope proposals',
    source: workCommandSource,
    spec: scopeSpec,
    needle:
      'await supersedePendingWorkMandateProposals(tx, {\n    workId: work.id,\n    now,\n    ...(input.keepProposalId === undefined ? {} : { exceptId: input.keepProposalId }),\n  })',
    replacement: 'void supersedePendingWorkMandateProposals',
    test: 'supersedes the pending proposal when a new mandate version appears, and refuses confirmation',
  },
  {
    id: 'S09',
    criterion: 'pending scope proposals are visible only to the current assignee',
    source: workRepositorySource,
    spec: scopeSpec,
    needle:
      "eq(workMandateProposals.status, 'pending'),\n        eq(workMandateProposals.principalUserId, principalUserId),",
    replacement:
      "eq(workMandateProposals.status, 'pending'),\n        eq(workMandateProposals.status, 'pending'),",
    test: 'does not expose another member pending proposal in the work detail',
  },
  {
    id: 'S10',
    criterion: 'work detail exposes pending scope proposals',
    source: workQuerySource,
    spec: scopeSpec,
    needle: 'listPendingWorkMandateProposals(database.db, work.id, currentAssigneeUserId, 50),',
    replacement: 'Promise.resolve([]),',
    test: 'records a pending proposal without expanding the current mandate, then confirms one new version',
  },
  {
    id: 'S11',
    criterion: 'repeated confirmation returns the same mandate version',
    source: proposalSource,
    spec: scopeSpec,
    needle: "if (proposal.status === 'confirmed') {",
    replacement: 'if (false) {',
    test: 'records a pending proposal without expanding the current mandate, then confirms one new version',
  },
  {
    id: 'S12',
    criterion: 'scope agents are validated before a proposal is created',
    source: questionSource,
    spec: scopeSpec,
    needle: 'await assertAllowedAgents(tx, scope.allowedAgentIds)',
    replacement: 'void assertAllowedAgents',
    test: 'rejects wrong answer types, missing or invalid scope, and non-assignee actors',
  },
  {
    id: 'S13',
    criterion: 'a reassigned owner gets DECISION_STALE instead of FORBIDDEN',
    source: proposalSource,
    spec: scopeSpec,
    needle:
      'if (task.assigneeUserId !== actorUserId && proposal.principalUserId === actorUserId) {',
    replacement: 'if (false) {',
    test: 'returns DECISION_STALE to the reassigned owner and hides the proposal from the new assignee',
  },
  {
    id: 'S14',
    criterion: 'confirmation requires the base mandate to remain unexpired',
    source: proposalSource,
    spec: scopeSpec,
    needle:
      "if (latest.status !== 'active' || latest.expiresAt.getTime() <= now.getTime()) {\n        stale(proposal, 'mandate_inactive')\n      }",
    replacement: "if (false) {\n        stale(proposal, 'mandate_inactive')\n      }",
    test: 'refuses confirmation when the base mandate has expired',
  },
  {
    id: 'S15',
    criterion: 'confirmation revalidates the answered scope',
    source: proposalSource,
    spec: scopeSpec,
    needle: 'assertMandateScope(scope, actorUserId, now)',
    replacement: 'void assertMandateScope',
    test: 'refuses confirmation after the answered scope itself expires',
  },
  {
    id: 'S16',
    criterion: 'a full_access task policy blocks confirmation',
    source: proposalSource,
    spec: scopeSpec,
    needle: "if (task.approvalPolicy === 'full_access') stale(proposal, 'task_policy_changed')",
    replacement: "if (false) stale(proposal, 'task_policy_changed')",
    test: 'refuses confirmation when the task policy changed to full_access',
  },
  {
    id: 'S17',
    criterion: 'confirmation requires an active work',
    source: proposalSource,
    spec: scopeSpec,
    needle: "if (work.state !== 'active') stale(proposal, 'work_inactive')",
    replacement: "if (false) stale(proposal, 'work_inactive')",
    test: 'refuses confirmation while the work is waiting',
  },
  {
    id: 'R26',
    criterion: 'cleanup attempt identity must remain a safe positive integer',
    source: nodeRecoverySource,
    spec: nodeRecoverySpec,
    project: 'unit',
    needle: '!Number.isSafeInteger(row.attempt)',
    replacement: 'false',
    test: 'keeps an invalid journal identity pending before filesystem cleanup',
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
  source: string
  spec: string
  project: string
  status: 'killed' | 'survived' | 'invalid'
  exitCode: number
  failedTests: number
  assertionFailures: string[]
}
interface BaselineResult {
  spec: string
  project: string
  totalTests: number
  passedTests: number
  failedTests: number
  exitCode: number
  pass: boolean
}
function target(mutation: Mutation) {
  return {
    source: mutation.source ?? sourcePath,
    spec: mutation.spec ?? spec,
    project: mutation.project ?? 'integration',
  }
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
async function command(
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<number> {
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
    const timeout = setTimeout(stop, timeoutMs)
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
  suite: Pick<Suite, 'spec' | 'project'>,
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
    suite.project,
    suite.spec,
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

async function runBaselines(
  phase: string,
  reportRoot: string,
  signal: AbortSignal,
): Promise<BaselineResult[]> {
  const results: BaselineResult[] = []
  for (const suite of baselineSuites) {
    const run = await runSuite(`${phase}-${suite.project}`, reportRoot, signal, suite)
    results.push({
      ...suite,
      totalTests: run.report.numTotalTests,
      passedTests: run.report.numPassedTests,
      failedTests: run.report.numFailedTests,
      exitCode: run.exitCode,
      pass:
        run.exitCode === 0 &&
        run.report.numFailedTests === 0 &&
        run.report.numPassedTests > 0 &&
        run.report.numPassedTests === run.report.numTotalTests,
    })
  }
  return results
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    assert.ok(!process.argv.includes('--database-ready'), 'PostgreSQL wrapper supplied no database')
    process.exitCode = await command(
      [
        'exec',
        'tsx',
        'scripts/with-test-postgres.mts',
        'pnpm',
        'exec',
        'tsx',
        script,
        '--database-ready',
      ],
      undefined,
      600_000,
    )
    return
  }
  await mkdir(output, { recursive: true })
  await rm(summaryPath, { force: true })
  const requested = (process.env.MUTATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  const activeMutations =
    requested.length === 0
      ? mutations
      : mutations.filter((mutation) => requested.includes(mutation.id))
  assert.ok(activeMutations.length > 0, 'MUTATION_IDS selected no mutation')
  const sources = [...new Set(activeMutations.map((mutation) => target(mutation).source))]
  const originals = new Map(
    await Promise.all(
      sources.map(async (source) => [source, await readFile(join(root, source), 'utf8')] as const),
    ),
  )
  const sourceDigests = new Map(sources.map((source) => [source, digest(originals.get(source)!)]))
  const specs = [...new Set(activeMutations.map((mutation) => target(mutation).spec))]
  const specSources = new Map(
    await Promise.all(
      specs.map(async (path) => [path, await readFile(join(root, path), 'utf8')] as const),
    ),
  )
  for (const mutation of activeMutations) {
    const { source, spec: testSpec } = target(mutation)
    const original = originals.get(source)!
    assert.equal(
      original.split(mutation.needle).length - 1,
      1,
      `${mutation.id}: mutation predicate changed or is not unique`,
    )
    assert.ok(
      specSources
        .get(testSpec)!
        .includes(
          mutation.testTemplate ??
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
  let baselineBeforeRuns: BaselineResult[] = []
  let baselineAfterRuns: BaselineResult[] = []
  let restored = false
  try {
    baselineBeforeRuns = await runBaselines('baseline-before', reportRoot, controller.signal)
    baselineBefore = baselineBeforeRuns.every((run) => run.pass)
    baselineBeforeTests = baselineBeforeRuns.reduce((total, run) => total + run.passedTests, 0)
    assert.ok(baselineBefore, 'baseline is red or does not execute every required test')
    for (const mutation of activeMutations) {
      for (const source of sources)
        assert.equal(
          await readFile(join(root, source), 'utf8'),
          originals.get(source),
          `source changed while mutation harness was running: ${source}`,
        )
      const mutationTarget = target(mutation)
      const original = originals.get(mutationTarget.source)!
      await writeFile(
        join(root, mutationTarget.source),
        original.replace(mutation.needle, mutation.replacement),
      )
      try {
        const run = await runSuite(
          mutation.id,
          reportRoot,
          controller.signal,
          mutationTarget,
          mutation.test,
        )
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
          ...mutationTarget,
          status,
          exitCode: run.exitCode,
          failedTests: run.report.numFailedTests,
          assertionFailures: run.assertionFailures,
        })
        console.log(`${mutation.id} ${status.toUpperCase()}: ${mutation.criterion}`)
      } finally {
        await writeFile(join(root, mutationTarget.source), original)
      }
    }
  } finally {
    // Restore even when a test process fails, a JSON report is absent, or a signal
    // interrupts the runner. Do not retain raw reports or source copies as evidence.
    for (const source of sources) await writeFile(join(root, source), originals.get(source)!)
    const restoredSources = await Promise.all(
      sources.map(async (source) => ({
        source,
        sourceDigest: sourceDigests.get(source),
        restored: digest(await readFile(join(root, source), 'utf8')) === sourceDigests.get(source),
      })),
    )
    restored = restoredSources.every((source) => source.restored)
    try {
      if (baselineBefore && !controller.signal.aborted) {
        baselineAfterRuns = await runBaselines('baseline-after', reportRoot, controller.signal)
        baselineAfter = baselineAfterRuns.every((run) => run.pass)
        baselineAfterTests = baselineAfterRuns.reduce((total, run) => total + run.passedTests, 0)
      }
    } finally {
      await rm(reportRoot, { recursive: true, force: true })
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      const pass =
        baselineBefore &&
        baselineAfter &&
        restored &&
        results.length === activeMutations.length &&
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
            sourceDigest: sourceDigests.get(sourcePath),
            sources: restoredSources,
            baselineBefore,
            baselineAfter,
            baselineBeforeTests,
            baselineAfterTests,
            baselineBeforeRuns,
            baselineAfterRuns,
            restored,
            expectedMutations: activeMutations.length,
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
  assert.equal(results.length, activeMutations.length, 'mutation evidence is incomplete')
  assert.ok(
    results.every((result) => result.status === 'killed'),
    'a mutation survived or failed without an assertion',
  )
  console.log(`Router mutation evidence PASS (${results.length}/${activeMutations.length})`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(redactText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
