/**
 * ADR-0025 §1：业务事实 → 项目事实账本的唯一投影入口。
 *
 * 投影必须在**既有业务事务内**调用（Task 约定确认、成果发布、交接接收确认、
 * Run 终态），与业务行同事务提交；不依赖事件补发或重放。模型/协调帧没有
 * Decision/Correction 写入口。
 */
import type { Tx } from '@whalepod/db'
import {
  findActiveDecisionForUpdate,
  findContextEntryByBusinessVersion,
  insertContextCitation,
  insertContextEntry,
  insertObservationIfAbsent,
  updateContextEntry,
  type ContextEntryRow,
} from '@whalepod/db'
import { uuidv7 } from '../shared/uuid.js'

const CONTEXT_TITLE_MAX = 200
/** DB 约束是 octet_length(body) <= 65536；留出余量并按 UTF-8 字节裁剪。 */
const CONTEXT_BODY_MAX_BYTES = 65_000

/** 标题按 Unicode 码点裁剪（不用 UTF-16 下标，避免把 emoji 的代理对切一半）。 */
export function clipContextText(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/** 多字节内容的合法边界：按 UTF-8 字节裁剪，绝不拆代理对。 */
export function clipContextBody(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= CONTEXT_BODY_MAX_BYTES) return text
  const ellipsis = '…'
  const budget = CONTEXT_BODY_MAX_BYTES - Buffer.byteLength(ellipsis, 'utf8')
  let used = 0
  let end = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (used + bytes > budget) break
    used += bytes
    end += char.length
  }
  return `${text.slice(0, end)}${ellipsis}`
}

export interface BusinessFactInput {
  readonly projectId: string
  readonly businessRef: string
  readonly businessVersion: string
  readonly title: string
  readonly body: string
  readonly occurredAt: Date
  readonly payload?: Record<string, unknown>
}

export interface BusinessDecisionInput extends BusinessFactInput {
  readonly actorUserId: string
}

function normalized(input: BusinessFactInput): {
  title: string
  body: string
  payload: Record<string, unknown>
} {
  return {
    title: clipContextText(input.title.trim(), CONTEXT_TITLE_MAX),
    body: clipContextBody(input.body),
    payload: input.payload ?? {},
  }
}

/**
 * Decision 只由既有业务事务投影：同 businessRef 的旧 active 行标 superseded，
 * 同 businessRef+businessVersion 幂等；被纠正行不改写。
 *
 * 并发契约：同一 businessRef 的版本推进必须由调用方先锁住业务行（Task/receipt/
 * artifact/run 行）串行化。部分唯一索引 `context_entry_decision_active_unique`
 * 是最后一道兜底：漏锁时败者收到 23505 并整体回滚，不会留下两条 active。
 *
 * `inserted=false` 表示这次调用没有产生新行（幂等回读）；观测日志只记 true 的那次。
 */
export async function projectDecision(
  tx: Tx,
  input: BusinessDecisionInput,
): Promise<{ row: ContextEntryRow; inserted: boolean }> {
  const existing = await findContextEntryByBusinessVersion(
    tx,
    'decision',
    input.businessRef,
    input.businessVersion,
  )
  if (existing !== undefined) return { row: existing, inserted: false }

  const active = await findActiveDecisionForUpdate(tx, input.businessRef)
  if (active !== undefined && active.businessVersion !== input.businessVersion) {
    await updateContextEntry(tx, active.id, { status: 'superseded' })
  }

  const text = normalized(input)
  const entry = await insertContextEntry(tx, {
    id: uuidv7(),
    projectId: input.projectId,
    kind: 'decision',
    status: 'active',
    title: text.title,
    body: text.body,
    payload: text.payload,
    businessRef: input.businessRef,
    businessVersion: input.businessVersion,
    actorKind: 'member',
    createdBy: input.actorUserId,
  })
  await insertContextCitation(tx, {
    entryId: entry.id,
    kind: 'business',
    businessRef: input.businessRef,
    businessVersion: input.businessVersion,
    occurredAt: input.occurredAt,
  })
  return { row: entry, inserted: true }
}

/** Observation 是确定性业务事实（Run 终态等）；同 businessRef+version 幂等。 */
export async function projectObservation(
  tx: Tx,
  input: BusinessFactInput,
): Promise<{ row: ContextEntryRow; inserted: boolean }> {
  const existing = await findContextEntryByBusinessVersion(
    tx,
    'observation',
    input.businessRef,
    input.businessVersion,
  )
  if (existing !== undefined) return { row: existing, inserted: false }

  const text = normalized(input)
  const { row: entry, inserted } = await insertObservationIfAbsent(tx, {
    id: uuidv7(),
    projectId: input.projectId,
    kind: 'observation',
    status: 'active',
    title: text.title,
    body: text.body,
    payload: text.payload,
    businessRef: input.businessRef,
    businessVersion: input.businessVersion,
    actorKind: 'system',
  })
  if (!inserted) return { row: entry, inserted: false }
  await insertContextCitation(tx, {
    entryId: entry.id,
    kind: 'business',
    businessRef: input.businessRef,
    businessVersion: input.businessVersion,
    occurredAt: input.occurredAt,
  })
  return { row: entry, inserted: true }
}
