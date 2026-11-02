import type { CoordinationEvaluationRow, Tx } from '@whalepod/db'
import {
  ensureCoordinatorState,
  findCompletedEvaluationForInput,
  findQueuedEvaluationForUpdate,
  getCoordinatorStateForUpdate,
  insertEvaluation,
  maxAttemptForInput,
  updateCoordinatorState,
  updateEvaluation,
} from '@whalepod/db'
import { uuidv7 } from '../shared/uuid.js'
import { loadCoordinationInput } from './input.js'
import {
  COORDINATION_PROCESSOR_VERSION,
  COORDINATION_QUEUE_MAX_MS,
  COORDINATION_QUEUE_TTL_MS,
  COORDINATION_RULES_VERSION,
} from './rules.js'

export interface EnqueueResult {
  /** 当前可求值的 queued 行（没有变化或已有同输入 completed 时为 undefined）。 */
  readonly queued: CoordinationEvaluationRow | undefined
  /** true = 本次真的新建/合并了 queued（调用方可用于 tick 唤醒日志）。 */
  readonly changed: boolean
  /** 当前输入已有 completed：不唤醒、不复用旧结果。 */
  readonly alreadyCompleted: boolean
}

function queueExpiry(now: Date, queuedAt: Date): Date {
  const byTtl = now.getTime() + COORDINATION_QUEUE_TTL_MS
  const byLifetime = queuedAt.getTime() + COORDINATION_QUEUE_MAX_MS
  return new Date(Math.min(byTtl, byLifetime))
}

/**
 * PC-03a 的业务事实写入后，在同一事务里合并出至多一条 queued 评估。
 *
 * - 同 digest 已有 completed：不唤醒（返回 alreadyCompleted），并把同一事务里
 *   已存在的旧 queued 标 skipped(already_completed)；
 * - 已有 queued：仅当 digest 前进时更新清单/版本号/合并时间；
 * - 没有 queued：新建；attempt = 该 digest 历史最大值 + 1，避免唯一冲突。
 */
export async function enqueueCoordinationEvaluation(
  tx: Tx,
  projectId: string,
  now: Date = new Date(),
): Promise<EnqueueResult> {
  const state = await ensureCoordinatorState(tx, {
    projectId,
    rulesVersion: COORDINATION_RULES_VERSION,
    processorVersion: COORDINATION_PROCESSOR_VERSION,
  })
  // 锁顺序固定：先 coordinator state，再 queued evaluation（evaluator 同序）。
  // 否则两个并发的同项目业务写入会同时插入 queued，败者整体回滚业务命令。
  const lockedState = await getCoordinatorStateForUpdate(tx, projectId)
  const current = lockedState ?? state
  if (!current.enabled || current.pausedAt !== null) {
    return { queued: undefined, changed: false, alreadyCompleted: false }
  }
  // 规则/处理器版本升级后，状态读面必须与评估使用的版本一致。
  if (
    current.rulesVersion !== COORDINATION_RULES_VERSION ||
    current.processorVersion !== COORDINATION_PROCESSOR_VERSION
  ) {
    await updateCoordinatorState(tx, projectId, {
      rulesVersion: COORDINATION_RULES_VERSION,
      processorVersion: COORDINATION_PROCESSOR_VERSION,
      updatedAt: now,
    })
  }

  const input = await loadCoordinationInput(tx, projectId)
  const completed = await findCompletedEvaluationForInput(tx, projectId, input.inputDigest)
  const queued = await findQueuedEvaluationForUpdate(tx, projectId)
  if (completed !== undefined) {
    if (queued !== undefined) {
      await updateEvaluation(tx, queued.id, {
        status: 'skipped',
        failureCode: 'already_completed',
        failureSummary: 'same input already has a completed evaluation',
        finishedAt: now,
      })
    }
    return { queued: undefined, changed: false, alreadyCompleted: true }
  }
  if (queued !== undefined) {
    if (queued.inputDigest === input.inputDigest) {
      return { queued, changed: false, alreadyCompleted: false }
    }
    // ADR-0026 §3：合并后按该输入的历史 attempt 取 max+1，避免唯一冲突；
    // 规则/处理器版本同步前进，读面版本不能与 digest 脱节。
    const attempt = (await maxAttemptForInput(tx, projectId, input.inputDigest)) + 1
    const updated = await updateEvaluation(tx, queued.id, {
      inputDigest: input.inputDigest,
      inputManifest: input.manifest,
      manifestVersion: queued.manifestVersion + 1,
      coalescedAt: now,
      queueExpiresAt: queueExpiry(now, queued.queuedAt),
      attempt,
      rulesVersion: COORDINATION_RULES_VERSION,
      processorVersion: COORDINATION_PROCESSOR_VERSION,
    })
    return { queued: updated, changed: true, alreadyCompleted: false }
  }

  const attempt = (await maxAttemptForInput(tx, projectId, input.inputDigest)) + 1
  const row = await insertEvaluation(tx, {
    id: uuidv7(),
    projectId,
    status: 'queued',
    attempt,
    inputDigest: input.inputDigest,
    inputManifest: input.manifest,
    manifestVersion: 1,
    rulesVersion: COORDINATION_RULES_VERSION,
    processorVersion: COORDINATION_PROCESSOR_VERSION,
    queuedAt: now,
    queueExpiresAt: queueExpiry(now, now),
  })
  return { queued: row, changed: true, alreadyCompleted: false }
}
