import {
  getLatestWorkMandate,
  getWorkByKey,
  getWorkMandate,
  getWorkMandateProposal,
  getWorkMandateProposalForUpdate,
  getWorkQuestionById,
  markWorkMandateProposalConfirmed,
  markWorkQuestionSuperseded,
  transactCommandWithOrigin,
  type Database,
  type DbHandle,
  type WorkMandateProposalRow,
  type WorkQuestionRow,
  type WorkRow,
} from '@whalepod/db'
import {
  WorkAuthorizeScopeRequestSchema,
  WorkMandateProposalConfirmViewSchema,
  type WorkAuthorizeScopeRequest,
  type WorkMandateProposalConfirmView,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { insertActiveMandateVersion } from './commands.js'
import { lockWorkContext, requireAssignee } from './context.js'
import { assertAllowedAgents, assertMandateScope } from './mandate-scope.js'
import { toWorkMandateProposalView, toWorkQuestionView } from './questions.js'
import { toWorkMandateView } from './queries.js'

// ADR-0028 §8（RD-03d2b）：authorize_scope 草案的显式确认。
// 回答只生成草案；确认才建立 version=latest+1 的新 Mandate，并把旧 decisionId
// 关闭为 superseded。确认前的任何漂移都返回 DECISION_STALE，不生成新版本。

export interface ScopeProposalDeps {
  readonly database: Database
  readonly now: () => Date
}

export interface ScopeProposalConfirmOutcome {
  readonly view: WorkMandateProposalConfirmView
  readonly changed: boolean
}

type StaleReason =
  | 'proposal_superseded'
  | 'proposal_invalid'
  | 'assignee_changed'
  | 'principal_changed'
  | 'work_inactive'
  | 'owner_changed'
  | 'task_policy_changed'
  | 'scope_invalid'
  | 'scope_agents_changed'
  | 'mandate_changed'
  | 'mandate_inactive'

function stale(proposal: WorkMandateProposalRow, reason: StaleReason): never {
  throw new ApiError(
    409,
    'DECISION_STALE',
    'scope proposal no longer binds to the current mandate',
    {
      proposalId: proposal.id,
      questionId: proposal.questionId,
      decisionId: proposal.decisionId,
      reason,
    },
  )
}

function requireConfirmableTask(task: {
  readonly assignmentStatus: string
  readonly status: string
}): void {
  if (task.assignmentStatus !== 'accepted') {
    throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new ApiError(409, 'TASK_TERMINAL', 'task is terminal')
  }
}

async function loadQuestion(tx: DbHandle, questionId: string): Promise<WorkQuestionRow> {
  const question = await getWorkQuestionById(tx, questionId)
  if (question === undefined) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'scope proposal question is missing')
  }
  return question
}

async function confirmedView(
  tx: DbHandle,
  proposal: WorkMandateProposalRow,
  work: WorkRow,
  now: Date,
): Promise<WorkMandateProposalConfirmView> {
  if (proposal.resultMandateId === null) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'confirmed scope proposal has no mandate')
  }
  const mandate = await getWorkMandate(tx, proposal.resultMandateId)
  if (mandate === undefined) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'confirmed scope proposal mandate is missing')
  }
  const latest = await getLatestWorkMandate(tx, work.id)
  const question = await loadQuestion(tx, proposal.questionId)
  return WorkMandateProposalConfirmViewSchema.parse({
    proposal: toWorkMandateProposalView(proposal, work.workKey),
    mandate: toWorkMandateView(
      mandate,
      now,
      work.state === 'active' && work.mandateId === mandate.id && latest?.id === mandate.id,
    ),
    question: toWorkQuestionView(question, work.workKey),
  })
}

/** 回执重放时重新按当前 work 指针渲染，避免把已被新版本取代的 Mandate 标成 current。 */
async function loadConfirmView(
  database: Database,
  workKey: string,
  proposalId: string,
  now: Date,
): Promise<WorkMandateProposalConfirmView> {
  const work = await getWorkByKey(database.db, workKey)
  const proposal = await getWorkMandateProposal(database.db, proposalId)
  if (work === undefined || proposal === undefined || proposal.workId !== work.id) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'confirmed scope proposal is missing')
  }
  return confirmedView(database.db, proposal, work, now)
}

function parseStoredScope(proposal: WorkMandateProposalRow): WorkAuthorizeScopeRequest {
  const parsed = WorkAuthorizeScopeRequestSchema.safeParse(proposal.scope)
  if (!parsed.success) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'stored mandate scope is invalid')
  }
  return parsed.data
}

/**
 * 确认入口（ADR-0028 §8）：仅 Task 当前 assignee、assignment accepted、work active/owner
 * 一致，且 base Mandate 仍是当前 active/未过期版本时建立新版本。重复确认/相同幂等键
 * 返回同一结果，不生成第二个版本。
 */
export async function confirmWorkMandateProposal(
  deps: ScopeProposalDeps,
  actorUserId: string,
  workKey: string,
  proposalId: string,
  idempotencyKey: string,
): Promise<ScopeProposalConfirmOutcome> {
  const outcome = await transactCommandWithOrigin(
    deps.database,
    `work.mandate_proposal.confirm:${workKey}:${proposalId}:${actorUserId}:${idempotencyKey}`,
    async (
      tx,
    ): Promise<{
      readonly view: WorkMandateProposalConfirmView
      readonly changed: boolean
    }> => {
      const { work, task } = await lockWorkContext(tx, workKey)
      const proposal = await getWorkMandateProposalForUpdate(tx, proposalId)
      if (proposal === undefined || proposal.workId !== work.id) {
        throw new ApiError(404, 'NOT_FOUND', 'scope proposal not found')
      }
      if (task.assigneeUserId !== actorUserId && proposal.principalUserId === actorUserId) {
        // 改派后的旧责任人能拿到稳定 stale；从未参与该问题的成员走下面的 403。
        stale(proposal, 'assignee_changed')
      }
      // 与其它工作写命令共用“当前 assignee + 启用成员”校验。
      await requireAssignee(tx, task, actorUserId)
      requireConfirmableTask(task)
      const now = deps.now()
      if (proposal.status === 'confirmed') {
        // 重复确认：返回同一新版本与已关闭的问题，不再创建版本。
        return { view: await confirmedView(tx, proposal, work, now), changed: false }
      }
      if (proposal.status !== 'pending') stale(proposal, 'proposal_superseded')
      if (proposal.principalUserId !== actorUserId) stale(proposal, 'principal_changed')
      const question = await loadQuestion(tx, proposal.questionId)
      if (
        question.workId !== work.id ||
        question.decisionId !== proposal.decisionId ||
        question.questionType !== 'authorize_scope'
      ) {
        stale(proposal, 'proposal_invalid')
      }
      if (work.state !== 'active') stale(proposal, 'work_inactive')
      if (work.humanOwnerUserId !== actorUserId) stale(proposal, 'owner_changed')
      const scope = parseStoredScope(proposal)
      try {
        assertMandateScope(scope, actorUserId, now)
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 400) stale(proposal, 'scope_invalid')
        throw error
      }
      if (task.approvalPolicy === 'full_access') stale(proposal, 'task_policy_changed')
      const latest = await getLatestWorkMandate(tx, work.id)
      if (
        latest === undefined ||
        latest.id !== proposal.baseMandateId ||
        latest.version !== proposal.baseMandateVersion ||
        work.mandateId !== latest.id
      ) {
        stale(proposal, 'mandate_changed')
      }
      if (latest.status !== 'active' || latest.expiresAt.getTime() <= now.getTime()) {
        stale(proposal, 'mandate_inactive')
      }
      try {
        await assertAllowedAgents(tx, scope.allowedAgentIds)
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 400) {
          stale(proposal, 'scope_agents_changed')
        }
        throw error
      }
      const mandate = await insertActiveMandateVersion(tx, {
        work,
        actorUserId,
        scope,
        now,
        subscriptionReason: 'mandate_scope_confirmed',
        keepProposalId: proposal.id,
      })
      const confirmed = await markWorkMandateProposalConfirmed(tx, proposal.id, mandate.id, now)
      if (confirmed === undefined) {
        stale(proposal, 'proposal_superseded')
      }
      const closedQuestion =
        (await markWorkQuestionSuperseded(tx, proposal.questionId, now)) ?? question
      return {
        view: WorkMandateProposalConfirmViewSchema.parse({
          proposal: toWorkMandateProposalView(confirmed, work.workKey),
          mandate: toWorkMandateView(mandate, now, true),
          question: toWorkQuestionView(closedQuestion, work.workKey),
        }),
        changed: true,
      }
    },
  )
  // 回执重放也可能发生在后续版本/暂停之后；按当前指针重新渲染 current。
  const view = await loadConfirmView(deps.database, workKey, proposalId, deps.now())
  return { view, changed: outcome.executed && outcome.value.changed }
}
