import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import type { Database, DbHandle, Tx } from './client.js'
import { dispatchOutbox } from './schema/outbox.js'

// Hub → Node 命令的至少一次投递队列（03 §2.6 dispatch_outbox；02 Task 4 Step 5）。
export const OUTBOX_CLAIM_BATCH_LIMIT = 50 as const
export const OUTBOX_BACKOFF_BASE_MS = 250 as const
export const OUTBOX_BACKOFF_CAP_MS = 30_000 as const
export const OUTBOX_JITTER_RATIO = 0.2 as const

export type DispatchOutboxRow = typeof dispatchOutbox.$inferSelect

export interface OutboxCommand {
  /** 即协议 commandId（03 §2.6）。 */
  id: string
  deviceId: string
  type: string
  payload: unknown
}

export interface ClaimedCommand extends OutboxCommand {
  /** claim 之后的 attempt_count（从 1 起）。 */
  attemptCount: number
}

/**
 * 指数退避（02 Task 4 Step 5）：min(30s, 250ms * 2^attempt)，再加 0–20% jitter。
 * jitter 在上限之后叠加，实测值域 [base, base * 1.2]。
 */
export function computeBackoffMs(attemptCount: number, random: () => number = Math.random): number {
  const base = Math.min(OUTBOX_BACKOFF_CAP_MS, OUTBOX_BACKOFF_BASE_MS * 2 ** attemptCount)
  return Math.round(base * (1 + random() * OUTBOX_JITTER_RATIO))
}

function assertClaimLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > OUTBOX_CLAIM_BATCH_LIMIT) {
    throw new RangeError(
      `outbox claim limit must be an integer between 1 and ${OUTBOX_CLAIM_BATCH_LIMIT}`,
    )
  }
}

export interface ClaimOptions {
  limit?: number
  now: Date
  random?: () => number
}

/**
 * 在调用方事务内占有待投命令：FOR UPDATE SKIP LOCKED 让并发 worker 互不重叠。
 * claim 即把 attempt_count +1 并按退避推远 next_attempt_at（可见性超时）：
 * worker 崩溃（不 ack）时，退避到期后该命令会被其他/重启的 worker 重新 claim。
 */
export async function claimInTransaction(tx: Tx, options: ClaimOptions): Promise<ClaimedCommand[]> {
  const limit = options.limit ?? OUTBOX_CLAIM_BATCH_LIMIT
  assertClaimLimit(limit)
  const random = options.random ?? Math.random
  const rows = await tx
    .select()
    .from(dispatchOutbox)
    .where(
      and(
        isNull(dispatchOutbox.ackedAt),
        isNull(dispatchOutbox.failedAt),
        lte(dispatchOutbox.nextAttemptAt, options.now),
      ),
    )
    .orderBy(asc(dispatchOutbox.nextAttemptAt), asc(dispatchOutbox.id))
    .limit(limit)
    .for('update', { skipLocked: true })
  const claimed: ClaimedCommand[] = []
  for (const row of rows) {
    const attemptCount = row.attemptCount + 1
    const nextAttemptAt = new Date(
      options.now.getTime() + computeBackoffMs(row.attemptCount, random),
    )
    await tx
      .update(dispatchOutbox)
      .set({ attemptCount, nextAttemptAt })
      .where(eq(dispatchOutbox.id, row.id))
    claimed.push({
      id: row.id,
      deviceId: row.deviceId,
      type: row.type,
      payload: row.payload,
      attemptCount,
    })
  }
  return claimed
}

export class Outbox {
  private readonly database: Database
  private readonly nowFn: () => Date
  private readonly randomFn: () => number

  constructor(database: Database, options: { now?: () => Date; random?: () => number } = {}) {
    this.database = database
    this.nowFn = options.now ?? (() => new Date())
    this.randomFn = options.random ?? Math.random
  }

  /**
   * 在命令事务内入队，与领域状态、Team Event、命令回执原子提交（02 Task 4 Step 4）。
   * 重复 commandId 直接撞主键（23505），视为编程错误抛出。
   */
  async enqueue(tx: Tx, command: OutboxCommand & { notBefore?: Date }): Promise<void> {
    const [row] = await tx
      .insert(dispatchOutbox)
      .values({
        id: command.id,
        deviceId: command.deviceId,
        type: command.type,
        payload: command.payload,
        ...(command.notBefore !== undefined ? { nextAttemptAt: command.notBefore } : {}),
      })
      .returning({ id: dispatchOutbox.id })
    if (row === undefined) throw new Error('enqueue returned no row')
  }

  /** 单次最多 50 条；返回的命令已由本 worker 占有（attempt_count 已 +1）。 */
  async claim(limit: number = OUTBOX_CLAIM_BATCH_LIMIT): Promise<ClaimedCommand[]> {
    assertClaimLimit(limit)
    const now = this.nowFn()
    const random = this.randomFn
    return this.database.transaction((tx) => claimInTransaction(tx, { limit, now, random }))
  }

  /** 幂等：已 ack 或已 fail 的行返回 false，不报错。 */
  async ack(id: string): Promise<boolean> {
    const rows = await this.database.db
      .update(dispatchOutbox)
      .set({ ackedAt: this.nowFn() })
      .where(
        and(
          eq(dispatchOutbox.id, id),
          isNull(dispatchOutbox.ackedAt),
          isNull(dispatchOutbox.failedAt),
        ),
      )
      .returning({ id: dispatchOutbox.id })
    return rows.length > 0
  }

  /** 不可恢复失败（终态），幂等；已 ack 的行返回 false。 */
  async fail(id: string): Promise<boolean> {
    const rows = await this.database.db
      .update(dispatchOutbox)
      .set({ failedAt: this.nowFn() })
      .where(
        and(
          eq(dispatchOutbox.id, id),
          isNull(dispatchOutbox.failedAt),
          isNull(dispatchOutbox.ackedAt),
        ),
      )
      .returning({ id: dispatchOutbox.id })
    return rows.length > 0
  }
}

// ---------- P1-10：orchestrator/worker 需要的事务内变体与按 Run 查询 ----------

/** 按 commandId 读 Outbox 行（worker/ingest 判断命令类型与归属）。 */
export async function getOutboxCommand(
  handle: DbHandle,
  id: string,
): Promise<DispatchOutboxRow | undefined> {
  const [row] = await handle.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, id)).limit(1)
  return row
}

export interface OutboxRunQuery {
  runId: string
  /** 限定命令类型（如 'run.start'）。 */
  type?: string
  /** 只看未 ack 未 fail 的待投行。 */
  pendingOnly?: boolean
}

/** 按 payload->>'runId' 查命令（dispatch 命令的 payload 必含 runId，03 §6.3）。 */
export async function findOutboxCommandsForRun(
  handle: DbHandle,
  query: OutboxRunQuery,
): Promise<DispatchOutboxRow[]> {
  return handle
    .select()
    .from(dispatchOutbox)
    .where(
      and(
        sql`${dispatchOutbox.payload}->>'runId' = ${query.runId}`,
        query.type !== undefined ? eq(dispatchOutbox.type, query.type) : undefined,
        query.pendingOnly === true
          ? and(isNull(dispatchOutbox.ackedAt), isNull(dispatchOutbox.failedAt))
          : undefined,
      ),
    )
    .orderBy(asc(dispatchOutbox.nextAttemptAt), asc(dispatchOutbox.id))
}

/** ack 的事务内版本：与 Run 状态迁移同事务提交（02 Task 10 Step 5 派发确认）。 */
export async function ackInTransaction(tx: Tx, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(dispatchOutbox)
    .set({ ackedAt: now })
    .where(
      and(
        eq(dispatchOutbox.id, id),
        isNull(dispatchOutbox.ackedAt),
        isNull(dispatchOutbox.failedAt),
      ),
    )
    .returning({ id: dispatchOutbox.id })
  return rows.length > 0
}

/** fail 的事务内版本：用于取消 queued Run 时在同一事务内作废待投的 run.start。 */
export async function failInTransaction(tx: Tx, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(dispatchOutbox)
    .set({ failedAt: now })
    .where(
      and(
        eq(dispatchOutbox.id, id),
        isNull(dispatchOutbox.failedAt),
        isNull(dispatchOutbox.ackedAt),
      ),
    )
    .returning({ id: dispatchOutbox.id })
  return rows.length > 0
}
