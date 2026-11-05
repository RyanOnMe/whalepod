import { getAgent, getProfileRevision, type Tx, type WorkMandateRow } from '@whalepod/db'
import type { CreateWorkMandateRequest } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'

// ADR-0028 §7/§8（RD-03d2b）：创建 Mandate 与确认 authorize_scope 草案共用的范围校验。
// 两处必须使用同一套语义，避免“回答时通过、确认时扩大”或反向不一致。

export function assertNoDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ApiError(400, 'VALIDATION_FAILED', `${label} must not contain duplicates`)
  }
}

export async function assertAllowedAgents(tx: Tx, agentIds: readonly string[]): Promise<void> {
  for (const agentId of agentIds) {
    const agent = await getAgent(tx, agentId)
    if (agent === undefined || agent.archivedAt !== null) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'allowed agent is missing or archived')
    }
    if (agent.currentRevisionId === null) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'allowed agent has no profile revision')
    }
    const revision = await getProfileRevision(tx, agent.currentRevisionId)
    if (revision === undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'allowed agent has no profile revision')
    }
    // ADR-0028 §5：full_access 不能成为自主派工候选。
    if (revision.approvalPolicy === 'full_access') {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'full_access agent cannot be a mandate candidate',
      )
    }
  }
}

/**
 * 范围本身的确定性校验：去重、草稿受众必须与 principal 同一成员、到期时间在未来。
 * 确认路径会再跑一次，防止回答后范围漂移。
 */
export function assertMandateScope(
  input: CreateWorkMandateRequest,
  actorUserId: string,
  now: Date,
): void {
  assertNoDuplicates(input.allowedActionClasses, 'allowedActionClasses')
  assertNoDuplicates(input.allowedSourceTypes, 'allowedSourceTypes')
  assertNoDuplicates(input.allowedAgentIds, 'allowedAgentIds')
  assertNoDuplicates(input.allowedToolNames, 'allowedToolNames')
  if (input.draftRecipientUserId !== undefined && input.draftRecipientUserId !== actorUserId) {
    // ADR-0028 §6/§7：RD-01 内草稿受众必须与 principal 同一成员。
    throw new ApiError(400, 'VALIDATION_FAILED', 'draft recipient must be the acting assignee')
  }
  if (new Date(input.expiresAt).getTime() <= now.getTime()) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'expiresAt must be in the future')
  }
}

export function mandateContract(
  input: CreateWorkMandateRequest,
): Omit<
  WorkMandateRow,
  | 'id'
  | 'workId'
  | 'workKey'
  | 'projectId'
  | 'taskId'
  | 'version'
  | 'status'
  | 'principalUserId'
  | 'onBehalfOfUserId'
  | 'humanOwnerUserId'
  | 'draftRecipientUserId'
  | 'statusReason'
  | 'pausedAt'
  | 'revokedAt'
  | 'createdAt'
  | 'updatedAt'
> {
  return {
    autoDispatch: input.autoDispatch,
    allowedActionClasses: input.allowedActionClasses,
    allowedSourceTypes: input.allowedSourceTypes,
    allowedAgentIds: input.allowedAgentIds,
    allowedToolNames: input.allowedToolNames,
    maxRunsPerWork: input.maxRunsPerWork,
    maxCostMicros: input.maxCostMicros,
    maxTokens: input.maxTokens,
    maxAttempts: input.maxAttempts,
    waitDeadlineSeconds: input.waitDeadlineSeconds,
    expiresAt: new Date(input.expiresAt),
  }
}
