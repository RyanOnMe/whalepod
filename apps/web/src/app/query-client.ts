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
  /**
   * #136：成员列表——创建任务的责任人选择器数据源；#141 成员页复用同一键
   * （本分支原带一份重复定义，收编时删除）。
   */
  teamMembers: ['team-members'] as const,
  /** #137：项目内任务列表（离开 Task Room 后找回任务的入口）。 */
  projectTasks: (projectId: string) => ['project-tasks', projectId] as const,
  taskRoom: (taskId: string) => ['task-room', taskId] as const,
  agents: ['agents'] as const,
  agentDetail: (agentId: string) => ['agent-detail', agentId] as const,
  /** P1-13：Run 详情/事件键前缀与 event-router 的 ['run', runId] 失效约定对齐。 */
  run: (runId: string) => ['run', runId] as const,
  runEvents: (runId: string) => ['run', runId, 'events'] as const,
  devices: ['devices'] as const,
  workspaces: ['workspaces'] as const,
  /** P1-17 Admin Plugin Settings：插件目录 / 安装列表 / Pack 列表。 */
  pluginCatalog: ['plugin-catalog'] as const,
  pluginInstallations: ['plugin-installations'] as const,
  pluginPacks: ['plugin-packs'] as const,
  /** #141：邀请接受页的预检（键带 token，接受成功后随成员列表一起失效）。 */
  invite: (token: string) => ['invite', token] as const,
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
