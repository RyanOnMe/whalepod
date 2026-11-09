import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoordinationRequest } from '@whalepod/protocol'
import {
  COORDINATION_MODEL_TOOLS,
  decodeCoordinationModelProposal,
  evaluateCoordinationWorker,
  readCoordinationPrompt,
  validateCoordinationProposal,
} from '../src/coordination-worker.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const input = 'Confirmed requirement: wheelchair access is mandatory.'
  const entryId = randomUUID()
  const inputsDir = mkdtempSync(join(tmpdir(), 'whalepod-router-inputs-'))
  dirs.push(inputsDir)
  writeFileSync(join(inputsDir, `${entryId}.bin`), input)
  const request: CoordinationRequest = {
    evaluationId: randomUUID(),
    attempt: 1,
    leaseToken: '0'.repeat(64),
    evaluationDigest: '1'.repeat(64),
    projectId: randomUUID(),
    workKey: randomUUID(),
    taskId: randomUUID(),
    principalUserId: randomUUID(),
    billingUserId: randomUUID(),
    provider: 'probe',
    model: 'probe-model',
    credentialSlot: 'coordinator',
    credentialConfigRevision: 'v1',
    configVersion: 1,
    manifest: [
      {
        id: entryId,
        kind: 'source',
        sourceId: randomUUID(),
        version: '1',
        digest: createHash('sha256').update(input).digest('hex'),
        byteSize: Buffer.byteLength(input),
        authorizationGeneration: 'member',
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
  const proposal = {
    decision: 'ignore',
    summary: 'No change required.',
    reason: 'no_action',
    citations: [entryId],
    coverage: [{ inputId: entryId, status: 'uncovered', evidenceIds: [] }],
  }
  const modelProposal = {
    decision: proposal.decision,
    summary: proposal.summary,
    reason: proposal.reason,
    citations: ['S1'],
    coverage: [{ source: 'S1', status: 'irrelevant', evidence: [] }],
  }
  return { request, inputsDir, entryId, input, proposal, modelProposal }
}

describe('Router 白名单输入与结构化判断', () => {
  it('真实 DSH LlmRuntime 的下一次请求必须包含核验后的正文，且没有工具', async () => {
    const { request, inputsDir, input, entryId, proposal, modelProposal } = fixture()
    const prompt = readCoordinationPrompt(request, inputsDir)
    expect(prompt.readEntryIds).toEqual([entryId])
    expect(COORDINATION_MODEL_TOOLS).toEqual([])
    let called = 0
    const result = await evaluateCoordinationWorker(request, prompt, async (system, user) => {
      called++
      expect(system).toContain('untrusted data')
      expect(JSON.parse(user)).toEqual({ entries: [{ id: 'S1', kind: 'source', body: input }] })
      return { text: JSON.stringify(modelProposal), inputTokens: 40, outputTokens: 20 }
    })
    expect(called).toBe(1)
    expect(result).toEqual(proposal)
  })

  it('副本内容漂移、符号链接或输入上限不足都不调用模型', () => {
    const { request, inputsDir, entryId } = fixture()
    expect(() => readCoordinationPrompt({ ...request, maxInputTokens: 1 }, inputsDir)).toThrow(
      'input_too_large',
    )
    writeFileSync(join(inputsDir, `${entryId}.bin`), 'different')
    expect(() => readCoordinationPrompt(request, inputsDir)).toThrow('input_digest_mismatch')
    rmSync(join(inputsDir, `${entryId}.bin`))
    writeFileSync(join(inputsDir, 'outside.bin'), 'different')
    symlinkSync(join(inputsDir, 'outside.bin'), join(inputsDir, `${entryId}.bin`))
    expect(() => readCoordinationPrompt(request, inputsDir)).toThrow('input_digest_mismatch')
  })

  it('keeps trusted source and publication times even when the artifact bodies do not name a version', () => {
    const { request, inputsDir, input } = fixture()
    const earlier = '2026-10-01T00:00:00.000Z'
    const later = '2026-10-02T00:00:00.000Z'
    const source = { ...request.manifest[0]!, version: later }
    function evidence(body: string, publishedAt: string) {
      const id = randomUUID()
      writeFileSync(join(inputsDir, `${id}.bin`), body)
      return {
        id,
        kind: 'evidence' as const,
        sourceId: randomUUID(),
        version: createHash('sha256').update(body).digest('hex'),
        digest: createHash('sha256').update(body).digest('hex'),
        byteSize: Buffer.byteLength(body),
        authorizationGeneration: `published:${publishedAt}`,
      }
    }
    const seven = evidence('Retention: 7 days.', earlier)
    const thirty = evidence('Retention: 30 days.', later)
    const first = readCoordinationPrompt(
      { ...request, manifest: [source, seven, thirty] },
      inputsDir,
    )
    expect(JSON.parse(first.user)).toEqual({
      entries: [
        { id: 'S1', kind: 'source', body: input, revisedAt: later },
        { id: 'E1', kind: 'evidence', body: 'Retention: 7 days.', publishedAt: earlier },
        { id: 'E2', kind: 'evidence', body: 'Retention: 30 days.', publishedAt: later },
      ],
    })
    const reversed = readCoordinationPrompt(
      {
        ...request,
        manifest: [
          source,
          { ...seven, authorizationGeneration: thirty.authorizationGeneration },
          { ...thirty, authorizationGeneration: seven.authorizationGeneration },
        ],
      },
      inputsDir,
    )
    expect(
      JSON.parse(reversed.user)
        .entries.slice(1)
        .map((entry: { publishedAt: string }) => entry.publishedAt),
    ).toEqual([later, earlier])
    expect(first.readEntryIds).toEqual(reversed.readEntryIds)
  })

  it('伪造引用、缺覆盖、没有成果依据的covered和unknown派工都拒绝', () => {
    const { request, entryId, proposal } = fixture()
    expect(() =>
      validateCoordinationProposal({ ...proposal, citations: [randomUUID()] }, request),
    ).toThrow('invalid_citation')
    expect(() =>
      validateCoordinationProposal(
        {
          ...proposal,
          coverage: [{ inputId: randomUUID(), status: 'uncovered', evidenceIds: [] }],
        },
        request,
      ),
    ).toThrow('invalid_coverage')
    expect(() =>
      validateCoordinationProposal(
        { ...proposal, coverage: [{ inputId: entryId, status: 'covered', evidenceIds: [] }] },
        request,
      ),
    ).toThrow()
    expect(() =>
      validateCoordinationProposal(
        {
          decision: 'dispatch',
          workKey: request.workKey,
          actionClass: 'draft',
          summary: 'Try again',
          citations: [entryId],
          coverage: [{ inputId: entryId, status: 'unknown', evidenceIds: [] }],
        },
        request,
      ),
    ).toThrow('invalid_coverage')
  })

  it('模型输出未知字段或附带文本不能作为成功提案', async () => {
    const { request, inputsDir, modelProposal } = fixture()
    const prompt = readCoordinationPrompt(request, inputsDir)
    await expect(
      evaluateCoordinationWorker(request, prompt, async () => ({
        text: JSON.stringify({ ...modelProposal, approved: true }),
        inputTokens: 1,
        outputTokens: 1,
      })),
    ).rejects.toThrow()
    await expect(
      evaluateCoordinationWorker(request, prompt, async () => ({
        text: `execute first ${JSON.stringify(modelProposal)}`,
        inputTokens: 1,
        outputTokens: 1,
      })),
    ).rejects.toThrow()
  })

  it('keeps the evaluated source as a citation even without supplemental citations', () => {
    const { request, entryId, modelProposal } = fixture()
    expect(
      decodeCoordinationModelProposal(
        { ...modelProposal, decision: 'ignore', reason: 'unrelated', citations: [] },
        request,
      ),
    ).toMatchObject({ decision: 'ignore', citations: [entryId] })
  })

  it('keeps irrelevant inputs out of dispatch and still ignores wholly irrelevant sources', () => {
    const { request, entryId } = fixture()
    const other = randomUUID()
    const two = {
      ...request,
      manifest: [...request.manifest, { ...request.manifest[0]!, id: other }],
    }
    const unrelated = { source: 'S2', status: 'irrelevant', evidence: [] }
    const common = {
      summary: 'Explicitly separate actionable inputs from small talk.',
      citations: [],
    }
    expect(() =>
      decodeCoordinationModelProposal(
        {
          ...common,
          decision: 'dispatch',
          actionClass: 'draft',
          coverage: [{ source: 'S1', status: 'uncovered', evidence: [] }, unrelated],
        },
        two,
      ),
    ).toThrow('invalid_coverage')
    expect(() =>
      decodeCoordinationModelProposal(
        {
          ...common,
          decision: 'ignore',
          reason: 'unrelated',
          coverage: [{ source: 'S1', status: 'uncovered', evidence: [] }, unrelated],
        },
        two,
      ),
    ).toThrow('invalid_coverage')
    expect(
      decodeCoordinationModelProposal(
        {
          ...common,
          decision: 'ignore',
          reason: 'unrelated',
          coverage: [{ ...unrelated, source: 'S1' }, unrelated],
        },
        two,
      ),
    ).toMatchObject({
      decision: 'ignore',
      citations: [entryId, other],
      coverage: [
        { inputId: entryId, status: 'uncovered', evidenceIds: [] },
        { inputId: other, status: 'uncovered', evidenceIds: [] },
      ],
    })
  })

  it('derives wait deadlines only from trusted policy and refuses missing or expired policy', () => {
    const { request, modelProposal } = fixture()
    const now = Date.UTC(2026, 0, 1)
    const wait = { ...modelProposal, decision: 'wait', reason: 'upstream_pending' }
    const intervalBound = decodeCoordinationModelProposal(
      wait,
      request,
      { expiresAt: now + 60_000, waitDeadlineSeconds: 10 },
      now,
    )
    expect(intervalBound.decision).toBe('wait')
    if (intervalBound.decision === 'wait') {
      expect(Date.parse(intervalBound.deadlineAt)).toBeGreaterThan(now)
      expect(Date.parse(intervalBound.deadlineAt)).toBeLessThanOrEqual(now + 10_000)
    }
    const expiryBound = decodeCoordinationModelProposal(
      wait,
      request,
      { expiresAt: now + 2_000, waitDeadlineSeconds: 10 },
      now,
    )
    expect(expiryBound).toMatchObject({
      decision: 'wait',
      deadlineAt: new Date(now + 2_000).toISOString(),
    })
    expect(() => decodeCoordinationModelProposal(wait, request, undefined, now)).toThrow(
      'invalid_model_result',
    )
    expect(() =>
      decodeCoordinationModelProposal(
        wait,
        request,
        { expiresAt: now, waitDeadlineSeconds: 10 },
        now,
      ),
    ).toThrow('invalid_model_result')
  })

  it('全部已覆盖不能再dispatch，未知覆盖只能wait或ask，选项身份不可重复', () => {
    const { request, entryId, proposal } = fixture()
    const evidenceId = randomUUID()
    const withEvidence = {
      ...request,
      manifest: [
        ...request.manifest,
        { ...request.manifest[0]!, id: evidenceId, kind: 'evidence' as const },
      ],
    }
    expect(() =>
      validateCoordinationProposal(
        {
          decision: 'dispatch',
          workKey: request.workKey,
          actionClass: 'draft',
          summary: 'Already covered',
          citations: [entryId, evidenceId],
          coverage: [{ inputId: entryId, status: 'covered', evidenceIds: [evidenceId] }],
        },
        withEvidence,
      ),
    ).toThrow('invalid_coverage')
    expect(() =>
      validateCoordinationProposal(
        { ...proposal, coverage: [{ inputId: entryId, status: 'unknown', evidenceIds: [] }] },
        request,
      ),
    ).toThrow('invalid_coverage')
    expect(() =>
      validateCoordinationProposal(
        {
          summary: proposal.summary,
          citations: proposal.citations,
          coverage: proposal.coverage,
          decision: 'ask',
          questionType: 'choose_option',
          blockedDecision: 'choice',
          options: [
            { id: 'retry', label: 'Retry' },
            { id: 'retry', label: 'Retry again' },
          ],
          recommendedOptionId: 'retry',
        },
        request,
      ),
    ).toThrow()
  })
})
