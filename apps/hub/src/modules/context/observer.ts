/**
 * ADR-0025 §9：`hub.context` 的 `context.entry_recorded` 观测面。
 *
 * 投影发生在业务事务内，日志必须等事务提交后再写——回滚的事务不能留下一条指向
 * 不存在 entry 的观测行。因此投影函数只返回「记录了什么」，由调用方在提交后
 * 通过 `ContextEntryObserver` 交给 HTTP logger 或后台日志通道。
 */
import type { ContextEntryRow } from '@whalepod/db'

/** 只含不透明 id、类型、状态与时间；不含正文、凭据或绝对路径。 */
export interface RecordedContextEntry {
  readonly entryId: string
  readonly projectId: string
  readonly kind: ContextEntryRow['kind']
  readonly status: ContextEntryRow['status']
  readonly businessRef: string
  readonly businessVersion: string
  readonly occurredAt: string
}

export type ContextEntryObserver = (event: RecordedContextEntry) => void

/** 读面/投影的通用日志口径：component + action 固定，其余字段由事件给出。 */
export function logRecordedEntry(
  logger: { info: (fields: Record<string, unknown>, message: string) => void },
  event: RecordedContextEntry,
): void {
  logger.info(
    {
      component: 'hub.context',
      action: 'context.entry_recorded',
      entryId: event.entryId,
      projectId: event.projectId,
      kind: event.kind,
      status: event.status,
      businessRef: event.businessRef,
      businessVersion: event.businessVersion,
      occurredAt: event.occurredAt,
    },
    'context entry recorded',
  )
}

export function toRecordedEntry(
  entry: ContextEntryRow,
  occurredAt: Date,
): RecordedContextEntry | undefined {
  if (entry.businessRef === null || entry.businessVersion === null) return undefined
  return {
    entryId: entry.id,
    projectId: entry.projectId,
    kind: entry.kind,
    status: entry.status,
    businessRef: entry.businessRef,
    businessVersion: entry.businessVersion,
    occurredAt: occurredAt.toISOString(),
  }
}
