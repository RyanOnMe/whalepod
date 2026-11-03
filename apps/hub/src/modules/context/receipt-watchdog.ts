/**
 * ADR-0027 §4（PC-05b-2）：非空项目上下文 Run 的首条回执 watchdog。
 *
 * Run 进入 `running` 后 60 秒内没有任何合格的 `run.context_receipt` → 收敛
 * `failed(CONTEXT_UNAVAILABLE)`，结算触发指令，并让 Node 停止 Runtime。
 * `running` 与 `waiting_approval` 都算活跃窗口（后者只是审批闸门，回执仍应
 * 在启动后已交付）。只对 `run_project_context.entry_count > 0` 生效；空快照不受影响。
 */
import { and, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm'
import { transitionRun } from '@whalepod/domain'
import type { Database } from '@whalepod/db'
import { appendTeamEvent, lastRunContextReceiptSeq, Outbox, schema } from '@whalepod/db'
import { applyRunStatus } from '../run/run-status.js'
import { cancelPendingApprovalsInTransaction } from '../run/cancel.js'
import { settleTriggerInstruction } from '../run/followup.js'
import { uuidv7 } from '../shared/uuid.js'
import type { RecordedContextEntry } from './observer.js'

export const CONTEXT_RECEIPT_WATCHDOG_MS = 60_000
/** ADR-0027 §4：watchdog 可配置，但上限 120 秒。 */
export const CONTEXT_RECEIPT_WATCHDOG_MAX_MS = 120_000

/** 归一化调用方配置：非正数回落默认值，超过上限截到 120 秒。 */
export function resolveContextReceiptWatchdogMs(configured?: number): number {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return CONTEXT_RECEIPT_WATCHDOG_MS
  }
  return Math.min(configured, CONTEXT_RECEIPT_WATCHDOG_MAX_MS)
}

export interface ReceiptWatchdogDeps {
  readonly database: Database
  readonly outbox: Outbox
  readonly now: () => Date
  /** 首条回执等待时长；默认 60 秒，超过 120 秒按 120 秒。 */
  readonly watchdogMs?: number
  /** ADR-0025 §9：终态 Observation 的观测回调（事务提交后调用）。 */
  readonly log?: (event: RecordedContextEntry) => void
  /** ADR-0027 §8：watchdog 结构化观测（只含不透明 id/等待时长）。 */
  readonly contextLog?: (action: string, fields: Record<string, unknown>) => void
}

/** 返回本轮的收敛数量；单个 Run 失败不拖垮整轮。 */
export async function failMissingContextReceipts(deps: ReceiptWatchdogDeps): Promise<number> {
  const watchdogMs = resolveContextReceiptWatchdogMs(deps.watchdogMs)
  const now = deps.now()
  const cutoff = new Date(now.getTime() - watchdogMs)
  const candidates = await deps.database.db
    .select({
      runId: schema.runs.id,
      snapshotId: schema.runProjectContexts.id,
      startedAt: schema.runs.startedAt,
    })
    .from(schema.runProjectContexts)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.runProjectContexts.runId))
    .where(
      and(
        inArray(schema.runs.status, ['running', 'waiting_approval']),
        gt(schema.runProjectContexts.entryCount, 0),
        isNotNull(schema.runs.startedAt),
        lte(schema.runs.startedAt, cutoff),
      ),
    )

  let failed = 0
  for (const candidate of candidates) {
    try {
      const recorded: RecordedContextEntry[] = []
      let fired = false
      await deps.database.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, candidate.runId))
          .for('update')
        if (run === undefined || run.startedAt === null) return
        // 仍在活跃状态（running / waiting_approval）才收敛；终态或已取消的不碰。
        if (run.status !== 'running' && run.status !== 'waiting_approval') return
        // 回执可能在候选查询后到达；事务内再确认一次，避免误杀。
        const lastSeq = await lastRunContextReceiptSeq(tx, run.id, candidate.snapshotId)
        if (lastSeq > 0) return

        transitionRun({ status: run.status }, { type: 'failed' })
        const summary = `项目上下文首条回执超时（${Math.round(watchdogMs / 1000)} 秒内未收到 run.context_receipt）`
        await settleTriggerInstruction(tx, run, {
          accepted: false,
          error: { code: 'CONTEXT_UNAVAILABLE', message: summary },
        })
        await applyRunStatus(
          tx,
          deps.outbox,
          run.id,
          'failed',
          {
            failureCode: 'CONTEXT_UNAVAILABLE',
            failureSummary: summary,
            finishedAt: now,
          },
          recorded,
        )
        // 终态账本不变式：Run 失败后不得挂 pending Approval（审批随 Run 收口）。
        await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: 'failed' },
        })
        // Hub 已判 failed；给 Node 一条 admin cancel，确保 Runtime 不再继续执行。
        const commandId = uuidv7(now.getTime())
        await deps.outbox.enqueue(tx, {
          id: commandId,
          deviceId: run.deviceId,
          type: 'run.cancel',
          payload: { commandId, runId: run.id, cause: 'admin' },
        })
        fired = true
      })
      for (const event of recorded) deps.log?.(event)
      if (fired) {
        failed += 1
        deps.contextLog?.('context.receipt_watchdog', {
          component: 'hub.context',
          runId: candidate.runId,
          snapshotId: candidate.snapshotId,
          startedAt: candidate.startedAt?.toISOString() ?? null,
          waitedMs:
            candidate.startedAt === null ? null : now.getTime() - candidate.startedAt.getTime(),
        })
      }
    } catch (error) {
      deps.contextLog?.('context.receipt_watchdog_error', {
        component: 'hub.context',
        runId: candidate.runId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return failed
}
