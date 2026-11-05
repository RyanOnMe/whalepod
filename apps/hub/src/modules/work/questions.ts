import {
  cancelDispatchIntentById,
  findCommandReceipt,
  getLatestWorkMandate,
  getWorkQuestionByDecision,
  getWorkQuestionForUpdate,
  insertWorkMandateProposal,
  insertWorkQuestion,
  insertWorkQuestionAnswer,
  markWorkQuestionAnswered,
  transactCommandWithOrigin,
  type Database,
  type DispatchIntentRow,
  type TaskRow,
  type Tx,
  type WorkMandateProposalRow,
  type WorkMandateRow,
  type WorkQuestionRow,
  type WorkRow,
} from '@whalepod/db'
import {
  WorkMandateProposalViewSchema,
  WorkQuestionAnswerViewSchema,
  WorkQuestionViewSchema,
  type WorkMandateProposalView,
  type WorkQuestionAnswerRequest,
  type WorkQuestionAnswerView,
  type WorkQuestionView,
} from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { lockWorkContext, requireAssignee } from './context.js'
import { assertAllowedAgents, assertMandateScope } from './mandate-scope.js'

// ADR-0028 §8（RD-03d2a/d2b）：ask 的确定性生成、问题读面映射与可绑定回答。
// 本模块只写协调表（work_question/work_question_answer/work_mandate_proposal），
// 不创建 Run、不直接扩大 Mandate；authorize_scope 只生成待确认草案。

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

export function toWorkMandateProposalView(
  row: WorkMandateProposalRow,
  workKey: string,
): WorkMandateProposalView {
  return WorkMandateProposalViewSchema.parse({
    id: row.id,
    workKey,
    questionId: row.questionId,
    decisionId: row.decisionId,
    baseMandateId: row.baseMandateId,
    baseMandateVersion: row.baseMandateVersion,
    principalUserId: row.principalUserId,
    status: row.status,
    scope: row.scope,
    resultMandateId: row.resultMandateId ?? null,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
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

/** #517 前的回执是裸 WorkQuestionAnswerView；重放时归一化为当前的 AnswerOutcome。 */
function normalizeAnswerOutcome(raw: AnswerOutcome | WorkQuestionAnswerView): AnswerOutcome {
  if (typeof raw === 'object' && raw !== null && ('stale' in raw || 'view' in raw)) {
    return raw as AnswerOutcome
  }
  return { stale: false, view: raw as WorkQuestionAnswerView }
}

function validateAnswer(question: WorkQuestionRow, input: WorkQuestionAnswerRequest): void {
  if (question.questionType === 'authorize_scope') {
    if (input.answerType === 'authorize_scope') {
      // ADR-0028 §8：扩权问题不能降级成普通选项确认。
      if (input.scope === undefined) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'scope is required for authorize_scope')
      }
      if (input.optionId !== undefined) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'optionId is not valid for authorize_scope')
      }
      return
    }
    // 拒绝/暂缓扩权是合法回答；它们不生成草案，也不会扩大当前 Mandate。
    if (input.answerType === 'choose_option') {
      throw new ApiError(
        400,
        'UNSUPPORTED_ANSWER',
        'authorize_scope question cannot be answered with choose_option',
      )
    }
    if (input.scope !== undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'scope is only valid for authorize_scope')
    }
    if (input.optionId !== undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'optionId is not valid for authorize_scope')
    }
    return
  }
  if (input.answerType === 'authorize_scope') {
    throw new ApiError(400, 'UNSUPPORTED_ANSWER', 'answer type does not match the question')
  }
  if (input.scope !== undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'scope is only valid for authorize_scope')
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
  const commandKey = `work.question.answer:${workKey}:${decisionId}:${actorUserId}:${sha256Hex(canonicalJson(input))}:${idempotencyKey}`
  const outcome = await transactCommandWithOrigin(
    deps.database,
    commandKey,
    async (tx): Promise<AnswerOutcome> => {
      const { work, task } = await lockWorkContext(tx, workKey)
      // 与其它工作写命令共用“当前 assignee + 启用成员”校验。
      await requireAssignee(
        tx,
        task,
        actorUserId,
        'only the task assignee can answer this question',
      )
      if (task.assignmentStatus !== 'accepted') {
        throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
      }
      const question = await getWorkQuestionForUpdate(tx, work.id, decisionId)
      if (question === undefined) throw new ApiError(404, 'NOT_FOUND', 'question not found')
      if (question.principalUserId !== actorUserId) {
        throw new ApiError(403, 'FORBIDDEN', 'question is addressed to another member')
      }
      if (question.status !== 'open') {
        // 同 key 并发：胜者已提交回执；败者在拿到 Work 锁后回读并收敛为同一结果。
        const prior = await findCommandReceipt(tx, commandKey)
        if (prior !== undefined) {
          return { stale: false, view: prior.result as WorkQuestionAnswerView }
        }
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
      if (input.answerType === 'authorize_scope' && input.scope !== undefined) {
        if (question.questionType !== 'authorize_scope') {
          throw new ApiError(400, 'UNSUPPORTED_ANSWER', 'answer type does not match the question')
        }
        const scope = input.scope
        // 草案与当前 Mandate 使用同一套范围语义；回答本身不改变 inputDigest 或授权。
        assertMandateScope(scope, actorUserId, now)
        if (task.approvalPolicy === 'full_access') {
          throw new ApiError(409, 'CONFLICT', 'full_access task cannot receive a mandate')
        }
        await assertAllowedAgents(tx, scope.allowedAgentIds)
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
        const proposal = await insertWorkMandateProposal(tx, {
          id: uuidv7(now.getTime()),
          workId: work.id,
          taskId: work.taskId,
          projectId: work.projectId,
          workKey: work.workKey,
          questionId: question.id,
          answerId: answer.id,
          decisionId: question.decisionId,
          baseMandateId: question.mandateId,
          baseMandateVersion: question.mandateVersion,
          principalUserId: actorUserId,
          scope: scope as unknown as Record<string, unknown>,
          status: 'pending',
          resultMandateId: null,
          confirmedAt: null,
          closedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        if (proposal === undefined) {
          throw new ApiError(409, 'CONFLICT', 'scope proposal already exists')
        }
        // 扩权确认前旧意图不得派发；问题已 answered，草案待责任人确认。
        const cancelled =
          question.dispatchIntentId === null
            ? undefined
            : await cancelDispatchIntentById(
                tx,
                question.dispatchIntentId,
                'decision_authorize_scope',
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
              optionId: null,
              binding: true,
              rejectionReason: null,
              createdAt: now.toISOString(),
            },
            reevaluate: false,
            deferred: false,
            intentCancelled: cancelled !== undefined,
            scopeProposal: toWorkMandateProposalView(proposal, work.workKey),
          }),
        }
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
          scopeProposal: null,
        }),
      }
    },
  )

  // #517 前的回执是裸 WorkQuestionAnswerView；重放时归一化为当前的 AnswerOutcome。
  const result = normalizeAnswerOutcome(outcome.value as AnswerOutcome | WorkQuestionAnswerView)
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
