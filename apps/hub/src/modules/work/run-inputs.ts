import {
  getRetractedInboxItemForSource,
  getWorkById,
  insertWorkInboxDelivery,
  listWorkInboxItemsForUpdate,
  markWorkInboxItemDelivered,
  markWorkInputsUnconfirmed,
  returnUnconfirmedWorkInputs,
  type Database,
  type TaskRow,
  type Tx,
  type WorkInboxItemRow,
  type WorkRow,
} from '@whalepod/db'
import {
  WORK_INPUT_MANIFEST_MAX_ENTRIES,
  WORK_INPUT_MANIFEST_VERSION,
  WorkInputManifestSchema,
  type WorkInputManifest,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { RunCommandError } from '../run/errors.js'
import { loadWorkSource } from './admission.js'

// ADR-0028（RD-02a-2a）：Run 创建事务内冻结工作输入清单。只接受同一 active work、
// 同一 Task 的 pending 条目；来源仍可读且版本/摘要未变才允许冻结。正文不进清单。

export const WORK_INPUT_RECONCILE_WINDOW_MS = 60_000 as const

export interface SnapshotWorkInputs {
  readonly work: WorkRow
  readonly items: readonly WorkInboxItemRow[]
  readonly manifest: WorkInputManifest
  readonly manifestDigest: string
}

function conflict(message: string): never {
  throw new RunCommandError('CONFLICT', message)
}

/**
 * 校验并冻结选中的收件箱条目。调用方必须已持有 Task 行锁（orchestrator 的
 * createInTransaction），与收件箱写命令的 Task→Work→item 锁序一致。
 */
export async function snapshotWorkInputs(
  tx: Tx,
  task: TaskRow,
  itemIds: readonly string[] | undefined,
): Promise<SnapshotWorkInputs | undefined> {
  if (itemIds === undefined) return undefined
  if (itemIds.length === 0) {
    throw new RunCommandError('VALIDATION_FAILED', 'workInputItemIds must not be empty')
  }
  if (itemIds.length > WORK_INPUT_MANIFEST_MAX_ENTRIES) {
    throw new RunCommandError(
      'VALIDATION_FAILED',
      `workInputItemIds exceeds ${WORK_INPUT_MANIFEST_MAX_ENTRIES} entries`,
    )
  }
  if (new Set(itemIds).size !== itemIds.length) {
    throw new RunCommandError('VALIDATION_FAILED', 'workInputItemIds must not contain duplicates')
  }

  const items = await listWorkInboxItemsForUpdate(tx, itemIds)
  if (items.length !== itemIds.length) conflict('one or more work input items do not exist')
  const first = items[0]
  if (first === undefined) conflict('work input items are empty')
  if (items.some((item) => item.workId !== first.workId)) {
    conflict('work input items must belong to the same work')
  }
  const work = await getWorkById(tx, first.workId)
  if (work === undefined) conflict('work input items reference a missing work')
  if (work.state !== 'active') conflict('only an active work can provide run inputs')
  if (work.taskId !== task.id || first.taskId !== task.id) {
    conflict('work input items do not belong to this task')
  }
  if (first.projectId !== task.projectId) conflict('work input items do not belong to this project')
  if (first.workKey !== work.workKey) conflict('work input items do not belong to this work')
  if (work.humanOwnerUserId !== task.assigneeUserId) {
    conflict('work input owner does not match the task assignee')
  }

  for (const item of items) {
    if (item.taskId !== task.id || item.workId !== work.id) {
      conflict('work input items do not belong to this work and task')
    }
    if (item.status !== 'pending') {
      conflict(`work input item ${item.id} is ${item.status}, not pending`)
    }
    const retracted = await getRetractedInboxItemForSource(
      tx,
      work.id,
      item.sourceType,
      item.sourceId,
    )
    if (retracted !== undefined) {
      conflict(`work input source ${item.sourceId} was retracted`)
    }
    let source
    try {
      source = await loadWorkSource(tx, work, item.sourceType, item.sourceId)
    } catch (error) {
      // Run 路由只认识 DomainError/RunCommandError；把来源校验的 ApiError 归一成
      // 运行面可映射的冲突，避免合法拒绝落成 500。
      if (error instanceof ApiError) throw new RunCommandError(error.code, error.message)
      throw error
    }
    if (source.ignored !== undefined) {
      conflict(`work input source ${item.sourceId} is not readable: ${source.ignored.reason}`)
    }
    if (
      source.sourceVersion !== item.sourceVersion ||
      source.sourceDigest !== item.sourceDigest ||
      source.authorizationGeneration !== item.authorizationGeneration
    ) {
      conflict(`work input item ${item.id} is stale; re-associate the current source version`)
    }
    if (sha256Hex(item.body) !== item.bodyDigest) {
      conflict(`work input item ${item.id} snapshot digest mismatch`)
    }
    if (sha256Hex(source.body) !== item.bodyDigest) {
      conflict(`work input item ${item.id} body changed since association`)
    }
  }

  const entries = [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      inboxItemId: item.id,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceDigest: item.sourceDigest,
      bodyDigest: item.bodyDigest,
      byteSize: Buffer.byteLength(item.body, 'utf8'),
      authorizationGeneration: item.authorizationGeneration,
      title: item.title,
    }))
  const manifest = WorkInputManifestSchema.parse({
    version: WORK_INPUT_MANIFEST_VERSION,
    workKey: work.workKey,
    entries,
  })
  const manifestDigest = sha256Hex(canonicalJson(manifest))
  return {
    work,
    items: items.sort((left, right) => left.id.localeCompare(right.id)),
    manifest,
    manifestDigest,
  }
}

/** Run 与清单同事务：每次交付尝试落一行，item 指针指向当前 Run。 */
export async function recordWorkInputDeliveries(
  tx: Tx,
  snapshot: SnapshotWorkInputs,
  runId: string,
  now: Date,
): Promise<void> {
  for (const item of snapshot.items) {
    const updated = await markWorkInboxItemDelivered(tx, {
      itemId: item.id,
      runId,
      now,
    })
    if (updated === undefined) {
      throw new RunCommandError('CONFLICT', 'work input item is no longer pending')
    }
    await insertWorkInboxDelivery(tx, {
      id: uuidv7(now.getTime()),
      workId: item.workId,
      workKey: item.workKey,
      taskId: item.taskId,
      projectId: item.projectId,
      inboxItemId: item.id,
      runId,
      manifestDigest: snapshot.manifestDigest,
      attempt: 1,
      status: 'sent',
      sentAt: now,
      ackedAt: null,
      failedAt: null,
      settledAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    })
  }
}

/** Run 终态同事务：已交付未消费的条目标 unconfirmed。 */
export async function markRunWorkInputsUnconfirmed(
  tx: Tx,
  runId: string,
  at: Date,
): Promise<number> {
  return markWorkInputsUnconfirmed(tx, runId, at)
}

/** 60s 窗口到期仍无消费回执：回到 pending，保留 delivery 尝试历史。 */
export async function reconcileWorkInputs(
  database: Database,
  now: Date,
  windowMs = WORK_INPUT_RECONCILE_WINDOW_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs)
  return database.transaction(async (tx) => returnUnconfirmedWorkInputs(tx, cutoff, now))
}

/** 供收件箱读面/测试使用的不可变清单校验；不进入 HTTP 写路径。 */
export function assertWorkInputManifest(value: unknown): WorkInputManifest {
  const parsed = WorkInputManifestSchema.safeParse(value)
  if (!parsed.success) throw new ApiError(500, 'INTERNAL_ERROR', 'invalid work input manifest')
  return parsed.data
}
