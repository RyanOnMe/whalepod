/**
 * 运行段读取（P1-393；ADR-0019 决定 5/6）。
 *
 * 连续对话里每个可见段都要「运行详情 + 全量事件」，但首屏可能有 20 段——所以：
 * - 事件走共享分页读取（`readRunEventsToEnd`，每页 500 条读到最后），缓存键
 *   `queryKeys.runEventPages` 保留 `['run', runId]` 前缀，实时失效照常命中；
 * - **最多并发读取 4 个运行**（`admitRuns` 的准入），优先活跃运行、其余最新在前；
 * - 读取过程把已读内容立刻写进缓存（`onProgress`），分页失败时这部分仍然可见。
 *
 * 缓存共享：`queryKeys.run(runId)` 与 composer 的来源校验、`runEventPages` 与 Console
 * 是同一个键——同一运行不会因为两处消费而多打一遍接口。
 */
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import type { RunEventItem, RunView, TaskRoomRun } from '../../shared/api/types.js'
import {
  RUN_EVENT_FETCH_CONCURRENCY,
  RUN_EVENT_PAGE_LIMIT,
  admitRuns,
  readRunEventsToEnd,
} from '../../shared/realtime/run-event-pages.js'
import { conversationReadOrder } from './conversation.js'

export type RunEventStatus = 'pending' | 'complete' | 'incomplete'

export interface RunRead {
  readonly detail: RunView | undefined
  readonly events: readonly RunEventItem[]
  readonly eventsStatus: RunEventStatus
  readonly retry: () => void
}

export interface RunEventWindowRead {
  readonly events: readonly RunEventItem[]
  readonly status: RunEventStatus
  readonly retry: () => void
}

/**
 * 分页事件查询选项（会话与 Console 共用同一键）。验收要点：
 * `after` 使用本页最大 seq、`limit` 固定 500、进度即时可见、失败不抛错。
 */
export function runEventsQueryOptions(runId: string, queryClient: QueryClient) {
  const key = queryKeys.runEventPages(runId)
  return {
    queryKey: key,
    queryFn: async () => {
      return await readRunEventsToEnd(
        async (after) => {
          const query = new URLSearchParams({ limit: String(RUN_EVENT_PAGE_LIMIT) })
          if (after !== undefined) query.set('after', String(after))
          const page = await api.get<{ events: RunEventItem[] }>(
            `/runs/${runId}/events?${query.toString()}`,
          )
          return page.events
        },
        (events) => {
          // 已读内容立刻可见；最终结果（complete）由 queryFn 返回时覆盖。
          queryClient.setQueryData(key, { events, complete: false })
        },
      )
    },
  }
}

function statusOf(query: {
  isPending: boolean
  data: { complete: boolean } | undefined
}): RunEventStatus {
  if (query.isPending) return 'pending'
  return query.data?.complete === true ? 'complete' : 'incomplete'
}

/** 单个运行的事件窗口（Run Console 的取数口；缓存与对话共享）。 */
export function useRunEventWindow(runId: string | undefined): RunEventWindowRead {
  const queryClient = useQueryClient()
  const query = useQuery({
    ...runEventsQueryOptions(runId ?? '', queryClient),
    enabled: runId !== undefined,
  })
  return {
    events: query.data?.events ?? [],
    status: runId === undefined ? 'pending' : statusOf(query),
    retry: () => void query.refetch(),
  }
}

/**
 * 可见运行的读取窗口：按准入顺序渐进取数。
 * 返回 Map 覆盖**全部**传入运行——未准入的运行以 `pending` 呈现（不是"没有事件"）。
 */
export function useRunReads(runs: readonly TaskRoomRun[]): ReadonlyMap<string, RunRead> {
  const queryClient = useQueryClient()
  const order = useMemo(() => conversationReadOrder(runs), [runs])
  const orderKey = order.join('|')
  const [admitted, setAdmitted] = useState<readonly string[]>(() =>
    order.slice(0, RUN_EVENT_FETCH_CONCURRENCY),
  )
  const admittedSet = useMemo(() => new Set(admitted), [admitted])

  const details = useQueries({
    queries: runs.map((run) => ({
      queryKey: queryKeys.run(run.id),
      queryFn: () => api.get<RunView>(`/runs/${run.id}`),
      enabled: admittedSet.has(run.id),
      refetchOnMount: 'always' as const,
    })),
  })
  const eventQueries = useQueries({
    queries: runs.map((run) => ({
      ...runEventsQueryOptions(run.id, queryClient),
      enabled: admittedSet.has(run.id),
    })),
  })

  // 已准入且两条读都落地的运行 = 读完（含失败）；据此把空闲名额让给后面排队的运行。
  const settled = runs
    .map((run, index) =>
      admittedSet.has(run.id) && !details[index]!.isPending && !eventQueries[index]!.isPending
        ? run.id
        : null,
    )
    .filter((id): id is string => id !== null)
  const settledKey = settled.join('|')

  useEffect(() => {
    const next = admitRuns(order, admitted, settled, RUN_EVENT_FETCH_CONCURRENCY)
    if (next.length > 0) setAdmitted((previous) => [...previous, ...next])
  }, [orderKey, admitted, settledKey])

  // 每次渲染重建 Map 是廉价的（≤ 窗口段数）；useMemo 的依赖哈希反而更容易漏掉状态翻转。
  const reads = new Map<string, RunRead>()
  runs.forEach((run, index) => {
    const detail = details[index]
    const events = eventQueries[index]
    reads.set(run.id, {
      detail: detail?.data,
      events: events?.data?.events ?? [],
      eventsStatus: events === undefined ? 'pending' : statusOf(events),
      retry: () => {
        void detail?.refetch()
        void events?.refetch()
      },
    })
  })
  return reads
}
