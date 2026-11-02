import {
  countWorkInboxItems,
  getLatestPendingInboxItemForSource,
  getLatestWorkInboxItem,
  getWorkInboxItem,
  getWorkInboxItemByIdentity,
  getWorkInboxItemForUpdate,
  insertWorkInboxItem,
  listWorkInboxItems,
  supersedePendingInboxItems,
  transactCommandWithOrigin,
  updateWorkInboxItem,
  type Database,
  type Tx,
  type WorkInboxItemRow,
  type WorkRow,
} from '@whalepod/db'
import {
  WorkInboxItemViewSchema,
  type WorkInboxItemReturnRequest,
  type WorkInboxItemStatus,
  type WorkInboxItemView,
  type WorkInboxView,
} from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { loadWorkSource, type AdmissionSource } from './admission.js'
import { lockWorkContext, requireAssignee } from './context.js'

// ADR-0028（RD-02a-1）：工作收件箱的显式关联与生命周期。只写协调表；不建 Run、
// 不写 outbox/team_event、不调模型。来源校验与准入共用 loadWorkSource，非法来源
// 显式 409（带原因），不静默丢弃。

const MAX_BODY_BYTES = 65_536
const MAX_TITLE_LENGTH = 200

export interface WorkInboxCommandDeps {
  readonly database: Database
  readonly now: () => Date
}

export interface WorkInboxCommandResult {
  readonly value: WorkInboxItemView
  readonly executed: boolean
}

export function toWorkInboxItemView(row: WorkInboxItemRow): WorkInboxItemView {
  return WorkInboxItemViewSchema.parse({
    id: row.id,
    workKey: row.workKey,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceDigest: row.sourceDigest,
    authorizationGeneration: row.authorizationGeneration,
    title: row.title,
    body: row.body,
    bodyDigest: row.bodyDigest,
    refs: row.refs,
    supersedesId: row.supersedesId ?? null,
    status: row.status,
    statusReason: row.statusReason ?? null,
    returnReason: row.returnReason ?? null,
    returnNote: row.returnNote ?? null,
    statusAt: row.statusAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function clampTitle(title: string, fallback: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return fallback
  // 按码点截断，避免把代理对切成半个字符。
  return Array.from(trimmed).slice(0, MAX_TITLE_LENGTH).join('')
}

function assertSourceAdmissible(source: AdmissionSource): void {
  if (source.ignored !== undefined) {
    throw new ApiError(409, 'CONFLICT', 'source is not admissible for this work', {
      reason: source.ignored.reason,
      detail: source.ignored.detail ?? null,
    })
  }
  if (Buffer.byteLength(source.body, 'utf8') > MAX_BODY_BYTES) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'source body exceeds the inbox size limit')
  }
}

function requireActiveWork(work: WorkRow): void {
  if (work.state !== 'active') {
    throw new ApiError(409, 'CONFLICT', 'only an active work can receive inbox items', {
      workState: work.state,
    })
  }
}

function assertTaskOpen(status: string, assignmentStatus: string): void {
  if (status === 'done' || status === 'cancelled') {
    throw new ApiError(409, 'TASK_TERMINAL', 'task is terminal')
  }
  if (assignmentStatus !== 'accepted') {
    throw new ApiError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'task assignment is not accepted')
  }
}

function requestDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function scopedKey(prefix: string, workKey: string, actorUserId: string, suffix: string): string {
  return `${prefix}:${workKey}:${actorUserId}:${suffix}`
}

/**
 * 显式关联一条来源。同一 来源/版本/摘要 幂等；新版本先把同来源的 pending 置
 * superseded，再写入新条目（保留 supersedesId 链）。
 */
export async function associateWorkInboxItem(
  deps: WorkInboxCommandDeps,
  actorUserId: string,
  workKey: string,
  sourceType: 'task_message' | 'context_entry',
  sourceId: string,
  idempotencyKey: string,
): Promise<WorkInboxCommandResult> {
  return transactCommandWithOrigin(
    deps.database,
    scopedKey(
      'work.inbox.associate',
      workKey,
      actorUserId,
      `${sourceType}:${sourceId}:${requestDigest({ sourceType, sourceId })}:${idempotencyKey}`,
    ),
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      // 终态归因优先：Task 取消会自动退休工作，先报 TASK_TERMINAL 才指向根因。
      assertTaskOpen(task.status, task.assignmentStatus)
      requireActiveWork(work)
      const source = await loadWorkSource(tx, work, sourceType, sourceId)
      assertSourceAdmissible(source)

      const existing = await getWorkInboxItemByIdentity(tx, {
        workId: work.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        sourceDigest: source.sourceDigest,
      })
      if (existing !== undefined) return toWorkInboxItemView(existing)

      const now = deps.now()
      const previous = await getLatestPendingInboxItemForSource(
        tx,
        work.id,
        source.sourceType,
        source.sourceId,
      )
      await supersedePendingInboxItems(tx, {
        workId: work.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        now,
      })
      const inserted = await insertWorkInboxItem(tx, {
        id: uuidv7(now.getTime()),
        workId: work.id,
        workKey: work.workKey,
        taskId: work.taskId,
        projectId: work.projectId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        sourceDigest: source.sourceDigest,
        authorizationGeneration: source.authorizationGeneration,
        title: clampTitle(source.title, source.sourceKind),
        body: source.body,
        bodyDigest: sha256Hex(source.body),
        refs: source.refs,
        supersedesId: previous?.id ?? null,
        status: 'pending',
        statusReason: null,
        returnReason: null,
        returnNote: null,
        statusAt: now,
        createdAt: now,
        updatedAt: now,
      })
      if (inserted === undefined) {
        // 并发同身份：另一事务已写入，回读它作为幂等结果。
        const raced = await getWorkInboxItemByIdentity(tx, {
          workId: work.id,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceVersion: source.sourceVersion,
          sourceDigest: source.sourceDigest,
        })
        if (raced === undefined) {
          throw new ApiError(500, 'INTERNAL_ERROR', 'inbox item insert lost without row')
        }
        return toWorkInboxItemView(raced)
      }
      return toWorkInboxItemView(inserted)
    },
  )
}

async function lockItem(
  tx: Tx,
  workKey: string,
  actorUserId: string,
  itemId: string,
): Promise<WorkInboxItemRow> {
  const { work, task } = await lockWorkContext(tx, workKey)
  await requireAssignee(tx, task, actorUserId)
  const item = await getWorkInboxItemForUpdate(tx, itemId)
  if (item === undefined || item.workId !== work.id) {
    throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
  }
  return item
}

function requireItemStatus(item: WorkInboxItemRow, allowed: readonly WorkInboxItemStatus[]) {
  if (!allowed.includes(item.status)) {
    throw new ApiError(409, 'CONFLICT', `cannot act on a ${item.status} inbox item`, {
      status: item.status,
    })
  }
}

/** 退回：只有 pending 能退回；相同原因重放幂等。 */
export async function returnWorkInboxItem(
  deps: WorkInboxCommandDeps,
  actorUserId: string,
  workKey: string,
  itemId: string,
  input: WorkInboxItemReturnRequest,
  idempotencyKey: string,
): Promise<WorkInboxCommandResult> {
  return transactCommandWithOrigin(
    deps.database,
    scopedKey(
      'work.inbox.return',
      workKey,
      actorUserId,
      `${itemId}:${requestDigest(input)}:${idempotencyKey}`,
    ),
    async (tx) => {
      const item = await lockItem(tx, workKey, actorUserId, itemId)
      const note = input.note ?? null
      if (item.status === 'returned') {
        if (item.returnReason === input.reason && (item.returnNote ?? null) === note) {
          return toWorkInboxItemView(item)
        }
        throw new ApiError(409, 'CONFLICT', 'inbox item was already returned', {
          returnReason: item.returnReason,
        })
      }
      requireItemStatus(item, ['pending'])
      const now = deps.now()
      const updated = await updateWorkInboxItem(tx, item.id, {
        status: 'returned',
        statusReason: 'returned_by_assignee',
        returnReason: input.reason,
        returnNote: note,
        statusAt: now,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
      return toWorkInboxItemView(updated)
    },
  )
}

/** 撤权/来源失效：pending 或 returned 可撤，停止后续重投。 */
export async function retractWorkInboxItem(
  deps: WorkInboxCommandDeps,
  actorUserId: string,
  workKey: string,
  itemId: string,
  reason: string | undefined,
  idempotencyKey: string,
): Promise<WorkInboxCommandResult> {
  return transactCommandWithOrigin(
    deps.database,
    scopedKey(
      'work.inbox.retract',
      workKey,
      actorUserId,
      `${itemId}:${requestDigest({ reason: reason ?? null })}:${idempotencyKey}`,
    ),
    async (tx) => {
      const item = await lockItem(tx, workKey, actorUserId, itemId)
      if (item.status === 'retracted') return toWorkInboxItemView(item)
      requireItemStatus(item, ['pending', 'returned'])
      const now = deps.now()
      const updated = await updateWorkInboxItem(tx, item.id, {
        status: 'retracted',
        statusReason: reason ?? 'source_invalid',
        returnReason: null,
        returnNote: null,
        statusAt: now,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
      return toWorkInboxItemView(updated)
    },
  )
}

/** 过期：只有 pending 能过期；重放幂等。 */
export async function expireWorkInboxItem(
  deps: WorkInboxCommandDeps,
  actorUserId: string,
  workKey: string,
  itemId: string,
  reason: string | undefined,
  idempotencyKey: string,
): Promise<WorkInboxCommandResult> {
  return transactCommandWithOrigin(
    deps.database,
    scopedKey(
      'work.inbox.expire',
      workKey,
      actorUserId,
      `${itemId}:${requestDigest({ reason: reason ?? null })}:${idempotencyKey}`,
    ),
    async (tx) => {
      const item = await lockItem(tx, workKey, actorUserId, itemId)
      if (item.status === 'expired') return toWorkInboxItemView(item)
      requireItemStatus(item, ['pending'])
      const now = deps.now()
      const updated = await updateWorkInboxItem(tx, item.id, {
        status: 'expired',
        statusReason: reason ?? 'expired',
        returnReason: null,
        returnNote: null,
        statusAt: now,
        updatedAt: now,
      })
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
      return toWorkInboxItemView(updated)
    },
  )
}

export async function loadWorkInbox(
  database: Database,
  work: WorkRow,
  filter: { readonly status?: WorkInboxItemStatus | undefined; readonly limit: number },
): Promise<WorkInboxView> {
  const [items, pendingCount, latest] = await Promise.all([
    listWorkInboxItems(database.db, work.id, filter.limit, filter.status),
    countWorkInboxItems(database.db, work.id, 'pending'),
    getLatestWorkInboxItem(database.db, work.id),
  ])
  return {
    items: items.map(toWorkInboxItemView),
    watermarks: {
      // 水位不随筛选变化：客户端用 lastItemAt 判断是否有新条目。
      lastItemAt: latest?.createdAt.toISOString() ?? null,
      pendingCount,
    },
  }
}

/** 幂等重放时回读当前状态，避免把已退回/撤权的缓存视图当成仍 pending。 */
export async function refreshWorkInboxItem(
  database: Database,
  workKey: string,
  itemId: string,
): Promise<WorkInboxItemView> {
  const row = await getWorkInboxItem(database.db, itemId)
  if (row === undefined || row.workKey !== workKey) {
    throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
  }
  return toWorkInboxItemView(row)
}
