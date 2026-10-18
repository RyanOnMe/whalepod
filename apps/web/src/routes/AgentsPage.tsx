/** Agent management surface. AgentList owns its shared page header and creation action. */
import type { ReactNode } from 'react'
import { AgentList } from '../features/agent/AgentList.js'
import { useSession } from '../app/session.js'

export function AgentsPage(): ReactNode {
  const session = useSession()
  return (
    <div className="agents-page secondary-page">
      <AgentList session={session} />
    </div>
  )
}
