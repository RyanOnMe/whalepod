/**
 * 全局 React Query 配置（P1-07）。
 * 失败重试避开会话类错误（401 重试没有意义）；加载器与组件共享
 * 同一 QueryClient，mutation 成功后按 query key 精确失效（02 Task 7 Step 6）。
 * 测试环境传 { retry: false }，让错误立刻呈现（生产默认 2 次退避重试）。
 */
import { QueryClient } from '@tanstack/react-query'
import { isSessionError } from '../shared/api/errors.js'

/** 集中管理的 query key（失效时用同一字面量，避免漂移）。 */
export const queryKeys = {
  setupStatus: ['setup-status'] as const,
  session: ['session'] as const,
  projects: ['projects'] as const,
  taskRoom: (taskId: string) => ['task-room', taskId] as const,
  agents: ['agents'] as const,
  agentDetail: (agentId: string) => ['agent-detail', agentId] as const,
}

function retryLimit(failureCount: number, error: unknown): boolean {
  if (isSessionError(error)) return false
  return failureCount < 2
}

export function makeQueryClient(options: { retry?: boolean } = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: options.retry === false ? false : retryLimit,
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
      mutations: {
        retry: 0,
      },
    },
  })
}
