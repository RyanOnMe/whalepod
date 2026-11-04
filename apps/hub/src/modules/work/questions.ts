import {
  cancelDispatchIntentById,
  getLatestWorkMandate,
  getWorkQuestionByDecision,
  getWorkQuestionForUpdate,
  insertWorkQuestion,
  insertWorkQuestionAnswer,
  markWorkQuestionAnswered,
  transactCommandWithOrigin,
  type Database,
  type DispatchIntentRow,
  type TaskRow,
  type Tx,
  type WorkMandateRow,
  type WorkQuestionRow,
  type WorkRow,
} from '@whalepod/db'
import {
  WorkQuestionAnswerViewSchema,
  WorkQuestionViewSchema,
  type WorkQuestionAnswerRequest,
  type WorkQuestionAnswerView,
  type WorkQuestionView,
} from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { lockWorkContext } from './context.js'

// ADR-0028 §8（RD-03d2a）：ask 的确定性生成、问题读面映射与可绑定回答。
// 本模块只写协调表（work_question/work_question_answer），不创建 Run、不扩大 Mandate。

export interface QuestionDeps {
  readonly database: Database
  readonly now: () => Date
}

const NO_CANDIDATE_QUESTION_TYPE = 'choose_option' as const
const NO_CANDIDATE_BLOCKED_DECISION = 'dispatch'
const NO_CANDIDATE_OPTIONS = [
  { id: 'retry', label: '稍后重试' },
  { id: 'cancel', label: '取消本次派工' },
] as const

/**
 * `decisionId = sha256(canonicalJson({workKey, blockedDecision, inputDigest,
 * mandateVersion, questionType}))`（ADR-0028 §8）。同输入重复问题得到同一 id。
 */
export function noCandidateDecisionId(input: {
  readonly workKey: string
  readonly inputDigest: string
  readonly mandateVersion: number
}): string {
  return sha256Hex(
    canonicalJson({
      workKey: input.workKey,
      blockedDecision: NO_CANDIDATE_BLOCKED_DECISION,
      inputDigest: input.inputDigest,
      mandateVersion: input.mandateVersion,
      questionType: NO_CANDIDATE_QUESTION_TYPE,
    }),
  )
}

/**
 * RD-03b 的自动派工在无合格候选时调用：生成（或复用）一个 open 问题。
 * 只由确定性路径触发，不冒充模型 Router；问题正文只含候选级摘要，不含来源正文。
 */
export async function openNoCandidateQuestion(
  tx: Tx,
  input: {
    readonly work: WorkRow
    readonly task: TaskRow
    readonly mandate: WorkMandateRow
    readonly intent: DispatchIntentRow
    readonly exclusionReasons: readonly unknown[]
    readonly now: Date
  },
): Promise<WorkQuestionRow> {
  const decisionId = noCandidateDecisionId({
    workKey: input.work.workKey,
    inputDigest: input.intent.inputDigest,
    mandateVersion: input.mandate.version,
  })
  const existing = await getWorkQuestionByDecision(tx, decisionId)
  if (existing !== undefined) return existing

  const refs = {
    detail: 'no_candidate',
    exclusionCount: input.exclusionReasons.length,
    exclusionReasons: input.exclusionReasons.slice(0, 4),
    triggerRefs: input.intent.triggerRefs.slice(0, 4),
  }
  const inserted = await insertWorkQuestion(tx, {
    id: uuidv7(input.now.getTime()),
    workId: input.work.id,
    taskId: input.work.taskId,
    projectId: input.work.projectId,
    decisionId,
    questionType: NO_CANDIDATE_QUESTION_TYPE,
    blockedDecision: NO_CANDIDATE_BLOCKED_DECISION,
    summary: `自动派工没有合格候选（${input.exclusionReasons.length} 项排除原因），请选择重试或取消本次派工。`,
    options: NO_CANDIDATE_OPTIONS.map((option) => ({ ...option })),
    recommendedOptionId: 'retry',
    refs,
    inputDigest: input.intent.inputDigest,
    mandateId: input.mandate.id,
    mandateVersion: input.mandate.version,
    principalUserId: input.task.assigneeUserId,
    dispatchIntentId: input.intent.id,
    status: 'open',
    answeredAt: null,
    closedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  })
  if (inserted !== undefined) return inserted
  // 并发重复准入：ON CONFLICT DO NOTHING 后回读既有决定，事务不会因唯一冲突 abort。
  const raced = await getWorkQuestionByDecision(tx, decisionId)
  if (raced !== undefined) return raced
  throw new Error('work question insert lost without row')
}

export function toWorkQuestionView(row: WorkQuestionRow, workKey: string): WorkQuestionView {
  return WorkQuestionViewSchema.parse({
    id: row.id,
    workKey,
    decisionId: row.decisionId,
    questionType: row.questionType,
    blockedDecision: row.blockedDecision,
    summary: row.summary,
    options: row.options,
    recommendedOptionId: row.recommendedOptionId ?? null,
    refs: row.refs,
    inputDigest: row.inputDigest,
    mandateId: row.mandateId,
    mandateVersion: row.mandateVersion,
    principalUserId: row.principalUserId,
    dispatchIntentId: row.dispatchIntentId ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  })
}

interface StaleAnswer {
  readonly stale: true
  readonly answerId: string
  readonly questionId: string
  readonly reason: 'mandate_changed' | 'mandate_inactive' | 'work_inactive'
}

interface BoundAnswer {
  readonly stale: false
  readonly view: WorkQuestionAnswerView
}

type AnswerOutcome = StaleAnswer | BoundAnswer

function validateAnswer(question: WorkQuestionRow, input: WorkQuestionAnswerRequest): void {
  if (input.answerType === 'authorize_scope') {
    throw new ApiError(400, 'UNSUPPORTED_ANSWER', 'authorize_scope is not enabled in this slice')
  }
  if (input.answerType === 'choose_option') {
    if (input.optionId === undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'optionId is required for choose_option')
    }
    if (!question.options.some((option) => option.id === input.optionId)) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'optionId is not one of the question options')
    }
    return
  }
  if (input.optionId !== undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'optionId is only valid for choose_option')
  }
}

function staleReason(
  work: WorkRow,
  question: WorkQuestionRow,
  latest: WorkMandateRow | undefined,
  now: Date,
  actorUserId: string,
): StaleAnswer['reason'] | undefined {
  if (work.state !== 'active') return 'work_inactive'
  if (
    latest === undefined ||
    latest.status !== 'active' ||
    latest.expiresAt.getTime() <= now.getTime()
  ) {
    return 'mandate_inactive'
  }
  if (latest.principalUserId !== actorUserId) return 'mandate_changed'
  if (latest.id !== question.mandateId || latest.version !== question.mandateVersion) {
    return 'mandate_changed'
  }
  return undefined
}

/**
 * 回答绑定谓词（ADR-0028 §8）：主体、decisionId、回答类型、Mandate 版本全部满足才绑定；
 * 否则只写 binding=false 的 answer，问题保持 open。事务内返回结果，由调用方在事务外抛
 * 409（这样 non-binding 记录不会被回滚）。
 */
export async function answerWorkQuestion(
  deps: QuestionDeps,
  actorUserId: string,
  workKey: string,
  decisionId: string,
  input: WorkQuestionAnswerRequest,
  idempotencyKey: string,
): Promise<WorkQuestionAnswerView> {
  const outcome = await transactCommandWithOrigin(
    deps.database,
    `work.question.answer:${workKey}:${decisionId}:${actorUserId}:${sha256Hex(canonicalJson(input))}:${idempotencyKey}`,
    async (tx): Promise<AnswerOutcome> => {
      const { work, task } = await lockWorkContext(tx, workKey)
      if (task.assigneeUserId !== actorUserId) {
        throw new ApiError(403, 'FORBIDDEN', 'only the task assignee can answer this question')
      }
      if (task.assignmentStatus !== 'accepted') {
        throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
      }
      const question = await getWorkQuestionForUpdate(tx, work.id, decisionId)
      if (question === undefined) throw new ApiError(404, 'NOT_FOUND', 'question not found')
      if (question.principalUserId !== actorUserId) {
        throw new ApiError(403, 'FORBIDDEN', 'question is addressed to another member')
      }
      if (question.status !== 'open') {
        throw new ApiError(409, 'CONFLICT', 'question is no longer open')
      }
      validateAnswer(question, input)
      const now = deps.now()
      const latest = await getLatestWorkMandate(tx, work.id)
      const reason = staleReason(work, question, latest, now, actorUserId)
      if (reason !== undefined) {
        const answer = await insertWorkQuestionAnswer(tx, {
          id: uuidv7(now.getTime()),
          questionId: question.id,
          decisionId: question.decisionId,
          actorUserId,
          answerType: input.answerType,
          optionId: input.optionId ?? null,
          reason: input.reason ?? null,
          mandateId: question.mandateId,
          mandateVersion: question.mandateVersion,
          binding: false,
          rejectionReason: reason,
          createdAt: now,
        })
        return { stale: true, answerId: answer.id, questionId: question.id, reason }
      }
      const answered = await markWorkQuestionAnswered(tx, question.id, now)
      if (answered === undefined) {
        throw new ApiError(409, 'CONFLICT', 'question was answered concurrently')
      }
      const answer = await insertWorkQuestionAnswer(tx, {
        id: uuidv7(now.getTime()),
        questionId: question.id,
        decisionId: question.decisionId,
        actorUserId,
        answerType: input.answerType,
        optionId: input.optionId ?? null,
        reason: input.reason ?? null,
        mandateId: question.mandateId,
        mandateVersion: question.mandateVersion,
        binding: true,
        rejectionReason: null,
        createdAt: now,
      })
      const cancels =
        input.answerType === 'deny' ||
        (input.answerType === 'choose_option' &&
          (input.optionId === 'cancel' || input.optionId === 'retry'))
      const cancelled =
        question.dispatchIntentId === null || !cancels
          ? undefined
          : await cancelDispatchIntentById(
              tx,
              question.dispatchIntentId,
              `decision_${input.answerType}${input.optionId === undefined ? '' : `:${input.optionId}`}`,
              now,
            )
      return {
        stale: false,
        view: WorkQuestionAnswerViewSchema.parse({
          question: toWorkQuestionView(answered, work.workKey),
          answer: {
            id: answer.id,
            decisionId: question.decisionId,
            answerType: input.answerType,
            optionId: input.optionId ?? null,
            binding: true,
            rejectionReason: null,
            createdAt: now.toISOString(),
          },
          reevaluate: input.answerType === 'choose_option' && input.optionId === 'retry',
          deferred: input.answerType === 'defer',
          intentCancelled: cancelled !== undefined,
        }),
      }
    },
  )

  const result = outcome.value
  if (result.stale) {
    throw new ApiError(409, 'DECISION_STALE', 'decision no longer binds to the current mandate', {
      decisionId,
      questionId: result.questionId,
      answerId: result.answerId,
      reason: result.reason,
    })
  }
  return result.view
}
