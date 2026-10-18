/**
 * 共享事件分页读取（P1-393；ADR-0019 决定 5）。
 *
 * 会话、审批与 Console 共用同一条读取：`GET /runs/:id/events?after=<maxSeq>&limit=500`
 * 续读至不足一页。服务端 `listRunEvents` 是「先按受众与 after 过滤、再按 seq 升序分页」，
 * 所以一页永远是本人可见流的前缀，游标安全；**受众过滤造成的 seq 空隙不是丢帧**
 * （同一事实的 owner/project 两行各占一个 seq，另一行的 seq 在本人流里本来就不可见）。
 *
 * 失败语义：任何一页失败都保留已读内容并返回 `complete: false` —— 调用方必须把
 * 「没读完」与「没有记录」分开呈现（排障界面尤其不能说假话）。
 */
import type { RunEventItem } from '../../shared/api/types.js'

/** 服务端上限（apps/hub `/runs/:id/events` 的 `Math.min(limit, 500)`）。 */
export const RUN_EVENT_PAGE_LIMIT = 500
/** 最多并发读取的运行数：首屏 20 段，全部同时开拉会把 Hub 与浏览器打爆。 */
export const RUN_EVENT_FETCH_CONCURRENCY = 4

export interface RunEventWindow {
  readonly events: readonly RunEventItem[]
  /** 已读到末尾（最后一页不足一页）。false = 还没读完或中途失败。 */
  readonly complete: boolean
}

function identityOf(item: RunEventItem): string {
  return `${item.runId}:${item.audience}:${item.seq}`
}

/** 身份去重（跨页重复帧）+ 按 (runId, seq) 排序，保证续读拼接后仍是确定顺序。 */
function mergeEvents(events: readonly RunEventItem[]): RunEventItem[] {
  const unique = new Map<string, RunEventItem>()
  for (const item of events) {
    if (!Number.isSafeInteger(item.seq) || item.seq <= 0) continue
    const key = identityOf(item)
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()].sort((a, b) =>
    a.runId === b.runId ? a.seq - b.seq : a.runId.localeCompare(b.runId),
  )
}

/**
 * 读一个运行的事件到末尾。`fetchPage(after)` 返回一页（≤ RUN_EVENT_PAGE_LIMIT 条）；
 * `onProgress` 会在每一页后拿到当前累计结果（调用方用于让已读内容立刻可见）。
 * 不抛错：失败在返回值里表达（`complete: false`），已读内容照常带回。
 */
export async function readRunEventsToEnd(
  fetchPage: (after: number | undefined) => Promise<readonly RunEventItem[]>,
  onProgress?: (events: readonly RunEventItem[]) => void,
): Promise<RunEventWindow> {
  let collected: RunEventItem[] = []
  let after: number | undefined = undefined
  for (;;) {
    let page: readonly RunEventItem[]
    try {
      page = await fetchPage(after)
    } catch {
      return { events: mergeEvents(collected), complete: false }
    }
    collected = collected.concat(page)
    const merged = mergeEvents(collected)
    onProgress?.(merged)
    if (page.length < RUN_EVENT_PAGE_LIMIT) return { events: merged, complete: true }
    const maxSeq = page.reduce((max, item) => Math.max(max, item.seq), 0)
    // 无进展的整页（游标没前进）与重连边界重放都停在这里，不空转（也绝不谎报 complete）。
    if (after !== undefined && maxSeq <= after) return { events: merged, complete: false }
    after = maxSeq
  }
}

/**
 * 并发准入：在途 = 已准入但还没读完的运行；有空闲名额就按优先级（`order` 的顺序）
 * 补位，返回本次新准入的运行 id 列表（已准入的不重复返回）。
 */
export function admitRuns(
  order: readonly string[],
  admitted: readonly string[],
  settled: readonly string[],
  limit: number = RUN_EVENT_FETCH_CONCURRENCY,
): readonly string[] {
  const settledSet = new Set(settled)
  const admittedSet = new Set(admitted)
  const inFlight = admitted.filter((id) => !settledSet.has(id)).length
  const free = Math.max(0, limit - inFlight)
  if (free === 0) return []
  const next: string[] = []
  for (const id of order) {
    if (next.length >= free) break
    if (admittedSet.has(id)) continue
    next.push(id)
  }
  return next
}
