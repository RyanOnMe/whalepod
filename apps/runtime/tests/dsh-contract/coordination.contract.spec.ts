/** True packaged bin, OS-isolated worker, actual HTTP provider boundary; deterministic responses. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RouterRuntimeOutputSchema,
  type CoordinationRequest,
  type RouterRuntimeOutput,
} from '@whalepod/protocol'

const require = createRequire(import.meta.url)
const BIN = require.resolve('@whalepod/runtime/bin')
const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: { expiresAt?: string; waitDeadlineSeconds?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whalepod-router-contract-'))
  dirs.push(dir)
  const entryId = randomUUID()
  const workId = randomUUID()
  const body = 'CONFIRMED_ROUTER_CONTEXT_519: wheelchair access is required.'
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60_000).toISOString()
  const workBody = JSON.stringify({
    mandate: { expiresAt, waitDeadlineSeconds: options.waitDeadlineSeconds ?? 900 },
  })
  writeFileSync(join(dir, `${entryId}.bin`), body)
  writeFileSync(join(dir, `${workId}.bin`), workBody)
  const request: CoordinationRequest = {
    evaluationId: randomUUID(),
    attempt: 1,
    leaseToken: 'a'.repeat(64),
    evaluationDigest: 'b'.repeat(64),
    projectId: randomUUID(),
    workKey: randomUUID(),
    taskId: randomUUID(),
    principalUserId: randomUUID(),
    billingUserId: randomUUID(),
    provider: 'fixture',
    model: 'fixture-model',
    credentialSlot: 'coordination',
    credentialConfigRevision: 'v1',
    configVersion: 1,
    manifest: [
      {
        id: entryId,
        kind: 'source',
        sourceId: randomUUID(),
        version: '1',
        digest: createHash('sha256').update(body).digest('hex'),
        byteSize: Buffer.byteLength(body),
        authorizationGeneration: 'member',
      },
      {
        id: workId,
        kind: 'work',
        sourceId: randomUUID(),
        version: '1',
        digest: createHash('sha256').update(workBody).digest('hex'),
        byteSize: Buffer.byteLength(workBody),
        authorizationGeneration: 'mandate:1',
      },
    ],
    inputTokensEstimate: 20_000,
    maxInputTokens: 32_000,
    maxOutputTokens: 1024,
    maxCostMicros: 1000,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const common = {
    summary: 'Review latest requirements.',
    citations: ['S1'],
    coverage: [{ source: 'S1', status: 'irrelevant', evidence: [] }],
  }
  return { dir, entryId, workId, request, body, workBody, expiresAt, common }
}

function addEntry(f: ReturnType<typeof fixture>, kind: 'source' | 'evidence', body: string) {
  const id = randomUUID()
  writeFileSync(join(f.dir, `${id}.bin`), body)
  f.request.manifest.push({
    id,
    kind,
    sourceId: randomUUID(),
    version: '1',
    digest: createHash('sha256').update(body).digest('hex'),
    byteSize: Buffer.byteLength(body),
    authorizationGeneration: 'member',
  })
  return id
}

async function provider(response: unknown, options: { redirect?: string } = {}) {
  let calls = 0
  let requestBody: Record<string, unknown> | undefined
  const server = createServer(async (req, res) => {
    calls++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (options.redirect !== undefined) {
      res.writeHead(307, { Location: options.redirect })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify(response))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no address')
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    calls: () => calls,
    request: () => requestBody,
  }
}
function response(proposal: unknown) {
  return {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }],
    usage: { prompt_tokens: 120, completion_tokens: 40 },
  }
}

async function run(
  request: CoordinationRequest,
  dir: string,
  endpoint: string,
  acknowledge = true,
  options: { cancelOnStart?: boolean; apiKey?: string } = {},
) {
  const child = spawn(process.execPath, [BIN, '--coordination'], {
    env: {
      PATH: process.env.PATH,
      WHALEPOD_COORDINATION_API_KEY: options.apiKey ?? 'fixture-private-key',
      WHALEPOD_DEVICE_TOKEN: 'must-not-reach-worker',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: RouterRuntimeOutput[] = []
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  child.stdin.on('error', () => {})
  const completed = new Promise<{
    code: number | null
    frames: RouterRuntimeOutput[]
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      buffer += chunk.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const frame = RouterRuntimeOutputSchema.parse(JSON.parse(line))
          frames.push(frame)
          if (
            options.cancelOnStart &&
            frame.type === 'coordination.heartbeat' &&
            frame.payload.modelStartedAt !== undefined
          ) {
            child.stdin.write(
              `${JSON.stringify({ type: 'coordination.cancel', payload: { evaluationId: request.evaluationId, attempt: request.attempt, leaseToken: request.leaseToken, reason: 'owner_cancelled' } })}\n`,
            )
            continue
          }
          if (
            acknowledge &&
            frame.type === 'coordination.heartbeat' &&
            frame.payload.modelStartedAt !== undefined
          ) {
            child.stdin.write(
              `${JSON.stringify({ type: 'coordination.model_start_ack', payload: { evaluationId: request.evaluationId, attempt: request.attempt, leaseToken: request.leaseToken } })}\n`,
            )
          }
        } catch (error) {
          child.kill('SIGKILL')
          reject(error)
        }
      }
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, frames, stdout, stderr }))
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  child.stdin.write(
    `${JSON.stringify({ type: 'coordination.initialize', request, inputsDir: dir, homePath: dir, endpoint })}\n`,
  )
  try {
    return await completed
  } finally {
    clearTimeout(timer)
    child.stdin.end()
    child.kill('SIGKILL')
  }
}

describe('Router 真实 bin 受限评估', () => {
  it('实际 bin 的 OS 网络探针必须得到内核拒绝，不能用没有工具代替', async () => {
    const f = fixture()
    const p = await provider(response({ ...f.common, decision: 'ignore', reason: 'no_action' }))
    // Positive control: this endpoint is reachable outside the worker sandbox.
    expect((await fetch(p.endpoint, { method: 'POST', body: '{}' })).ok).toBe(true)
    const child = spawn(process.execPath, [BIN, '--coordination-probe'], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual({ supported: true })
    expect(p.calls()).toBe(1)
  })

  it.each(['dispatch', 'wait', 'ask', 'ignore'] as const)(
    '%s 提案通过真实 DSH 服务与隔离worker，正文确实进入 provider 请求',
    async (decision) => {
      const f = fixture()
      const extra =
        decision === 'dispatch'
          ? { actionClass: 'draft' }
          : decision === 'wait'
            ? { reason: 'upstream_pending' }
            : decision === 'ask'
              ? {
                  questionType: 'choose_option',
                  blockedDecision: 'scope_choice',
                  options: [{ id: 'retry', label: 'Retry' }],
                  recommendedOptionId: 'retry',
                }
              : { reason: 'no_action' }
      const status =
        decision === 'dispatch' ? 'uncovered' : decision === 'ignore' ? 'irrelevant' : 'unknown'
      const p = await provider(
        response({
          ...f.common,
          decision,
          coverage: [{ source: 'S1', status, evidence: [] }],
          ...extra,
        }),
      )
      const outcome = await run(f.request, f.dir, p.endpoint)
      expect(outcome.code).toBe(0)
      const result = outcome.frames.find((frame) => frame.type === 'coordination.result')
      expect(result?.payload.status, outcome.stderr + outcome.stdout).toBe('completed')
      if (result?.payload.status === 'completed') {
        if ('purpose' in result.payload)
          throw new Error('legacy Router returned a discovery result')
        expect(result.payload.proposal.decision).toBe(decision)
        expect(result.payload.proposal.citations).toEqual([f.entryId])
        expect(result.payload.proposal.coverage).toEqual([
          {
            inputId: f.entryId,
            status: status === 'irrelevant' ? 'uncovered' : status,
            evidenceIds: [],
          },
        ])
        if (result.payload.proposal.decision === 'dispatch') {
          expect(result.payload.proposal.workKey).toBe(f.request.workKey)
        }
        if (result.payload.proposal.decision === 'wait') {
          expect(result.payload.proposal.deadlineAt).toBe(f.expiresAt)
        }
        expect(result.payload.usage?.inputTokens).toBe(120)
        expect(result.payload.readEntryIds).toEqual([f.entryId, f.workId])
      }
      expect(p.calls()).toBe(1)
      const messages = p.request()?.['messages'] as { role: string; content: string }[]
      expect(JSON.parse(messages.find((entry) => entry.role === 'user')!.content)).toEqual({
        entries: [
          { id: 'S1', kind: 'source', body: f.body },
          { id: 'W1', kind: 'work', body: f.workBody },
        ],
      })
      expect(p.request()?.['tools']).toBeUndefined()
      expect(outcome.stdout).not.toContain('fixture-private-key')
      expect(outcome.stdout).not.toContain(f.body)
      expect(outcome.stdout).not.toContain('must-not-reach-worker')
      expect(outcome.frames.filter((frame) => frame.type === 'coordination.heartbeat').length).toBe(
        2,
      )
    },
  )

  it('maps per-kind aliases back to exact source and evidence identities', async () => {
    const f = fixture()
    const oldAt = '2026-10-01T00:00:00.000Z'
    const currentAt = '2026-10-02T00:00:00.000Z'
    const oldEvidenceId = addEntry(f, 'evidence', 'Published outcome: stairs at venue entrance.')
    const evidenceId = addEntry(f, 'evidence', 'Published outcome: venue has step-free access.')
    const supplementId = addEntry(f, 'source', 'New requirement: provide accessible shuttles.')
    f.request.manifest.find((entry) => entry.id === f.entryId)!.version = currentAt
    f.request.manifest.find((entry) => entry.id === oldEvidenceId)!.authorizationGeneration =
      `published:${oldAt}`
    f.request.manifest.find((entry) => entry.id === evidenceId)!.authorizationGeneration =
      `published:${currentAt}`
    const p = await provider(
      response({
        ...f.common,
        decision: 'dispatch',
        actionClass: 'draft',
        citations: [],
        coverage: [
          { source: 'S1', status: 'covered', evidence: ['E2'] },
          { source: 'S2', status: 'uncovered', evidence: [] },
        ],
      }),
    )
    const outcome = await run(f.request, f.dir, p.endpoint)
    expect(outcome.code).toBe(0)
    expect(
      outcome.frames.find((frame) => frame.type === 'coordination.result')?.payload,
    ).toMatchObject({
      status: 'completed',
      readEntryIds: [f.entryId, f.workId, oldEvidenceId, evidenceId, supplementId],
      proposal: {
        decision: 'dispatch',
        workKey: f.request.workKey,
        citations: [f.entryId, supplementId, evidenceId],
        coverage: [
          { inputId: f.entryId, status: 'covered', evidenceIds: [evidenceId] },
          { inputId: supplementId, status: 'uncovered', evidenceIds: [] },
        ],
      },
    })
    expect(p.calls()).toBe(1)
    const messages = p.request()?.['messages'] as { role: string; content: string }[]
    expect(JSON.parse(messages.find((entry) => entry.role === 'user')!.content).entries).toEqual([
      { id: 'S1', kind: 'source', body: f.body, revisedAt: currentAt },
      { id: 'W1', kind: 'work', body: f.workBody },
      {
        id: 'E1',
        kind: 'evidence',
        body: 'Published outcome: stairs at venue entrance.',
        publishedAt: oldAt,
      },
      {
        id: 'E2',
        kind: 'evidence',
        body: 'Published outcome: venue has step-free access.',
        publishedAt: currentAt,
      },
      { id: 'S2', kind: 'source', body: 'New requirement: provide accessible shuttles.' },
    ])
  })

  it.each(['dispatch', 'ignore'] as const)(
    'blocks %s when the same evaluation has an actionable and an irrelevant source',
    async (decision) => {
      const f = fixture()
      addEntry(f, 'source', 'Small talk unrelated to the confirmed access requirement.')
      const p = await provider(
        response({
          ...f.common,
          decision,
          ...(decision === 'dispatch' ? { actionClass: 'draft' } : { reason: 'no_action' }),
          coverage: [
            { source: 'S1', status: 'uncovered', evidence: [] },
            { source: 'S2', status: 'irrelevant', evidence: [] },
          ],
        }),
      )
      const outcome = await run(f.request, f.dir, p.endpoint)
      expect(
        outcome.frames.find((frame) => frame.type === 'coordination.result')?.payload,
      ).toMatchObject({ status: 'failed', failureCode: 'invalid_coverage' })
      expect(p.calls()).toBe(1)
    },
  )

  it('缺少Node启动回执时，provider调用为零且按期限收口', async () => {
    const f = fixture()
    const p = await provider(response({ ...f.common, decision: 'ignore', reason: 'no_action' }))
    const outcome = await run(
      { ...f.request, deadlineAt: new Date(Date.now() + 1000).toISOString() },
      f.dir,
      p.endpoint,
      false,
    )
    const result = outcome.frames.find((frame) => frame.type === 'coordination.result')
    expect(result?.payload.status).toBe('failed')
    expect(p.calls()).toBe(0)
  })

  it('provider重定向不能把模型请求或凭据送往另一端点', async () => {
    const f = fixture()
    const other = await provider(response({ ...f.common, decision: 'ignore', reason: 'no_action' }))
    const p = await provider({}, { redirect: other.endpoint })
    const outcome = await run(f.request, f.dir, p.endpoint)
    expect(
      outcome.frames.find((frame) => frame.type === 'coordination.result')?.payload.status,
    ).toBe('failed')
    expect(p.calls()).toBe(1)
    expect(other.calls()).toBe(0)
  })

  // ADR-0026 §4: enumerate actual model-facing names, including independent escalation
  // surfaces. There is no agent/plugin/tool registry in this assembly, on any platform.
  it.each([
    'bash',
    'pwsh',
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'workflow',
    'str_replace_editor',
    'web_search',
    'web_fetch',
    'job_output',
    'job_list',
    'job_kill',
    'skill',
    'subagent',
    'subagent_fork',
    'send_message',
    'interrupt_agent',
    'list_agents',
    'report',
    'todo_write',
    'goal',
    'update_goal',
    'ralph',
    'exit_plan_mode',
    'run_code',
    'ask_user_question',
    'publish_artifact',
    'approve',
  ])('模型提出 %s 不会触发审批或副作用', async (toolName) => {
    const f = fixture()
    const before = readdirSync(f.dir).sort()
    const p = await provider({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify({
                    command: 'touch forbidden',
                    path: 'forbidden',
                    content: 'forbidden',
                    code: 'require("node:fs").writeFileSync("forbidden","forbidden")',
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    })
    const outcome = await run(f.request, f.dir, p.endpoint)
    const result = outcome.frames.find((frame) => frame.type === 'coordination.result')
    expect(result?.payload.status).toBe('failed')
    if (result?.payload.status === 'failed')
      expect(result.payload.failureCode).toBe('unsupported_tool_call')
    expect(result?.payload.usage).toMatchObject({ inputTokens: 120, outputTokens: 40 })
    expect(outcome.stdout).not.toContain('approval')
    expect(readdirSync(f.dir).sort()).toEqual(before)
    expect(p.request()?.['tools']).toBeUndefined()
    expect(p.calls()).toBe(1)
  })

  it.each([
    'usage_missing',
    'over_budget',
    'invalid_citation',
    'invalid_coverage',
    'invalid_model_result',
  ] as const)('%s 不会成为成功提案，已经发生的调用仍保留可用 usage', async (code) => {
    const f = fixture()
    let proposal: unknown = { ...f.common, decision: 'ignore', reason: 'no_action' }
    if (code === 'invalid_citation')
      proposal = { ...f.common, decision: 'ignore', reason: 'no_action', citations: ['S99'] }
    if (code === 'invalid_coverage')
      proposal = {
        ...f.common,
        decision: 'dispatch',
        actionClass: 'draft',
        coverage: [{ source: 'S1', status: 'unknown', evidence: [] }],
      }
    if (code === 'invalid_model_result')
      proposal = { ...f.common, decision: 'ignore', reason: 'no_action', approved: true }
    const reply = response(proposal)
    const wire = code === 'usage_missing' ? { choices: reply.choices } : reply
    const p = await provider(wire)
    const request = code === 'over_budget' ? { ...f.request, maxOutputTokens: 1 } : f.request
    const outcome = await run(request, f.dir, p.endpoint)
    const result = outcome.frames.find((frame) => frame.type === 'coordination.result')
    expect(result?.payload.status, outcome.stderr + outcome.stdout).toBe('failed')
    if (result?.payload.status === 'failed') expect(result.payload.failureCode).toBe(code)
    expect(p.calls()).toBe(1)
    if (code !== 'usage_missing')
      expect(result?.payload.usage).toMatchObject({ inputTokens: 120, outputTokens: 40 })
  })

  it.each([
    ['UUID citation', 'invalid_citation'],
    ['duplicate citation', 'invalid_citation'],
    ['non-evidence alias', 'invalid_citation'],
    ['duplicate evidence alias', 'invalid_citation'],
    ['non-source alias', 'invalid_coverage'],
    ['duplicate source alias', 'invalid_coverage'],
    ['missing source alias', 'invalid_coverage'],
    ['empty coverage', 'invalid_coverage'],
    ['covered without evidence', 'invalid_coverage'],
    ['uncovered with evidence', 'invalid_coverage'],
    ['model-provided work key', 'invalid_model_result'],
    ['model-provided deadline', 'invalid_model_result'],
  ] as const)('rejects %s at the provider result boundary', async (kind, failureCode) => {
    const f = fixture()
    addEntry(f, 'evidence', 'Published outcome: venue has step-free access.')
    const base = { ...f.common, decision: 'ignore', reason: 'no_action' }
    let proposal: unknown
    switch (kind) {
      case 'UUID citation':
        proposal = { ...base, citations: [f.entryId] }
        break
      case 'duplicate citation':
        proposal = { ...base, citations: ['S1', 'S1'] }
        break
      case 'non-evidence alias':
      case 'duplicate evidence alias':
        proposal = {
          ...base,
          coverage: [
            {
              source: 'S1',
              status: 'covered',
              evidence: kind === 'non-evidence alias' ? ['W1'] : ['E1', 'E1'],
            },
          ],
        }
        break
      case 'non-source alias':
        proposal = { ...base, coverage: [{ source: 'E1', status: 'uncovered', evidence: [] }] }
        break
      case 'duplicate source alias':
        addEntry(f, 'source', 'A supplemental source also requires a distinct judgment.')
        proposal = { ...base, coverage: [f.common.coverage[0], f.common.coverage[0]] }
        break
      case 'missing source alias':
        addEntry(f, 'source', 'A supplemental source also requires a distinct judgment.')
        proposal = base
        break
      case 'empty coverage':
        proposal = { ...base, coverage: [] }
        break
      case 'covered without evidence':
        proposal = { ...base, coverage: [{ source: 'S1', status: 'covered', evidence: [] }] }
        break
      case 'uncovered with evidence':
        proposal = { ...base, coverage: [{ source: 'S1', status: 'uncovered', evidence: ['E1'] }] }
        break
      case 'model-provided work key':
        proposal = {
          ...f.common,
          decision: 'dispatch',
          actionClass: 'draft',
          workKey: f.request.workKey,
        }
        break
      case 'model-provided deadline':
        proposal = { ...base, decision: 'wait', deadlineAt: f.expiresAt }
        break
    }
    const p = await provider(response(proposal))
    const outcome = await run(f.request, f.dir, p.endpoint)
    expect(
      outcome.frames.find((frame) => frame.type === 'coordination.result')?.payload,
    ).toMatchObject({
      status: 'failed',
      failureCode,
      usage: { inputTokens: 120, outputTokens: 40 },
    })
    expect(p.calls()).toBe(1)
  })

  it.each(['digest', 'missing', 'symlink', 'too_large', 'credential'] as const)(
    '%s 负控在调用 provider 前失败',
    async (kind) => {
      const f = fixture()
      const p = await provider(response({ ...f.common, decision: 'ignore', reason: 'no_action' }))
      if (kind === 'digest') writeFileSync(join(f.dir, `${f.entryId}.bin`), 'changed')
      if (kind === 'missing') rmSync(join(f.dir, `${f.entryId}.bin`))
      if (kind === 'symlink') {
        const name = join(f.dir, `${f.entryId}.bin`)
        rmSync(name)
        writeFileSync(join(f.dir, 'other.bin'), f.body)
        symlinkSync(join(f.dir, 'other.bin'), name)
      }
      const outcome = await run(
        kind === 'too_large' ? { ...f.request, maxInputTokens: 1 } : f.request,
        f.dir,
        p.endpoint,
        true,
        kind === 'credential' ? { apiKey: '' } : {},
      )
      const result = outcome.frames.find((frame) => frame.type === 'coordination.result')
      expect(result?.payload.status, outcome.stderr + outcome.stdout).toBe('failed')
      if (result?.payload.status === 'failed')
        expect(result.payload.failureCode).toBe(
          kind === 'too_large'
            ? 'input_too_large'
            : kind === 'credential'
              ? 'credential_unavailable'
              : 'input_digest_mismatch',
        )
      expect(p.calls()).toBe(0)
      expect(
        outcome.frames.some(
          (frame) =>
            frame.type === 'coordination.heartbeat' && frame.payload.modelStartedAt !== undefined,
        ),
      ).toBe(false)
    },
  )

  it('Node 在启动确认前取消，provider 不调用且终态不成功', async () => {
    const f = fixture()
    const p = await provider(response({ ...f.common, decision: 'ignore', reason: 'no_action' }))
    const outcome = await run(f.request, f.dir, p.endpoint, false, { cancelOnStart: true })
    const result = outcome.frames.find((frame) => frame.type === 'coordination.result')
    expect(result?.payload.status).toBe('failed')
    if (result?.payload.status === 'failed') expect(result.payload.failureCode).toBe('cancelled')
    expect(p.calls()).toBe(0)
  })
})
