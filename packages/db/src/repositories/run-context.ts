import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { runs } from '../schema/run.js'
import {
  runContextConsumptions,
  runContextReceipts,
  runContextStateAcks,
  runProjectContextEntries,
  runProjectContexts,
  type RunContextConsumptionRow,
  type RunContextReceiptRow,
  type RunContextStateAckRow,
  type RunProjectContextEntryRow,
  type RunProjectContextRow,
} from '../schema/run-context.js'

export type {
  RunContextConsumptionRow,
  RunContextReceiptRow,
  RunContextStateAckRow,
  RunProjectContextEntryRow,
  RunProjectContextRow,
} from '../schema/run-context.js'

/** 仍可能需要状态同步的 Run（终态不再下发上下文状态帧）。 */
export const ACTIVE_RUN_CONTEXT_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
] as const

// ADR-0027（PC-05a）：快照/回执/消费的持久化原语。选择规则、回执接受谓词与
// 状态派生在 Hub 命令层；这里只提供事务内读写，避免调用方另写第二套谓词。

export type NewRunProjectContextRow = typeof runProjectContexts.$inferInsert
export type NewRunProjectContextEntryRow = typeof runProjectContextEntries.$inferInsert
export type NewRunContextReceiptRow = typeof runContextReceipts.$inferInsert

export async function insertRunProjectContext(
  handle: DbHandle,
  values: NewRunProjectContextRow,
): Promise<RunProjectContextRow> {
  const [row] = await handle.insert(runProjectContexts).values(values).returning()
  if (row === undefined) throw new Error('insert run project context returned no row')
  return row
}

export async function insertRunProjectContextEntries(
  handle: DbHandle,
  values: readonly NewRunProjectContextEntryRow[],
): Promise<void> {
  if (values.length === 0) return
  await handle.insert(runProjectContextEntries).values([...values])
}

export async function getRunProjectContextByRun(
  handle: DbHandle,
  runId: string,
): Promise<RunProjectContextRow | undefined> {
  const [row] = await handle
    .select()
    .from(runProjectContexts)
    .where(eq(runProjectContexts.runId, runId))
  return row
}

export async function getRunProjectContextForUpdate(
  handle: DbHandle,
  runId: string,
): Promise<RunProjectContextRow | undefined> {
  const [row] = await handle
    .select()
    .from(runProjectContexts)
    .where(eq(runProjectContexts.runId, runId))
    .for('update')
  return row
}

export async function listRunProjectContextEntries(
  handle: DbHandle,
  snapshotId: string,
): Promise<RunProjectContextEntryRow[]> {
  return handle
    .select()
    .from(runProjectContextEntries)
    .where(eq(runProjectContextEntries.snapshotId, snapshotId))
    .orderBy(asc(runProjectContextEntries.entryId))
}

export async function getRunProjectContextEntry(
  handle: DbHandle,
  snapshotId: string,
  entryId: string,
): Promise<RunProjectContextEntryRow | undefined> {
  const [row] = await handle
    .select()
    .from(runProjectContextEntries)
    .where(
      and(
        eq(runProjectContextEntries.snapshotId, snapshotId),
        eq(runProjectContextEntries.entryId, entryId),
      ),
    )
  return row
}

export async function insertRunContextReceipt(
  handle: DbHandle,
  values: NewRunContextReceiptRow,
): Promise<RunContextReceiptRow> {
  const [row] = await handle.insert(runContextReceipts).values(values).returning()
  if (row === undefined) throw new Error('insert run context receipt returned no row')
  return row
}

export async function lastRunContextReceiptSeq(
  handle: DbHandle,
  runId: string,
  snapshotId: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: sql<number>`coalesce(max(${runContextReceipts.receiptSeq}), 0)` })
    .from(runContextReceipts)
    .where(and(eq(runContextReceipts.runId, runId), eq(runContextReceipts.snapshotId, snapshotId)))
  return Number(row?.value ?? 0)
}

/** 首次交付才写 deliveredAt；重复回执不推迟既有事实。 */
export async function markRunProjectContextEntriesDelivered(
  handle: DbHandle,
  snapshotId: string,
  entryIds: readonly string[],
  at: Date,
): Promise<void> {
  if (entryIds.length === 0) return
  await handle
    .update(runProjectContextEntries)
    .set({ deliveredAt: at })
    .where(
      and(
        eq(runProjectContextEntries.snapshotId, snapshotId),
        inArray(runProjectContextEntries.entryId, [...entryIds]),
        isNull(runProjectContextEntries.deliveredAt),
      ),
    )
}

/** 首次读取才写 readAt（读事件各自时间）；重复读取不覆盖。 */
export async function markRunProjectContextEntryRead(
  handle: DbHandle,
  snapshotId: string,
  entryId: string,
  at: Date,
): Promise<void> {
  await handle
    .update(runProjectContextEntries)
    .set({ readAt: at })
    .where(
      and(
        eq(runProjectContextEntries.snapshotId, snapshotId),
        eq(runProjectContextEntries.entryId, entryId),
        isNull(runProjectContextEntries.readAt),
      ),
    )
}

export async function insertRunContextConsumptionIfAbsent(
  handle: DbHandle,
  values: {
    readonly snapshotId: string
    readonly entryId: string
    readonly threadId: string | null
    readonly runId: string
    readonly readAt: Date
  },
): Promise<boolean> {
  const rows = await handle
    .insert(runContextConsumptions)
    .values(values)
    .onConflictDoNothing()
    .returning({ entryId: runContextConsumptions.entryId })
  return rows.length > 0
}

export async function listRunContextConsumptions(
  handle: DbHandle,
  snapshotId: string,
): Promise<RunContextConsumptionRow[]> {
  return handle
    .select()
    .from(runContextConsumptions)
    .where(eq(runContextConsumptions.snapshotId, snapshotId))
    .orderBy(asc(runContextConsumptions.readAt), asc(runContextConsumptions.entryId))
}

export type RunProjectContextPatch = Partial<typeof runProjectContexts.$inferInsert>

export async function updateRunProjectContext(
  handle: DbHandle,
  id: string,
  patch: RunProjectContextPatch,
): Promise<RunProjectContextRow | undefined> {
  const [row] = await handle
    .update(runProjectContexts)
    .set(patch)
    .where(eq(runProjectContexts.id, id))
    .returning()
  return row
}

// ---------- ADR-0027 §6（PC-05b）：状态机与 Node 应用回执 ----------

export type NewRunContextStateAckRow = typeof runContextStateAcks.$inferInsert

/** 逐条写派生状态；调用方负责先判断是否真的变化（避免每次 tick 都写行）。 */
export async function updateRunProjectContextEntryState(
  handle: DbHandle,
  snapshotId: string,
  entryId: string,
  entryStatus: RunProjectContextEntryRow['entryStatus'],
  statusReason: string | null,
): Promise<void> {
  await handle
    .update(runProjectContextEntries)
    .set({ entryStatus, statusReason })
    .where(
      and(
        eq(runProjectContextEntries.snapshotId, snapshotId),
        eq(runProjectContextEntries.entryId, entryId),
      ),
    )
}

/**
 * 同一 `(run, snapshot, device, stateVersion)` 的回执可重复上报：清理重试成功后
 * 会用同一版本发一条 `failedEntryIds: []` 的恢复回执，必须覆盖旧的失败集合，
 * 否则「清理待完成」信号永远清不掉。
 */
export async function upsertRunContextStateAck(
  handle: DbHandle,
  values: NewRunContextStateAckRow,
): Promise<boolean> {
  const rows = await handle
    .insert(runContextStateAcks)
    .values(values)
    .onConflictDoUpdate({
      target: [
        runContextStateAcks.runId,
        runContextStateAcks.snapshotId,
        runContextStateAcks.deviceId,
        runContextStateAcks.stateVersion,
      ],
      set: {
        stateDigest: values.stateDigest,
        appliedAt: values.appliedAt,
        failedEntryIds: values.failedEntryIds,
        receivedAt: values.receivedAt,
      },
    })
    .returning({ id: runContextStateAcks.id })
  return rows.length > 0
}

export async function getLatestRunContextStateAck(
  handle: DbHandle,
  runId: string,
): Promise<RunContextStateAckRow | undefined> {
  const [row] = await handle
    .select()
    .from(runContextStateAcks)
    .where(eq(runContextStateAcks.runId, runId))
    .orderBy(desc(runContextStateAcks.stateVersion), desc(runContextStateAcks.receivedAt))
    .limit(1)
  return row
}

export interface ActiveRunContextSnapshotRow {
  readonly runId: string
  readonly deviceId: string
  readonly snapshotId: string
  readonly entryCount: number
  readonly stateVersion: number
  readonly stateDigest: string | null
}

/** 所有仍活跃且带快照的 Run（状态同步 tick 与重连全量发送的候选集）。 */
export async function listActiveRunContextSnapshots(
  handle: DbHandle,
): Promise<ActiveRunContextSnapshotRow[]> {
  return handle
    .select({
      runId: runs.id,
      deviceId: runs.deviceId,
      snapshotId: runProjectContexts.id,
      entryCount: runProjectContexts.entryCount,
      stateVersion: runProjectContexts.stateVersion,
      stateDigest: runProjectContexts.stateDigest,
    })
    .from(runProjectContexts)
    .innerJoin(runs, eq(runs.id, runProjectContexts.runId))
    .where(inArray(runs.status, [...ACTIVE_RUN_CONTEXT_STATUSES]))
    .orderBy(asc(runs.id))
}

/** 快照包含某条 context_entry 的活跃 Run（纠正/撤回的级联入口）。 */
export async function listActiveRunContextSnapshotsForEntry(
  handle: DbHandle,
  entryId: string,
): Promise<ActiveRunContextSnapshotRow[]> {
  return handle
    .selectDistinctOn([runs.id], {
      runId: runs.id,
      deviceId: runs.deviceId,
      snapshotId: runProjectContexts.id,
      entryCount: runProjectContexts.entryCount,
      stateVersion: runProjectContexts.stateVersion,
      stateDigest: runProjectContexts.stateDigest,
    })
    .from(runProjectContextEntries)
    .innerJoin(runProjectContexts, eq(runProjectContexts.id, runProjectContextEntries.snapshotId))
    .innerJoin(runs, eq(runs.id, runProjectContexts.runId))
    .where(
      and(
        eq(runProjectContextEntries.entryId, entryId),
        inArray(runs.status, [...ACTIVE_RUN_CONTEXT_STATUSES]),
      ),
    )
    .orderBy(asc(runs.id))
}
