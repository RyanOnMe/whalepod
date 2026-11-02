import type { ContextEntryRow, CoordinationEvaluationRow, Tx } from '@whalepod/db'
import {
  findCompletedEvaluationForInput,
  getCoordinatorStateForUpdate,
  getEvaluation,
  getEvaluationForUpdate,
  insertContextCitation,
  insertContextEntry,
  maxAttemptForInput,
  updateCoordinatorState,
  updateEvaluation,
} from '@whalepod/db'
import { uuidv7 } from '../shared/uuid.js'
import { clipContextBody, clipContextText } from '../context/projector.js'
import { sha256Hex, canonicalJson } from './digest.js'
import { loadCoordinationInput, type CoordinationInput } from './input.js'
import { COORDINATION_PROCESSOR_VERSION, COORDINATION_RULES_VERSION } from './rules.js'

const CITATION_LIMIT = 16
const OPEN_QUESTION_LIMIT = 20
const QUESTION_TEXT_MAX = 500
/** context_entry.payload 的 DB 上限是 16KiB；留出 JSON 结构余量，绝不踩线。 */
const PAYLOAD_BUDGET_BYTES = 12_000

export interface CoordinationSuggestion {
  readonly text: string
  readonly entryId: string
  readonly businessRef: string
  readonly businessVersion: string
}

export interface EvaluationOutcome {
  readonly evaluation: CoordinationEvaluationRow
  readonly inference?: ContextEntryRow
  readonly action: 'completed' | 'skipped'
  readonly reason?: string
}

/** 从约定正文的「待确认：」行提取开放问题；空串/「无」不算问题。 */
function extractOpenQuestions(entry: ContextEntryRow): string[] {
  if (entry.kind !== 'decision') return []
  const lines = entry.body.split('\n')
  const questions: string[] = []
  for (const line of lines) {
    const match = /^待确认：\s*(.*)$/.exec(line)
    if (match === null) continue
    const text = (match[1] ?? '').trim()
    if (text === '' || text === '无' || text === '暂无') continue
    questions.push(text)
  }
  return questions
}

function buildSuggestions(input: CoordinationInput): {
  readonly suggestions: CoordinationSuggestion[]
  readonly citations: ContextEntryRow[]
} {
  const suggestions: CoordinationSuggestion[] = []
  const citations: ContextEntryRow[] = []
  for (const entry of input.selected) {
    if (
      entry.businessRef === null ||
      entry.businessVersion === null ||
      entry.kind === 'correction'
    ) {
      continue
    }
    if (citations.length < CITATION_LIMIT) citations.push(entry)
    for (const text of extractOpenQuestions(entry)) {
      if (suggestions.length >= OPEN_QUESTION_LIMIT) break
      suggestions.push({
        text: clipContextText(text, QUESTION_TEXT_MAX),
        entryId: entry.id,
        businessRef: entry.businessRef,
        businessVersion: entry.businessVersion,
      })
    }
    if (suggestions.length >= OPEN_QUESTION_LIMIT) break
  }
  return { suggestions, citations }
}

function buildResult(input: CoordinationInput): {
  readonly title: string
  readonly body: string
  readonly payload: Record<string, unknown>
  readonly citations: ContextEntryRow[]
} {
  const summary = { decision: 0, observation: 0, inference: 0, correction: 0 }
  for (const entry of input.selected) summary[entry.kind] += 1
  const { suggestions, citations } = buildSuggestions(input)
  const basePayload = {
    summary,
    omittedCount: input.omittedCount,
    truncated: input.truncated,
    rulesVersion: COORDINATION_RULES_VERSION,
    processorVersion: COORDINATION_PROCESSOR_VERSION,
    inputEntryIds: input.manifestEntries.map((entry) => entry.id),
  }
  // 开放问题按字节预算逐个纳入：协议允许长文本，DB payload 只允许 16KiB，
  // 不能把合法输入变成一条永久失败的评估。
  const included: CoordinationSuggestion[] = []
  for (const question of suggestions) {
    const draft = {
      ...basePayload,
      openQuestions: [...included, question],
      openQuestionsOmitted: suggestions.length - included.length - 1,
    }
    if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > PAYLOAD_BUDGET_BYTES) break
    included.push(question)
  }
  let payload: Record<string, unknown> = {
    ...basePayload,
    openQuestions: included,
    openQuestionsOmitted: suggestions.length - included.length,
  }
  while (
    included.length > 0 &&
    Buffer.byteLength(JSON.stringify(payload), 'utf8') > PAYLOAD_BUDGET_BYTES
  ) {
    included.pop()
    payload = {
      ...basePayload,
      openQuestions: included,
      openQuestionsOmitted: suggestions.length - included.length,
    }
  }
  const title = '项目状态摘要'
  const bodyLines = [
    `当前有效事实：Decision ${summary.decision} 条、Observation ${summary.observation} 条、` +
      `Inference ${summary.inference} 条、Correction ${summary.correction} 条。`,
    ...(input.truncated ? [`本次输入省略 ${input.omittedCount} 条（超出上限）。`] : []),
    ...(included.length > 0
      ? ['开放问题：', ...included.map((question) => `- ${question.text}`)]
      : [
          Number(payload.openQuestionsOmitted ?? 0) > 0
            ? '开放问题：本次因输出上限未列出。'
            : '开放问题：无。',
        ]),
    ...(payload.openQuestionsOmitted !== undefined && Number(payload.openQuestionsOmitted) > 0
      ? [`另有 ${String(payload.openQuestionsOmitted)} 个开放问题因输出上限未列出。`]
      : []),
  ]
  return {
    title,
    body: clipContextBody(bodyLines.join('\n')),
    payload,
    citations,
  }
}

/**
 * 对一个 queued 评估做确定性求值并写 Inference。
 *
 * 调用方负责事务边界与提交后的观测日志；本函数不写 Decision/Correction、
 * 不碰 Task/Run，也不在失败时留下部分结果（整事务回滚）。
 */
export async function evaluateQueuedEvaluation(
  tx: Tx,
  evaluationId: string,
  now: Date = new Date(),
): Promise<EvaluationOutcome | undefined> {
  // 锁顺序固定：coordinator state → evaluation（enqueue 同序，避免并发死锁）。
  const snapshot = await getEvaluation(tx, evaluationId)
  if (snapshot === undefined) return undefined
  const state = await getCoordinatorStateForUpdate(tx, snapshot.projectId)
  let evaluation = await getEvaluationForUpdate(tx, evaluationId)
  if (evaluation === undefined || evaluation.status !== 'queued') return undefined
  if (state === undefined || !state.enabled || state.pausedAt !== null) {
    const paused = state !== undefined && state.pausedAt !== null
    const skipped = await updateEvaluation(tx, evaluation.id, {
      status: 'skipped',
      failureCode: paused ? 'coordinator_paused' : 'coordinator_disabled',
      failureSummary: paused
        ? 'project coordination is paused'
        : 'project coordination is disabled',
      finishedAt: now,
    })
    return skipped === undefined
      ? undefined
      : {
          evaluation: skipped,
          action: 'skipped',
          reason: paused ? 'coordinator_paused' : 'coordinator_disabled',
        }
  }

  const input = await loadCoordinationInput(tx, evaluation.projectId)
  const completed = await findCompletedEvaluationForInput(
    tx,
    evaluation.projectId,
    input.inputDigest,
  )
  if (completed !== undefined && completed.id !== evaluation.id) {
    const skipped = await updateEvaluation(tx, evaluation.id, {
      status: 'skipped',
      failureCode: 'already_completed',
      failureSummary: 'same input already has a completed evaluation',
      finishedAt: now,
    })
    return skipped === undefined
      ? undefined
      : { evaluation: skipped, action: 'skipped', reason: 'already_completed' }
  }
  if (input.inputDigest !== evaluation.inputDigest) {
    // 入队后输入又前进：按 ADR-0026 §3 的合并规则改写 queued 行（attempt 取该
    // 输入历史最大值 +1，版本列同步前进），后续 Inference 用同一个新 digest。
    const attempt = (await maxAttemptForInput(tx, evaluation.projectId, input.inputDigest)) + 1
    const merged = await updateEvaluation(tx, evaluation.id, {
      inputDigest: input.inputDigest,
      inputManifest: input.manifest,
      manifestVersion: evaluation.manifestVersion + 1,
      coalescedAt: now,
      attempt,
      rulesVersion: COORDINATION_RULES_VERSION,
      processorVersion: COORDINATION_PROCESSOR_VERSION,
    })
    if (merged === undefined) return undefined
    evaluation = merged
  }

  const result = buildResult(input)
  if (result.citations.length === 0) {
    // Inference 必须有引用（ADR-0025 §1）；没有可引用业务坐标时不产出结论。
    const skipped = await updateEvaluation(tx, evaluation.id, {
      status: 'skipped',
      failureCode: 'no_citable_input',
      failureSummary: 'no current entry carries business coordinates to cite',
      finishedAt: now,
    })
    return skipped === undefined
      ? undefined
      : { evaluation: skipped, action: 'skipped', reason: 'no_citable_input' }
  }

  const resultDigest = sha256Hex(
    canonicalJson({
      title: result.title,
      body: result.body,
      payload: result.payload,
      citations: result.citations.map((entry) => ({
        businessRef: entry.businessRef,
        businessVersion: entry.businessVersion,
      })),
    }),
  )
  const inference = await insertContextEntry(tx, {
    id: uuidv7(),
    projectId: evaluation.projectId,
    kind: 'inference',
    status: 'active',
    title: clipContextText(result.title, 200),
    body: result.body,
    payload: result.payload,
    evaluationId: evaluation.id,
    inputDigest: evaluation.inputDigest,
    actorKind: 'coordinator',
    processorVersion: COORDINATION_PROCESSOR_VERSION,
  })
  for (const entry of result.citations) {
    if (entry.businessRef === null || entry.businessVersion === null) continue
    await insertContextCitation(tx, {
      entryId: inference.id,
      kind: 'business',
      businessRef: entry.businessRef,
      businessVersion: entry.businessVersion,
      occurredAt: entry.createdAt,
    })
  }
  const completedRow = await updateEvaluation(tx, evaluation.id, {
    status: 'completed',
    finishedAt: now,
    startedAt: now,
    inputDigest: input.inputDigest,
    inputManifest: input.manifest,
    resultDigest,
    inferenceEntryId: inference.id,
  })
  if (completedRow === undefined) throw new Error('completed evaluation row vanished')
  await updateCoordinatorState(tx, evaluation.projectId, {
    lastSuccessfulEvaluationId: completedRow.id,
    updatedAt: now,
  })
  return { evaluation: completedRow, inference, action: 'completed' }
}
