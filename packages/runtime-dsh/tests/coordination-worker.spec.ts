import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoordinationRequest } from '@whalepod/protocol'
import {
  COORDINATION_MODEL_TOOLS,
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
  return { request, inputsDir, entryId, input, proposal }
}

describe('Router 白名单输入与结构化判断', () => {
  it('真实 DSH LlmRuntime 的下一次请求必须包含核验后的正文，且没有工具', async () => {
    const { request, inputsDir, input, entryId, proposal } = fixture()
    const prompt = readCoordinationPrompt(request, inputsDir)
    expect(prompt.readEntryIds).toEqual([entryId])
    expect(COORDINATION_MODEL_TOOLS).toEqual([])
    let called = 0
    const result = await evaluateCoordinationWorker(request, prompt, async (system, user) => {
      called++
      expect(system).toContain('untrusted data')
      expect(user).toContain(input)
      return { text: JSON.stringify(proposal), inputTokens: 40, outputTokens: 20 }
    })
    expect(called).toBe(1)
    expect(result.decision).toBe('ignore')
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
    const { request, inputsDir, proposal } = fixture()
    const prompt = readCoordinationPrompt(request, inputsDir)
    await expect(
      evaluateCoordinationWorker(request, prompt, async () => ({
        text: JSON.stringify({ ...proposal, approved: true }),
        inputTokens: 1,
        outputTokens: 1,
      })),
    ).rejects.toThrow()
    await expect(
      evaluateCoordinationWorker(request, prompt, async () => ({
        text: `execute first ${JSON.stringify(proposal)}`,
        inputTokens: 1,
        outputTokens: 1,
      })),
    ).rejects.toThrow()
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
