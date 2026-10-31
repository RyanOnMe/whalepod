import type { Database } from '@whalepod/db'
import type { SourceCollector } from './collector.js'
import { reconcileSourcePermissions, type SourceReconcileResult } from './reconciler.js'

export interface SourceReconcileTickInput {
  readonly database: Database
  readonly collector: SourceCollector
  readonly now?: Date
  readonly log?: (event: Record<string, unknown>) => void
}

/**
 * server 10s tick 与测试共用的唯一入口。
 * 故意不做整轮单飞：租约续租/采集器扫描必须每 tick 执行；慢权限重验由
 * reconciler 内部的 revalidationRunning 单飞（ADR-0024 §4/§5）。
 */
export function runSourceReconcileTick(
  input: SourceReconcileTickInput,
): Promise<SourceReconcileResult> {
  return reconcileSourcePermissions({
    database: input.database,
    collector: input.collector,
    now: input.now ?? new Date(),
    ...(input.log !== undefined ? { log: input.log } : {}),
  })
}
