/**
 * Agent 管理入口（02 Task 7 Step 5）：列表 + 详情；Owner/Admin 可创建，
 * Member 只读（AgentList 内按 session.role 呈现）。
 */
import type { ReactNode } from 'react'
import { AgentList } from '../features/agent/AgentList.js'
import { useSession } from '../app/session.js'

export function AgentsPage(): ReactNode {
  const session = useSession()
  return (
    <div className="agents-page">
      <h1>Agent 管理</h1>
      <AgentList session={session} />
    </div>
  )
}
