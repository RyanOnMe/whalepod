/**
 * Agent 管理入口（02 Task 7 Step 5）：列表 + 详情；Owner/Admin 可创建，
 * Member 只读（AgentList 内按 session.role 呈现）。
 *
 * #167：页面标题只留一个。此前这里是 `<h1>Agent 管理</h1>`，而 AgentList 紧接着
 * 又写 `<h2>Agents</h2>`——同一屏两个同义标题（截图上是两行意思差不多的字）。现在
 * 页面标题归 h1（文案取主导航同一套：「Agents」是 CONTEXT.md 的正式领域词，按
 * 仓库口径保留英文，不译成「代理」），AgentList 的 <section> 用 aria-labelledby
 * 引用它当区域名；「新建 Agent」表单自带 h3，标题层级 h1 → h3 不断档。
 */
import type { ReactNode } from 'react'
import { AgentList } from '../features/agent/AgentList.js'
import { useSession } from '../app/session.js'

export function AgentsPage(): ReactNode {
  const session = useSession()
  return (
    <div className="agents-page">
      <h1 id="agents-page-heading">Agents</h1>
      <AgentList session={session} />
    </div>
  )
}
