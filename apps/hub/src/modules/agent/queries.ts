import type { AgentRow, ProfileRevisionRow } from '@project311/db'
import {
  getAgent,
  getProfileRevision,
  listAgents,
  listProfileRevisionsByAgent,
} from '@project311/db'
import type { DbHandle } from '@project311/db'

/** Profile Revision 的 JSON 视图（03 §2.3；时间为 ISO 字符串）。 */
export interface ProfileRevisionView {
  id: string
  agentId: string
  revision: number
  persona: string
  provider: string
  model: string
  credentialSlot: string
  maxTokens: number | null
  pluginPackId: string
  profileDigest: string
  createdBy: string
  createdAt: string
}

export function toProfileRevisionView(row: ProfileRevisionRow): ProfileRevisionView {
  return {
    id: row.id,
    agentId: row.agentId,
    revision: row.revision,
    persona: row.persona,
    provider: row.provider,
    model: row.model,
    credentialSlot: row.credentialSlot,
    maxTokens: row.maxTokens,
    pluginPackId: row.pluginPackId,
    profileDigest: row.profileDigest,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Agent 的 JSON 视图（03 §2.3；agent 表无 created_at，故视图亦无）。 */
export interface AgentView {
  id: string
  name: string
  description: string
  createdBy: string
  archivedAt: string | null
  currentRevisionId: string | null
}

export function toAgentView(row: AgentRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    currentRevisionId: row.currentRevisionId,
  }
}

export interface AgentDetailView extends AgentView {
  currentRevision: ProfileRevisionView | null
  revisions: ProfileRevisionView[]
}

export async function getAgentDetailView(
  handle: DbHandle,
  id: string,
): Promise<AgentDetailView | undefined> {
  const agent = await getAgent(handle, id)
  if (agent === undefined) return undefined
  const revisions = (await listProfileRevisionsByAgent(handle, id)).map(toProfileRevisionView)
  let currentRevision: ProfileRevisionView | null = null
  if (agent.currentRevisionId !== null) {
    const row = await getProfileRevision(handle, agent.currentRevisionId)
    currentRevision = row === undefined ? null : toProfileRevisionView(row)
  }
  return { ...toAgentView(agent), currentRevision, revisions }
}

export async function listAgentViews(handle: DbHandle): Promise<AgentView[]> {
  return (await listAgents(handle)).map(toAgentView)
}
