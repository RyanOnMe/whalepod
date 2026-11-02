import {
  countWorkInboxItemsByStatus,
  getLatestPendingInboxItemForSource,
  getLatestWorkInboxItem,
  getRetractedInboxItemForSource,
  getTask,
  getWorkByKey,
  getWorkInboxItem,
  getWorkInboxItemByIdentity,
  getWorkInboxItemForUpdate,
  insertWorkInboxItem,
  retractInboxItemsForSource,
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
    deliveryRunId: row.deliveryRunId ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    unconfirmedAt: row.unconfirmedAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    statusAt: row.statusAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function clampTitle(title: string, fallback: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return fallback
  // 按码点累积、按 UTF-16 长度封顶：既不会切半个代理对，也不会超过 view schema 的 200。
  let result = ''
  for (const character of Array.from(trimmed)) {
    if (result.length + character.length > MAX_TITLE_LENGTH) break
    result += character
  }
  return result
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

      // 撤权是来源级的：该来源任一条目被 retract 后，后续版本不得重新入箱。
      // 不能只看 latest：latest 可能是 expired/superseded，早先的 retracted 仍是停投依据。
      const retracted = await getRetractedInboxItemForSource(
        tx,
        work.id,
        source.sourceType,
        source.sourceId,
      )
      if (retracted !== undefined) {
        throw new ApiError(409, 'CONFLICT', 'source was retracted for this work', {
          reason: 'source_retracted',
          sourceId: source.sourceId,
        })
      }

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
      if (item.status === 'consumed') {
        throw new ApiError(409, 'CONFLICT', 'consumed work input cannot be retracted')
      }
      const now = deps.now()
      const statusReason = reason ?? 'retracted'
      const updated = await retractInboxItemsForSource(tx, {
        workId: item.workId,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        statusReason,
        now,
      })
      const retractedTarget = updated.find((row) => row.id === item.id)
      if (retractedTarget !== undefined) return toWorkInboxItemView(retractedTarget)
      if (item.status === 'retracted') return toWorkInboxItemView(item)
      // 目标已是 expired/superseded 时仍要留下来源级 tombstone：显式置 retracted。
      const overridden = await updateWorkInboxItem(tx, item.id, {
        status: 'retracted',
        statusReason,
        returnReason: null,
        returnNote: null,
        statusAt: now,
        updatedAt: now,
      })
      if (overridden === undefined) throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
      return toWorkInboxItemView(overridden)
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

async function readInboxView(
  tx: Tx,
  work: WorkRow,
  filter: { readonly status?: WorkInboxItemStatus | undefined; readonly limit: number },
): Promise<WorkInboxView> {
  const [items, counts, latest] = await Promise.all([
    listWorkInboxItems(tx, work.id, filter.limit, filter.status),
    countWorkInboxItemsByStatus(tx, work.id),
    getLatestWorkInboxItem(tx, work.id),
  ])
  return {
    items: items.map(toWorkInboxItemView),
    watermarks: {
      // 水位不随筛选变化：客户端用 lastItemAt 判断是否有新条目。
      lastItemAt: latest?.createdAt.toISOString() ?? null,
      pendingCount: counts.pending ?? 0,
      deliveredCount: counts.delivered ?? 0,
      unconfirmedCount: counts.unconfirmed ?? 0,
      consumedCount: counts.consumed ?? 0,
    },
  }
}

/**
 * 私有列表：当前 assignee 校验与条目读取必须在同一 REPEATABLE READ 快照内，
 * 避免“授权通过后、读列表前被改派”的 TOCTOU。事务只读，不使用 FOR UPDATE。
 */
export async function loadWorkInboxForActor(
  database: Database,
  actorUserId: string,
  workKey: string,
  filter: { readonly status?: WorkInboxItemStatus | undefined; readonly limit: number },
): Promise<WorkInboxView> {
  return database.transaction(
    async (tx) => {
      const work = await getWorkByKey(tx, workKey)
      if (work === undefined) throw new ApiError(404, 'NOT_FOUND', 'work not found')
      const task = await getTask(tx, work.taskId)
      if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
      await requireAssignee(tx, task, actorUserId)
      return readInboxView(tx, work, filter)
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

/**
 * 幂等重放时回读当前状态。必须先重新授权：命令命中回执时不会执行命令体里的
 * assignee 校验；若直接按 workKey 回读，改派后的旧 assignee 能借旧 key 继续读私有正文。
 */
export async function refreshWorkInboxItemForActor(
  database: Database,
  actorUserId: string,
  workKey: string,
  itemId: string,
): Promise<WorkInboxItemView> {
  return database.transaction(async (tx) => {
    const { work, task } = await lockWorkContext(tx, workKey)
    await requireAssignee(tx, task, actorUserId)
    const row = await getWorkInboxItem(tx, itemId)
    if (row === undefined || row.workId !== work.id) {
      throw new ApiError(404, 'NOT_FOUND', 'inbox item not found')
    }
    return toWorkInboxItemView(row)
  })
}
