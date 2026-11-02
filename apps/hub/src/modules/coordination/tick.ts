import type { Database } from '@whalepod/db'
import {
  getEvaluationForUpdate,
  listDueQueuedEvaluations,
  listExpiredQueuedEvaluations,
  unwrapPgError,
  updateEvaluation,
} from '@whalepod/db'
import { evaluateQueuedEvaluation } from './evaluator.js'
import { COORDINATION_TICK_BATCH } from './rules.js'
import { sanitizeError } from '../shared/error-log.js'

export interface CoordinationTickInput {
  readonly database: Database
  readonly now: Date
  /** 提交后的结构化观测（server 注入 app.log.info）；只含不透明 id/状态/原因。 */
  readonly log?: (event: Record<string, unknown>) => void
}

export interface CoordinationTickResult {
  readonly completed: number
  readonly skipped: number
  readonly failed: number
  readonly expired: number
}

/** 可重试的 PG 错误：保留 queued，让下一拍重来，不能据此判终态。 */
const RETRYABLE_PG_CODES = new Set([
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
  '57014',
  '55P03',
  '53300',
])

function isRetryable(error: unknown): boolean {
  const pg = unwrapPgError(error)
  if (pg?.code !== undefined) {
    // class 08 = connection exception；其余是死锁/序列化/关停/锁等待类。
    if (pg.code.startsWith('08') || RETRYABLE_PG_CODES.has(pg.code)) return true
  }
  // 驱动层连接错误可能没有 SQLSTATE；宁可下一拍重试，也不要把瞬时故障判终态。
  return (
    error instanceof Error &&
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|connection closed/i.test(
      error.message,
    )
  )
}

function logEvent(
  input: CoordinationTickInput,
  action: string,
  fields: Record<string, unknown>,
): void {
  input.log?.({
    component: 'hub.context',
    action,
    ...fields,
  })
}

/**
 * 协调 tick：先收掉过期 queued（stale_queue），再逐条求值未过期的 queued。
 *
 * 每条评估独立事务；单条失败只把该评估标 failed，不阻塞其余评估。求值成功/跳过
 * 的观测在事务提交后写（事务内不落日志，避免回滚留下伪事件）。
 */
export async function runCoordinationTick(
  input: CoordinationTickInput,
): Promise<CoordinationTickResult> {
  const result = { completed: 0, skipped: 0, failed: 0, expired: 0 }

  const expired = await listExpiredQueuedEvaluations(
    input.database.db,
    input.now,
    COORDINATION_TICK_BATCH,
  )
  for (const row of expired) {
    const updated = await input.database.transaction(async (tx) => {
      const locked = await getEvaluationForUpdate(tx, row.id)
      // CAS：列表快照之后被 enqueue 合并（digest/manifestVersion 前进）或 TTL 被刷新时，
      // 不能拿旧快照判 stale_queue，否则会丢掉刚合并进来的新输入。
      if (
        locked === undefined ||
        locked.status !== 'queued' ||
        locked.manifestVersion !== row.manifestVersion ||
        locked.queueExpiresAt.getTime() >= input.now.getTime()
      ) {
        return undefined
      }
      return updateEvaluation(tx, locked.id, {
        status: 'skipped',
        failureCode: 'stale_queue',
        failureSummary: 'queued evaluation expired before it was evaluated',
        finishedAt: input.now,
      })
    })
    if (updated !== undefined) {
      result.expired += 1
      logEvent(input, 'coordination.evaluation_queued', {
        projectId: updated.projectId,
        evaluationId: updated.id,
      })
      logEvent(input, 'coordination.evaluation_skipped', {
        projectId: updated.projectId,
        evaluationId: updated.id,
        reason: 'stale_queue',
      })
    }
  }

  const due = await listDueQueuedEvaluations(input.database.db, input.now, COORDINATION_TICK_BATCH)
  for (const row of due) {
    try {
      const outcome = await input.database.transaction((tx) =>
        evaluateQueuedEvaluation(tx, row.id, input.now),
      )
      if (outcome === undefined) continue
      // queued 行的观测在 tick 真正接手后写（避免业务事务内伪事件）；随后才是终态。
      logEvent(input, 'coordination.evaluation_queued', {
        projectId: outcome.evaluation.projectId,
        evaluationId: outcome.evaluation.id,
      })
      if (outcome.action === 'completed') {
        result.completed += 1
        logEvent(input, 'coordination.evaluation_completed', {
          projectId: outcome.evaluation.projectId,
          evaluationId: outcome.evaluation.id,
          inferenceEntryId: outcome.inference?.id,
        })
      } else {
        result.skipped += 1
        logEvent(input, 'coordination.evaluation_skipped', {
          projectId: outcome.evaluation.projectId,
          evaluationId: outcome.evaluation.id,
          reason: outcome.reason,
        })
      }
    } catch (error) {
      if (isRetryable(error)) {
        // 连接/序列化/死锁类错误：保留 queued，不把瞬时故障写成永久 failed。
        logEvent(input, 'coordination.evaluation_deferred', {
          projectId: row.projectId,
          evaluationId: row.id,
          reason: 'retryable_error',
        })
        continue
      }
      const sanitized = sanitizeError(error)
      const failed = await input.database.transaction(async (tx) => {
        const locked = await getEvaluationForUpdate(tx, row.id)
        // CAS：求值期间 enqueue 合并了新输入时，失败不再代表当前输入。
        if (
          locked === undefined ||
          locked.status !== 'queued' ||
          locked.manifestVersion !== row.manifestVersion ||
          locked.inputDigest !== row.inputDigest
        ) {
          return undefined
        }
        return updateEvaluation(tx, locked.id, {
          status: 'failed',
          failureCode: 'deterministic_error',
          failureSummary: `${sanitized.errorName}: ${sanitized.errorMessage}`.slice(0, 1000),
          finishedAt: input.now,
        })
      })
      if (failed !== undefined) {
        result.failed += 1
        logEvent(input, 'coordination.evaluation_failed', {
          projectId: failed.projectId,
          evaluationId: failed.id,
          reason: failed.failureCode,
        })
      }
    }
  }
  return result
}
