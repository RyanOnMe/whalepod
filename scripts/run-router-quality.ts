#!/usr/bin/env tsx
/** Real provider evaluation; isolated Hub, Node, DB and worker; only synthetic fixture inputs. */
import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { schema } from '@whalepod/db'
import {
  CoordinationInputEntrySchema,
  coordinationInputTokenEstimate,
  coordinationUsageCost,
} from '@whalepod/protocol'
import { ProductionAcceptance, repoRoot, until } from './lib/production-acceptance.js'
import { ROUTER_QUALITY_CASES, type RouterQualityCase } from './lib/router-quality-cases.js'
import {
  digest,
  freezeRouterQuality,
  QUALITY_ASSEMBLY,
  QUALITY_ENDPOINT,
  QUALITY_MAX_CASE_COST_MICROS,
  QUALITY_MAX_INPUT,
  QUALITY_MAX_OUTPUT,
  QUALITY_MAX_SPLIT_COST_MICROS,
  QUALITY_MODEL,
  QUALITY_PROVIDER,
  QUALITY_SLOT,
  qualityDatasetDigest,
  ROUTER_QUALITY_RUBRIC_VERSION,
  verifyRouterQuality,
  type QualityCaseResult,
  type QualityFreeze,
  type QualityHoldoutWitness,
  type QualityResult,
} from './lib/router-quality.js'
import {
  configureFixtureExecutor,
  makePublishedFixture,
  fixtureProvider,
} from './lib/router-quality-artifact-fixture.js'
import { verifyM1RA } from './verify-m1r-a-acceptance.js'
import {
  assertNoHoldoutEvidence,
  fingerprintProductionAssembly,
  pathExists,
  reserveHoldoutAttempt,
} from './lib/acceptance-provenance.js'

const execute = promisify(execFile)
const evidenceRoot = join(repoRoot, 'artifacts/evidence/router-quality')
// Peak Command Code USD / million tokens, stored as integer micro-USD. Ledger is not invoice.
const pricing = { input: 300_000, output: 1_200_000 }
const configuration = {
  maxInputTokens: QUALITY_MAX_INPUT,
  maxOutputTokens: QUALITY_MAX_OUTPUT,
  maxCostMicros: QUALITY_MAX_CASE_COST_MICROS,
  inputPriceMicrosPerMillionTokens: pricing.input,
  outputPriceMicrosPerMillionTokens: pricing.output,
  timeoutSeconds: 65,
  maxRetries: 0,
}
assert(
  configuration.maxInputTokens > coordinationInputTokenEstimate([]),
  'input ceiling cannot fit Router protocol overhead',
)
assert(
  coordinationUsageCost({
    ...configuration,
    inputTokens: configuration.maxInputTokens,
    outputTokens: configuration.maxOutputTokens,
  }) <= configuration.maxCostMicros,
  'case budget cannot cover the configured input and output ceilings',
)
const terminal = ['completed', 'failed', 'cancelled', 'stale', 'skipped'] as const
const { values } = parseArgs({
  options: {
    split: { type: 'string' },
    'key-file': { type: 'string' },
    'prepare-only': { type: 'boolean' },
  },
})
const split = values.split
assert(
  split === 'development' || split === 'holdout',
  'provide --split development or --split holdout',
)
assert(
  Boolean(values['prepare-only']) !== Boolean(values['key-file']),
  'supply --key-file for real requests, or --prepare-only without a key',
)
const prepareOnly = values['prepare-only'] === true
const keyPath = values['key-file']
const cases = ROUTER_QUALITY_CASES.filter((item) => item.split === split)
const output = join(evidenceRoot, split)
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim()
const sourceFiles = [
  'scripts/run-router-quality.ts',
  'scripts/verify-router-quality.ts',
  'scripts/lib/production-acceptance.ts',
  'scripts/lib/acceptance-provenance.ts',
  'scripts/lib/router-quality.ts',
  'scripts/lib/router-quality-cases.ts',
  'scripts/lib/router-quality-artifact-fixture.ts',
  'scripts/verify-m1r-a-acceptance.ts',
]
const sourceFingerprint = await Promise.all(
  sourceFiles.map(async (path) => digest(await readFile(join(repoRoot, path), 'utf8'))),
)
const sourceDigest = digest(
  JSON.stringify([
    ...sourceFingerprint,
    digest(
      execFileSync(
        'git',
        [
          'diff',
          '--no-ext-diff',
          '--binary',
          'HEAD',
          '--',
          'apps',
          'packages',
          'pnpm-lock.yaml',
          'dsh.lock.json',
        ],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20_000_000 },
      ),
    ),
  ]),
)

const assemblyDigest = await fingerprintProductionAssembly(repoRoot)
let engineeringEvidenceDigest = ''
if (!prepareOnly) {
  const engineeringEvidence = join(repoRoot, 'artifacts/evidence/m1r-a/result.json')
  const verified = await verifyM1RA(engineeringEvidence, assemblyDigest)
  engineeringEvidenceDigest = verified.resultDigest
}
let freeze: QualityFreeze | undefined
let rawFreeze: string | undefined
let frozenAt: string | undefined
if (!prepareOnly && split === 'holdout') {
  await assertNoHoldoutEvidence(output)
  rawFreeze = await readFile(join(evidenceRoot, 'freeze.json'), 'utf8')
  freeze = JSON.parse(rawFreeze) as QualityFreeze
  assert(
    freeze.schemaVersion === 2 && freeze.frozenAt,
    'legacy freeze cannot authorize a real holdout run',
  )
  frozenAt = freeze.frozenAt
  assert(Date.parse(frozenAt) < Date.now(), 'freeze must precede holdout start')
  const development = await readFile(join(evidenceRoot, 'development/result.json'), 'utf8')
  assert.deepEqual(
    freeze,
    freezeRouterQuality(development, frozenAt),
    'freeze does not match development evidence',
  )
  assert.equal(freeze.sourceRevision, sourceRevision, 'source revision changed after freeze')
  assert.equal(freeze.sourceDigest, sourceDigest, 'source files changed after freeze')
  assert.equal(freeze.assemblyDigest, assemblyDigest, 'assembly changed after freeze')
  assert.equal(
    freeze.engineeringEvidenceDigest,
    engineeringEvidenceDigest,
    'engineering evidence changed after freeze',
  )
} else if (!prepareOnly) {
  await assertNoHoldoutEvidence(join(evidenceRoot, 'holdout'))
  assert(
    !(await pathExists(join(evidenceRoot, 'freeze.json'))),
    'preserve the frozen development result before starting a new campaign',
  )
}

async function readKey(): Promise<string | undefined> {
  if (prepareOnly) return undefined
  assert(keyPath, 'real requests need a key file')
  const file = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    assert(
      info.isFile() &&
        (info.mode & 0o777) === 0o600 &&
        info.uid === process.getuid?.() &&
        info.size <= 4096,
      'key file must be a private 0600 regular file',
    )
    const key = (await file.readFile('utf8')).trim()
    assert(/^[\x21-\x7e]{8,4096}$/.test(key), 'invalid provider key format')
    return key
  } finally {
    await file.close()
  }
}

// Auth material never becomes an inherited env var or a command argument for the broker.
const key = await readKey()
delete process.env.CMD_API_KEY
const holdout =
  rawFreeze && frozenAt
    ? await reserveHoldoutAttempt(output, digest(rawFreeze), frozenAt)
    : undefined
const witness: QualityHoldoutWitness | undefined =
  holdout && rawFreeze ? { rawFreeze, rawAttempt: holdout.raw } : undefined
const h = new ProductionAcceptance(fixtureProvider)
if (key) h.protect(key)
const report: QualityResult = {
  schemaVersion: 2,
  split,
  generatedAt: holdout?.attempt.startedAt ?? new Date().toISOString(),
  assemblyDigest,
  ...(holdout
    ? { holdout: { freezeDigest: holdout.attempt.freezeDigest, attemptDigest: holdout.digest } }
    : {}),
  assembly: QUALITY_ASSEMBLY,
  endpoint: QUALITY_ENDPOINT,
  provider: QUALITY_PROVIDER,
  model: QUALITY_MODEL,
  datasetDigest: qualityDatasetDigest,
  rubricVersion: ROUTER_QUALITY_RUBRIC_VERSION,
  sourceRevision,
  sourceDigest,
  engineeringEvidenceDigest,
  pricing,
  cases: [],
}

async function prepareCase(
  projectId: string,
  item: RouterQualityCase,
  executor: Awaited<ReturnType<typeof configureFixtureExecutor>>,
) {
  const task = await h.api<{ id: string }>(`/projects/${projectId}/tasks`, {
    title: item.title,
    assigneeUserId: h.owner.userId,
  })
  await h.api(`/tasks/${task.id}/accept`, {})
  const agreement = await h.api<{ draftVersion: number }>(`/tasks/${task.id}/agreement/draft`, {
    content: {
      goal: item.goal,
      constraints: item.constraints,
      acceptance: '草稿引用可核对依据；正式业务动作必须人工确认。',
      openQuestions: '暂无其他已确认问题。',
    },
  })
  await h.api(`/tasks/${task.id}/agreement/confirm`, { draftVersion: agreement.draftVersion })
  const publishedEvidenceId =
    item.evidence && (await makePublishedFixture(h, executor, task.id, item.evidence.body))
  const work = await h.api<{ workKey: string }>(`/tasks/${task.id}/works`, { goal: item.goal })
  await h.api(`/works/${work.workKey}/mandates`, {
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    maxTokens: QUALITY_MAX_INPUT + QUALITY_MAX_OUTPUT,
    maxAttempts: 1,
    autoDispatch: 'off',
    allowedActionClasses: ['research', 'analysis', 'draft', 'revise'],
  })
  return { taskId: task.id, workKey: work.workKey, publishedEvidenceId }
}

async function rowsForTask(taskId: string) {
  const runs = await h.database.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.taskId, taskId))
  return runs.length
}

let stopping = false
async function cleanup() {
  if (stopping) return
  stopping = true
  await h.stop()
}
process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143))
})

let phase = 'prepare'
interface QualityDiagnostics {
  admission?: { outcome: string; reason: string | null; routerInvoked: boolean }
  enqueue?: { resolved: boolean; reason: string | null; evaluationId: string | null }
  evaluation?: {
    status: string
    reason: string | null
    modelStarted: boolean
    inputEstimate: number | null
    reserved: boolean
  }
}
let diagnostics: QualityDiagnostics = {}
const stableCode = (value: string | null): string | null =>
  value === null ? null : /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : 'unclassified'
async function writeTrace(): Promise<void> {
  const evaluationIds = new Set(report.cases.map((item) => item.evaluationId))
  const trace = h.events.flatMap((event) => {
    if (typeof event.evaluationId !== 'string' || !evaluationIds.has(event.evaluationId)) return []
    const component = String(event.component)
    if (
      !['hub.router', 'hub.dispatch', 'node.coordination', 'runtime.bridge.coordination'].includes(
        component,
      )
    )
      return []
    const action = event.action ?? event.event ?? event.msg
    if (typeof action !== 'string' || !/^[a-z][a-z0-9._]{1,80}$/.test(action)) return []
    return [
      {
        component,
        action,
        evaluationId: event.evaluationId,
        ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
      },
    ]
  })
  await writeFile(
    join(output, 'events.jsonl'),
    trace.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    { mode: 0o600 },
  )
}
try {
  await mkdir(output, { recursive: true, mode: 0o700 })
  if (!prepareOnly && split === 'development') {
    // A development iteration may replace unfrozen development evidence only.
    await Promise.all(
      ['result.json', 'partial.json', 'failure.json', 'score.json', 'events.jsonl'].map((name) =>
        rm(join(output, name), { force: true }),
      ),
    )
  }
  await h.start()
  const probe = await execute(process.execPath, [h.runtimeEntry, '--coordination-probe'])
  assert.equal(JSON.parse(probe.stdout).supported, true, 'OS Router isolation unavailable')
  if (key) {
    await h.cli([
      'coordination',
      'configure',
      '--state-dir',
      h.stateDir,
      '--owner-user-id',
      h.owner.userId,
      '--billing-user-id',
      h.owner.userId,
      '--provider',
      QUALITY_PROVIDER,
      '--model',
      QUALITY_MODEL,
      '--slot',
      QUALITY_SLOT,
      '--endpoint',
      QUALITY_ENDPOINT,
    ])
    await h.cli(
      ['coordination', 'secret', 'set', QUALITY_PROVIDER, QUALITY_SLOT, '--state-dir', h.stateDir],
      `${key}\n`,
    )
  }
  const fixtureExecutor = await configureFixtureExecutor(h)
  if (key) await h.waitCoordinationInventory()
  const project = await h.api<{ id: string }>('/projects', { name: `Router quality ${split}` })
  // Produce all synthetic antecedents before configuring the real provider. No setup traffic can call it.
  const prepared = []
  for (const scenario of cases) {
    phase = `fixture:${scenario.id}`
    prepared.push({ scenario, ...(await prepareCase(project.id, scenario, fixtureExecutor)) })
  }
  if (prepareOnly) {
    process.stdout.write(
      `Router quality fixture setup: ${prepared.length}/${cases.length}; zero real provider requests.\n`,
    )
  } else {
    phase = 'provider_configuration'
    assert.equal(
      await fingerprintProductionAssembly(repoRoot),
      assemblyDigest,
      'assembly changed before real provider execution',
    )
    const local = JSON.parse(await readFile(join(h.stateDir, 'coordination.json'), 'utf8')) as {
      configRevision: string
    }
    await h.api(`/projects/${project.id}/router/config`, {
      enabled: true,
      deviceId: h.deviceId,
      operatorUserId: h.owner.userId,
      billingUserId: h.owner.userId,
      credentialSlot: QUALITY_SLOT,
      credentialConfigRevision: local.configRevision,
      provider: QUALITY_PROVIDER,
      model: QUALITY_MODEL,
      teamDailyCallLimit: cases.length,
      projectDailyCallLimit: cases.length,
      teamDailyTokenLimit: cases.length * (QUALITY_MAX_INPUT + QUALITY_MAX_OUTPUT),
      projectDailyTokenLimit: cases.length * (QUALITY_MAX_INPUT + QUALITY_MAX_OUTPUT),
      teamDailyCostMicrosLimit: QUALITY_MAX_SPLIT_COST_MICROS,
      projectDailyCostMicrosLimit: QUALITY_MAX_SPLIT_COST_MICROS,
      ...configuration,
    })
    for (const item of prepared) {
      const { scenario, workKey, taskId } = item
      phase = `evaluation:${scenario.id}`
      diagnostics = {}
      const runsBefore = await rowsForTask(taskId)
      const taskCount = () =>
        h.database.db.$count(schema.tasks, eq(schema.tasks.projectId, project.id))
      const tasksBefore = await taskCount()
      const start = performance.now()
      // Ordinary discussion, no labels or scenario markers sent to Router.
      const trigger = await h.api<{ id: string }>(`/tasks/${taskId}/comments`, {
        body: scenario.message,
      })
      const [admission] = await h.database.db
        .select({
          outcome: schema.workEntryAdmissions.outcome,
          reason: schema.workEntryAdmissions.reason,
          routerInvoked: schema.workEntryAdmissions.routerInvoked,
          routerCallId: schema.workEntryAdmissions.routerCallId,
        })
        .from(schema.workEntryAdmissions)
        .where(
          and(
            eq(schema.workEntryAdmissions.workKey, workKey),
            eq(schema.workEntryAdmissions.sourceId, trigger.id),
          ),
        )
      if (admission)
        diagnostics.admission = {
          outcome: admission.outcome,
          reason: stableCode(admission.reason),
          routerInvoked: admission.routerInvoked,
        }
      assert(
        admission?.outcome === 'route_router' && admission.routerInvoked && admission.routerCallId,
        'source did not enter Router slow path',
      )
      const routerCallId = admission.routerCallId
      const { row, ledger, application } = await until(
        phase,
        async () => {
          const [call] = await h.database.db
            .select({
              resolvedAt: schema.workEntryRouterCalls.resolvedAt,
              reason: schema.workEntryRouterCalls.resolutionReason,
              evaluationId: schema.workEntryRouterCalls.evaluationId,
            })
            .from(schema.workEntryRouterCalls)
            .where(eq(schema.workEntryRouterCalls.id, routerCallId))
          assert(call, 'Router slow-path call record is missing')
          diagnostics.enqueue = {
            resolved: call.resolvedAt !== null,
            reason: stableCode(call.reason),
            evaluationId: call.evaluationId,
          }
          if (!call.evaluationId) {
            if (call.resolvedAt !== null)
              throw new Error(`Router enqueue refused: ${diagnostics.enqueue.reason ?? 'unknown'}`)
            return undefined
          }
          const [row] = await h.database.db
            .select()
            .from(schema.coordinationEvaluations)
            .where(
              and(
                eq(schema.coordinationEvaluations.workKey, workKey),
                eq(schema.coordinationEvaluations.purpose, 'router'),
                eq(schema.coordinationEvaluations.id, call.evaluationId),
              ),
            )
          assert(row, 'Router enqueue points at a missing evaluation')
          diagnostics.evaluation = {
            status: row.status,
            reason: stableCode(row.failureCode),
            modelStarted: row.modelStartedAt !== null,
            inputEstimate: row.inputTokensEstimate,
            reserved: row.reservedTokens !== null,
          }
          if (!terminal.some((s) => s === row.status)) return undefined
          if (row.reservedTokens === null)
            throw new Error(
              `Router ended before dispatch: ${diagnostics.evaluation.reason ?? row.status}`,
            )
          const ledger = await h.database.db
            .select()
            .from(schema.coordinationUsageLedger)
            .where(eq(schema.coordinationUsageLedger.evaluationId, row.id))
          if (!ledger.some((entry) => entry.phase === 'settled')) return undefined
          const [application] = await h.database.db
            .select()
            .from(schema.routerApplications)
            .where(eq(schema.routerApplications.evaluationId, row.id))
          if (row.status === 'completed' && !application) return undefined
          return { row, ledger, application }
        },
        85_000,
      )
      assert(
        row.evaluationDigest && row.routerContext?.sourceId === trigger.id,
        'router result binding missing',
      )
      const settled = ledger.find((item) => item.phase === 'settled')!
      const mode = settled.chargeMode
      assert(mode, 'settlement lacks charge mode')
      const proposal = row.routerProposal
      assert(
        !proposal || !JSON.stringify(proposal).includes(key!),
        'provider response unexpectedly contains credential material',
      )
      const result: QualityCaseResult = {
        caseId: scenario.id,
        taskId,
        workKey,
        triggerSourceId: trigger.id,
        ...(item.publishedEvidenceId ? { publishedEvidenceId: item.publishedEvidenceId } : {}),
        evaluationId: row.id,
        evaluationDigest: row.evaluationDigest,
        rulesVersion: row.rulesVersion,
        promptVersion: row.processorVersion,
        modelStarted: row.modelStartedAt !== null,
        attempt: row.attempt,
        durationMs: Math.round(performance.now() - start),
        status: row.status as QualityCaseResult['status'],
        failureCode: row.failureCode,
        manifest: CoordinationInputEntrySchema.array().parse(row.inputManifest.entries),
        readEntryIds: row.readEntryIds,
        usage: row.usage,
        settlement: {
          reserved: ledger.filter((entry) => entry.phase === 'reserved').length,
          settled: ledger.filter((entry) => entry.phase === 'settled').length,
          mode,
          costMicros:
            mode === 'actual'
              ? (settled.usage?.costMicros ?? -1)
              : mode === 'reserved'
                ? settled.reservedCostMicros
                : 0,
        },
        proposal,
        applicationStatus: application?.status ?? null,
        applicationRunId: application?.runId ?? null,
        businessRunsAfterTrigger: (await rowsForTask(taskId)) - runsBefore,
        newTasksAfterTrigger: (await taskCount()) - tasksBefore,
      }
      report.cases.push(result)
      await writeFile(join(output, 'partial.json'), `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
      })
      await writeTrace()
      process.stdout.write(
        `${scenario.id}: ${result.status}${result.failureCode ? ` (${result.failureCode})` : ''}\n`,
      )
      if (result.failureCode === 'provider_request_failed')
        throw new Error('provider rejected or unavailable; no further requests')
    }
    phase = 'score'
    assert.equal(
      await fingerprintProductionAssembly(repoRoot),
      assemblyDigest,
      'assembly changed during real provider execution',
    )
    report.completedAt = new Date().toISOString()
    const score = verifyRouterQuality(report, freeze, witness)
    await writeFile(join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    if (split === 'development') await rm(join(output, 'partial.json'), { force: true })
    process.stdout.write(
      `${split}: ${score.matches}/${score.total} matched; factuality review pending.\n`,
    )
    if (score.status === 'fail') process.exitCode = 2
  }
} catch (error) {
  const detail = h.redact(error instanceof Error ? error.message : 'unknown failure')
  if (!prepareOnly)
    await writeFile(
      join(output, 'failure.json'),
      `${JSON.stringify({ phase, detail, diagnostics })}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      },
    )
  process.stderr.write(`${phase}: ${detail}\n`)
  process.exitCode = 2
} finally {
  await cleanup()
}
