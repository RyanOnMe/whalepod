#!/usr/bin/env tsx
/** #519: production HTTP/WS → Hub → Node CLI → isolated Runtime; only model HTTP is replayed. */
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDatabase, type Database } from '@whalepod/db'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@whalepod/db'
import { startEphemeralPostgres, type EphemeralPostgres } from './lib/ephemeral-postgres.mts'
import { resolveHubServerEntry } from './lib/phase1/hub-assembly.js'
import { redactText } from './lib/phase1/events.js'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'artifacts/evidence/router-evaluation')
const resultPath = join(output, 'result.json')
const privateRoot = await mkdtemp(join(tmpdir(), 'whalepod-router-'))
const configDir = join(privateRoot, 'node-config')
const stateDir = join(privateRoot, 'node-state')
const setupPath = join(privateRoot, 'setup-token')
const knownSecrets: string[] = []
const children: ChildProcess[] = []
const tails = new Map<ChildProcess, string>()
const held = new Map<string, { response: ServerResponse; body: unknown }>()
const providerCalls: Array<{ scenario: string; workKey: string; entryIds: string[] }> = []
const completed: Array<Record<string, unknown>> = []
const events: Array<Record<string, unknown>> = []
let postgres: EphemeralPostgres | undefined
let database: Database | undefined
let node: ChildProcess | undefined
let cookie = ''
let origin = ''
let stopped = false
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/chat/completions')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: unknown[]
      messages: Array<{ role: string; content: string }>
    }
    assert.equal(body.tools?.length ?? 0, 0)
    const prompt = JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as {
      workKey: string
      entries: Array<{ id: string; kind: string; body: string }>
    }
    const sources = prompt.entries.filter((entry) => entry.kind === 'source')
    const match = /ROUTER_CASE:([a-z_]+)/.exec(sources.map((entry) => entry.body).join('\n'))
    assert.ok(match, 'model request must contain the triggering source body')
    const scenario = match[1]!
    providerCalls.push({
      scenario,
      workKey: prompt.workKey,
      entryIds: prompt.entries.map((e) => e.id),
    })
    const decision = ['dispatch', 'wait', 'ask', 'ignore'].includes(scenario) ? scenario : 'ignore'
    const common = {
      summary: `Replay decision ${scenario}`,
      citations:
        scenario === 'missing_citation' ? [randomUUID()] : sources.map((entry) => entry.id),
      coverage: sources.map((entry) => ({
        inputId: entry.id,
        status: decision === 'dispatch' || decision === 'ignore' ? 'uncovered' : 'unknown',
        evidenceIds: [],
      })),
    }
    const proposal = {
      ...common,
      decision,
      ...(decision === 'dispatch' ? { workKey: prompt.workKey, actionClass: 'draft' } : {}),
      ...(decision === 'wait'
        ? { reason: 'upstream_pending', deadlineAt: new Date(Date.now() + 120_000).toISOString() }
        : {}),
      ...(decision === 'ask'
        ? {
            questionType: 'choose_option',
            blockedDecision: 'scope_conflict',
            options: [{ id: 'wait', label: 'Wait for clarification' }],
            recommendedOptionId: 'wait',
          }
        : {}),
      ...(decision === 'ignore' ? { reason: 'no_action_needed' } : {}),
    }
    const reply = {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(proposal) },
        },
      ],
      ...(scenario === 'missing_usage'
        ? {}
        : { usage: { prompt_tokens: 200, completion_tokens: 100 } }),
    }
    if (scenario === 'revoked' || scenario === 'restart') {
      held.set(scenario, { response, body: reply })
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
  } catch {
    response.writeHead(500).end('invalid replay request')
  }
})

function safe(text: string): string {
  let result = redactText(text)
  for (const secret of knownSecrets) result = result.replaceAll(secret, '[REDACTED]')
  return result
}
function launch(entry: string, args: string[], environment: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  tails.set(child, '')
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream?.on('data', (chunk: Buffer) => {
      tails.set(child, ((tails.get(child) ?? '') + chunk.toString()).slice(-80_000))
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>
          if (
            !['hub.router', 'node.coordination', 'runtime.bridge.coordination'].includes(
              String(value.component),
            )
          )
            continue
          events.push(
            Object.fromEntries(
              Object.entries({ ...value, action: value.action ?? value.msg }).filter(([key]) =>
                [
                  'component',
                  'action',
                  'evaluationId',
                  'workKey',
                  'attempt',
                  'status',
                  'reason',
                  'readCount',
                ].includes(key),
              ),
            ),
          )
        } catch {
          /* Only structured production facts are evidence. */
        }
      }
    })
  }
  return child
}
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000),
    ),
  ])
}
async function until<T>(
  label: string,
  action: () => Promise<T | undefined>,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await action()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timeout: ${label}`)
}
async function api<T = Record<string, any>>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(method === 'GET'
        ? {}
        : { 'idempotency-key': randomUUID(), 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]!
  const result = (await response.json()) as { ok: boolean; data: T; error?: unknown }
  assert.ok(
    response.ok && result.ok,
    `${method} ${path}: ${response.status} ${JSON.stringify(result.error)}`,
  )
  return result.data
}
async function cleanup() {
  if (stopped) return
  stopped = true
  for (const pending of held.values()) pending.response.destroy()
  await stop(node)
  for (const child of children.slice().reverse()) await stop(child)
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  await database?.close()
  await postgres?.stop()
  await rm(privateRoot, { recursive: true, force: true })
}
process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143))
})

try {
  await mkdir(output, { recursive: true })
  await rm(resultPath, { force: true })
  await rm(join(output, 'failure.log'), { force: true })
  await rm(join(output, 'events.jsonl'), { force: true })
  await execute(
    'pnpm',
    ['--filter', '@whalepod/hub...', '--filter', '@whalepod/node...', 'build'],
    { cwd: root, maxBuffer: 4_000_000 },
  )
  const nodeEntry = createRequire(new URL('../apps/node/package.json', import.meta.url)).resolve(
    '@whalepod/node/bin',
  )
  const hubEntry = resolveHubServerEntry(new URL('../apps/hub/package.json', import.meta.url))
  const runtimeEntry = createRequire(new URL('../apps/node/package.json', import.meta.url)).resolve(
    '@whalepod/runtime/bin',
  )
  const probe = await execute(process.execPath, [runtimeEntry, '--coordination-probe'], {
    cwd: root,
  })
  assert.equal(
    JSON.parse(probe.stdout).supported,
    true,
    'OS coordination isolation must be available',
  )
  postgres = await startEphemeralPostgres()
  database = createDatabase({ connectionString: postgres.databaseUrl })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', () => resolve()))
  const providerPort = (provider.address() as { port: number }).port
  // Allocate a loopback port without a fixed developer-machine port dependency.
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', () => resolve()))
  const port = (portServer.address() as { port: number }).port
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  origin = `http://127.0.0.1:${port}`
  launch(hubEntry, [], {
    DATABASE_URL: postgres.databaseUrl,
    WHALEPOD_PUBLIC_ORIGIN: origin,
    WHALEPOD_SETUP_TOKEN_PATH: setupPath,
    WHALEPOD_ARTIFACT_STORE_DIR: join(privateRoot, 'hub-artifacts'),
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'info',
  })
  await until('Hub ready', async () => {
    try {
      return (await fetch(`${origin}/api/v1/setup/status`)).ok ? true : undefined
    } catch {
      return undefined
    }
  })
  const setupToken = await readFile(setupPath, 'utf8')
  const password = randomBytes(24).toString('base64url')
  knownSecrets.push(setupToken.trim(), password)
  const owner = await api('/setup', {
    setupToken: setupToken.trim(),
    teamName: 'Router acceptance',
    username: 'router-owner',
    displayName: 'Router Owner',
    password,
  })
  const project = await api('/projects', { name: 'Router production chain' })
  const pairing = await api('/devices/pairing-codes', {})
  const cli = async (args: string[], input?: string) => {
    const child = launch(nodeEntry, args, {})
    if (input !== undefined) child.stdin!.end(input)
    else child.stdin!.end()
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    assert.equal(code, 0, `Node CLI failed: ${safe(tails.get(child) ?? '')}`)
  }
  await cli(['pair', '--hub', origin, '--code', pairing.code, '--config-dir', configDir])
  const identity = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as {
    deviceId: string
    deviceToken: string
  }
  knownSecrets.push(identity.deviceToken)
  const credential = randomBytes(24).toString('base64url')
  knownSecrets.push(credential)
  await cli([
    'coordination',
    'configure',
    '--state-dir',
    stateDir,
    '--owner-user-id',
    owner.userId,
    '--billing-user-id',
    owner.userId,
    '--provider',
    'replay',
    '--model',
    'router-replay',
    '--slot',
    'router-acceptance',
    '--endpoint',
    `http://127.0.0.1:${providerPort}/chat/completions`,
  ])
  await cli(
    ['coordination', 'secret', 'set', 'replay', 'router-acceptance', '--state-dir', stateDir],
    `${credential}\n`,
  )
  const localConfig = JSON.parse(await readFile(join(stateDir, 'coordination.json'), 'utf8')) as {
    configRevision: string
  }
  const startNode = () =>
    launch(nodeEntry, ['start', '--config-dir', configDir, '--state-dir', stateDir], {})
  node = startNode()
  await until('Node coordination inventory', async () => {
    const [device] = await database!.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, identity.deviceId))
    const capabilities = device?.capabilities as
      | { coordinationCapabilities?: string[]; coordinationCredentialSlots?: unknown[] }
      | undefined
    return capabilities?.coordinationCapabilities?.includes('coordination.v1') &&
      capabilities.coordinationCredentialSlots?.length
      ? true
      : undefined
  })
  await api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: identity.deviceId,
    operatorUserId: owner.userId,
    billingUserId: owner.userId,
    credentialSlot: 'router-acceptance',
    credentialConfigRevision: localConfig.configRevision,
    provider: 'replay',
    model: 'router-replay',
    teamDailyCallLimit: 100,
    projectDailyCallLimit: 100,
    teamDailyTokenLimit: 10_000_000,
    projectDailyTokenLimit: 10_000_000,
    teamDailyCostMicrosLimit: 1_000_000,
    projectDailyCostMicrosLimit: 1_000_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 1024,
    maxCostMicros: 10_000,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    timeoutSeconds: 30,
    maxRetries: 1,
  })
  const cases = new Map<string, { taskId: string; workKey: string; mandateId: string }>()
  for (const name of [
    'dispatch',
    'wait',
    'ask',
    'ignore',
    'missing_citation',
    'missing_usage',
    'fast',
    'revoked',
    'restart',
  ]) {
    const task = await api(`/projects/${project.id}/tasks`, {
      title: `Router ${name}`,
      assigneeUserId: owner.userId,
    })
    await api(`/tasks/${task.id}/accept`, {})
    const agreement = await api(`/tasks/${task.id}/agreement/draft`, {
      content: {
        goal: 'Produce a private event plan',
        constraints: 'Only authorized draft actions',
        acceptance: 'Traceable references',
        openQuestions: 'None',
      },
    })
    await api(`/tasks/${task.id}/agreement/confirm`, { draftVersion: agreement.draftVersion })
    const work = await api(`/tasks/${task.id}/works`, { goal: 'Maintain the event draft' })
    const mandate = await api(`/works/${work.workKey}/mandates`, {
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      maxTokens: 2_000_000,
      maxAttempts: 10,
    })
    cases.set(name, { taskId: task.id, workKey: work.workKey, mandateId: mandate.id })
  }
  const baselineTasks = await database.db.select({ id: schema.tasks.id }).from(schema.tasks)
  const trigger = async (name: string) => {
    const c = cases.get(name)!
    await api(`/tasks/${c.taskId}/comments`, {
      body: `ROUTER_CASE:${name} A confirmed accessibility requirement changed.`,
    })
    return until(`evaluation ${name}`, async () => {
      const evaluations = await api<Array<Record<string, any>>>(
        `/works/${c.workKey}/router/evaluations`,
      )
      const evaluation = evaluations[0]
      return evaluation ? evaluation : undefined
    })
  }
  const terminal = (name: string) =>
    until(
      `terminal ${name}`,
      async () => {
        const evaluations = await api<Array<Record<string, any>>>(
          `/works/${cases.get(name)!.workKey}/router/evaluations`,
        )
        const evaluation = evaluations[0]
        return evaluation &&
          ['completed', 'failed', 'cancelled', 'skipped', 'stale'].includes(evaluation.status)
          ? evaluation
          : undefined
      },
      40_000,
    )
  for (const name of ['dispatch', 'wait', 'ask', 'ignore', 'missing_citation', 'missing_usage']) {
    await trigger(name)
    const evaluation = await terminal(name)
    if (['dispatch', 'wait', 'ask', 'ignore'].includes(name)) {
      assert.equal(evaluation.status, 'completed', `${name}: ${evaluation.failureCode}`)
      assert.equal(evaluation.proposal.decision, name)
      assert.ok(evaluation.readEntryIds.length > 0)
      assert.equal(evaluation.usage.inputTokens, 200)
    } else {
      assert.notEqual(evaluation.status, 'completed')
      assert.equal(evaluation.proposal, null)
    }
    completed.push({
      scenario: name,
      evaluationId: evaluation.id,
      status: evaluation.status,
      decision: evaluation.proposal?.decision ?? null,
      failureCode: evaluation.failureCode,
      readCount: evaluation.readEntryIds.length,
      modelCalls: providerCalls.filter((c) => c.scenario === name).length,
    })
  }
  const fast = cases.get('fast')!
  await api(`/works/${fast.workKey}/subscriptions`, { targetType: 'task', targetRef: fast.taskId })
  await api(`/tasks/${fast.taskId}/comments`, {
    body: 'ROUTER_CASE:fast Preserve the existing subscribed work.',
  })
  await until('fast-path admitted', async () => {
    const admissions = await api<Array<Record<string, any>>>(
      `/works/${fast.workKey}/entry-admissions`,
    )
    return admissions.some((a) => a.outcome === 'deliver' && !a.routerInvoked) ? true : undefined
  })
  assert.equal(providerCalls.filter((c) => c.scenario === 'fast').length, 0)
  assert.equal((await api<any[]>(`/works/${fast.workKey}/router/evaluations`)).length, 0)
  completed.push({ scenario: 'fast', modelCalls: 0, delivered: true })
  await trigger('revoked')
  await until('revoked model started', async () => (held.has('revoked') ? true : undefined))
  await api(`/mandates/${cases.get('revoked')!.mandateId}/pause`, {
    reason: 'Acceptance revocation',
  })
  const pending = held.get('revoked')!
  pending.response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify(pending.body))
  const revoked = await terminal('revoked')
  assert.notEqual(revoked.status, 'completed')
  assert.equal(revoked.proposal, null)
  completed.push({
    scenario: 'revoked',
    evaluationId: revoked.id,
    status: revoked.status,
    failureCode: revoked.failureCode,
    modelCalls: providerCalls.filter((c) => c.scenario === 'revoked').length,
  })
  await trigger('restart')
  await until('restart model started', async () => (held.has('restart') ? true : undefined))
  await stop(node, 'SIGKILL')
  node = startNode()
  const recovered = await terminal('restart')
  assert.notEqual(recovered.status, 'completed')
  assert.equal(
    providerCalls.filter((c) => c.scenario === 'restart').length,
    1,
    'Node restart must not replay a potentially charged model call',
  )
  completed.push({
    scenario: 'restart',
    evaluationId: recovered.id,
    status: recovered.status,
    failureCode: recovered.failureCode,
    modelCalls: 1,
  })
  const ids = completed
    .map((c) => c.evaluationId)
    .filter((id): id is string => typeof id === 'string')
  await until('all usage settled', async () => {
    const ledger = await database!.db
      .select()
      .from(schema.coordinationUsageLedger)
      .where(inArray(schema.coordinationUsageLedger.evaluationId, ids))
    return ledger.filter((r) => r.phase === 'settled').length === ids.length ? true : undefined
  })
  await until('all private inputs cleaned', async () => {
    try {
      const directories = await readdir(join(stateDir, 'coordination-home'))
      for (const name of directories)
        if ((await readdir(join(stateDir, 'coordination-home', name))).length > 0) return undefined
      return true
    } catch {
      return undefined
    }
  })
  // Read-only independent evidence: all state above was produced through production HTTP/WS.
  const [runs, intents, questions, tasks, ledger, budgets, attempts] = await Promise.all([
    database.db.select({ id: schema.runs.id }).from(schema.runs),
    database.db.select({ id: schema.dispatchIntents.id }).from(schema.dispatchIntents),
    database.db.select({ id: schema.workQuestions.id }).from(schema.workQuestions),
    database.db.select({ id: schema.tasks.id }).from(schema.tasks),
    database.db.select().from(schema.coordinationUsageLedger),
    database.db.select().from(schema.coordinationBudgets),
    database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.purpose, 'router')),
  ])
  assert.equal(runs.length, 0)
  assert.equal(intents.length, 0)
  assert.equal(questions.length, 0)
  assert.equal(tasks.length, baselineTasks.length)
  assert.equal(attempts.length, ids.length)
  assert.ok(budgets.every((b) => b.reservedTokens === 0 && b.reservedCostMicros === 0))
  for (const id of ids) {
    const pair = ledger.filter((l) => l.evaluationId === id)
    assert.deepEqual(pair.map((p) => p.phase).sort(), ['reserved', 'settled'])
  }
  await writeFile(
    join(output, 'events.jsonl'),
    safe(events.map((event) => JSON.stringify(event)).join('\n') + '\n'),
  )
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        issue: 519,
        generatedAt: new Date().toISOString(),
        assembly: {
          hub: 'package-production-server',
          node: 'package-cli-bin',
          runtime: 'package-bin-isolated-worker',
          database: 'postgresql',
          model: 'loopback-http-replay',
        },
        scenarios: completed,
        sideEffects: {
          runs: runs.length,
          intents: intents.length,
          questions: questions.length,
          extraTasks: tasks.length - baselineTasks.length,
        },
        ledger: ledger.map((l) => ({
          evaluationId: l.evaluationId,
          phase: l.phase,
          chargeMode: l.chargeMode,
        })),
        reservationsRemaining: budgets.reduce(
          (n, b) => n + b.reservedTokens + b.reservedCostMicros,
          0,
        ),
        privateInputsCleaned: true,
        modelQuality: 'not_run',
      },
      null,
      2,
    ),
  )
  await execute('pnpm', ['exec', 'tsx', 'scripts/verify-router-evaluation.ts', resultPath], {
    cwd: root,
  })
  console.log('Router evaluation production acceptance PASS')
} catch (error) {
  await rm(resultPath, { force: true })
  await mkdir(output, { recursive: true })
  const logs = [...tails.values()].map(safe).join('\n')
  await writeFile(
    join(output, 'failure.log'),
    safe(`${error instanceof Error ? error.message : String(error)}\n${logs}`),
  )
  console.error(safe(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  await cleanup()
}
