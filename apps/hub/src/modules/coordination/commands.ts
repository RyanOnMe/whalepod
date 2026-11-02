import type { Database } from '@whalepod/db'
import {
  getCoordinatorState,
  getEvaluation,
  insertEvaluation,
  maxAttemptForInput,
  transactCommand,
} from '@whalepod/db'
import type { CoordinationEvaluationView } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { enqueueCoordinationEvaluation } from './enqueue.js'
import { evaluateQueuedEvaluation } from './evaluator.js'
import { loadCoordinationInput } from './input.js'
import { COORDINATION_PROCESSOR_VERSION, COORDINATION_RULES_VERSION } from './rules.js'
import { toEvaluationView } from './views.js'

export interface CoordinationActor {
  readonly userId: string
  readonly role: 'owner' | 'admin' | 'member'
}

export interface RequestEvaluationResult {
  readonly evaluation: CoordinationEvaluationView
  readonly queuedEvaluationId: string | null
  readonly queuedChanged: boolean
  readonly inferenceEntryId: string | null
}

/**
 * 成员显式触发一次确定性评估（幂等）。
 *
 * 与自动触发共用同一合并逻辑：先 enqueue（同项目至多一条 queued），再在**同一事务**
 * 求值；当前输入已有 completed 时不重复产出 Inference，而是记录一条
 * skipped(no_relevant_change) 评估让成员看到「无变化」。
 */
export async function requestCoordinationEvaluation(
  database: Database,
  actor: CoordinationActor,
  projectId: string,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<RequestEvaluationResult> {
  const commandKey = `coordination.evaluate:${actor.userId}:${projectId}:${idempotencyKey}`
  return transactCommand(database, commandKey, async (tx) => {
    const enqueued = await enqueueCoordinationEvaluation(tx, projectId, now)
    if (enqueued.queued !== undefined) {
      const outcome = await evaluateQueuedEvaluation(tx, enqueued.queued.id, now)
      // 并发 tick 可能已把该 queued 收口：返回真实终态，不能把陈旧 queued 视图
      // 当成本次结果（评审 C7）。
      const row = outcome?.evaluation ?? (await getEvaluation(tx, enqueued.queued.id)) ?? undefined
      if (row === undefined) throw new ApiError(409, 'CONFLICT', 'evaluation vanished')
      return {
        evaluation: toEvaluationView(row),
        queuedEvaluationId: enqueued.queued.id,
        queuedChanged: enqueued.changed,
        inferenceEntryId: outcome?.inference?.id ?? row.inferenceEntryId ?? null,
      }
    }

    const state = await getCoordinatorState(tx, projectId)
    if (state === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    const input = await loadCoordinationInput(tx, projectId)
    const attempt = (await maxAttemptForInput(tx, projectId, input.inputDigest)) + 1
    const reason =
      state.pausedAt !== null
        ? 'coordinator_paused'
        : state.enabled
          ? 'no_relevant_change'
          : 'coordinator_disabled'
    const row = await insertEvaluation(tx, {
      id: uuidv7(),
      projectId,
      status: 'skipped',
      attempt,
      inputDigest: input.inputDigest,
      inputManifest: input.manifest,
      manifestVersion: 1,
      rulesVersion: COORDINATION_RULES_VERSION,
      processorVersion: COORDINATION_PROCESSOR_VERSION,
      queuedAt: now,
      queueExpiresAt: now,
      finishedAt: now,
      failureCode: reason,
      failureSummary:
        reason === 'no_relevant_change'
          ? 'input matches the latest completed evaluation'
          : 'project coordination is disabled or paused',
    })
    return {
      evaluation: toEvaluationView(row),
      queuedEvaluationId: null,
      queuedChanged: false,
      inferenceEntryId: null,
    }
  })
}
