/**
 * Agent 执行者名字解析（#239）。
 *
 * 与成员名（memberDirectory.personOf）同构的问题：id → 显示名。这里与
 * RunLauncher/CreateTaskForm 共用同一 queryKey（queryKeys.agents），一份缓存
 * 全局共享；`agentId` 为 null 时不发请求（member 指派的 Task 不为名字多拉一轮）。
 *
 * 诚实口径：pending 时 pending=true（调用方画加载语，不闪「未知」）；查过但没有
 * 这一行 → 「未知 Agent」（不伪造、不画 id）。
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import type { AgentView } from '../../shared/api/types.js'

export function useAgentName(agentId: string | null): { name: string; pending: boolean } | null {
  const query = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
    enabled: agentId !== null,
  })
  if (agentId === null) return null
  if (query.isPending) return { name: '正在读取 Agent…', pending: true }
  const hit = (query.data ?? []).find((agent) => agent.id === agentId)
  return { name: hit?.name ?? '未知 Agent', pending: false }
}
