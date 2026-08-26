import { asc, eq, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { agentProfileRevisions, agents } from '../schema/agent.js'

export type AgentRow = typeof agents.$inferSelect
export type ProfileRevisionRow = typeof agentProfileRevisions.$inferSelect

export interface NewAgent {
  id: string
  name: string
  description?: string
  createdBy: string
}

export async function insertAgent(handle: DbHandle, agent: NewAgent): Promise<AgentRow> {
  const [row] = await handle
    .insert(agents)
    .values({
      id: agent.id,
      name: agent.name,
      description: agent.description ?? '',
      createdBy: agent.createdBy,
    })
    .returning()
  if (row === undefined) throw new Error('insert agent returned no row')
  return row
}

export async function getAgent(handle: DbHandle, id: string): Promise<AgentRow | undefined> {
  const [row] = await handle.select().from(agents).where(eq(agents.id, id)).limit(1)
  return row
}

/** 未归档 Agent 列表（按 id 升序；id 为 UUIDv7，等价创建顺序；03 §2.3）。 */
export async function listAgents(handle: DbHandle): Promise<AgentRow[]> {
  return handle.select().from(agents).where(isNull(agents.archivedAt)).orderBy(asc(agents.id))
}

/** 回填 Agent.currentRevisionId（建 Agent 时同事务先插 Revision 再回填）。 */
export async function setCurrentRevision(
  handle: DbHandle,
  agentId: string,
  revisionId: string,
): Promise<AgentRow | undefined> {
  const [row] = await handle
    .update(agents)
    .set({ currentRevisionId: revisionId })
    .where(eq(agents.id, agentId))
    .returning()
  return row
}

export interface NewProfileRevision {
  id: string
  agentId: string
  revision: number
  persona: string
  provider: string
  model: string
  credentialSlot: string
  maxTokens?: number | null
  pluginPackId: string
  profileDigest: string
  createdBy: string
}

export async function insertProfileRevision(
  handle: DbHandle,
  revision: NewProfileRevision,
): Promise<ProfileRevisionRow> {
  const [row] = await handle
    .insert(agentProfileRevisions)
    .values({
      id: revision.id,
      agentId: revision.agentId,
      revision: revision.revision,
      persona: revision.persona,
      provider: revision.provider,
      model: revision.model,
      credentialSlot: revision.credentialSlot,
      ...(revision.maxTokens !== undefined && revision.maxTokens !== null
        ? { maxTokens: revision.maxTokens }
        : {}),
      pluginPackId: revision.pluginPackId,
      profileDigest: revision.profileDigest,
      createdBy: revision.createdBy,
    })
    .returning()
  if (row === undefined) throw new Error('insert profile revision returned no row')
  return row
}

export async function getProfileRevision(
  handle: DbHandle,
  id: string,
): Promise<ProfileRevisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(agentProfileRevisions)
    .where(eq(agentProfileRevisions.id, id))
    .limit(1)
  return row
}

/** 某 Agent 的全部 Revision（按 revision 升序；03 §2.3 单调递增）。 */
export async function listProfileRevisionsByAgent(
  handle: DbHandle,
  agentId: string,
): Promise<ProfileRevisionRow[]> {
  return handle
    .select()
    .from(agentProfileRevisions)
    .where(eq(agentProfileRevisions.agentId, agentId))
    .orderBy(asc(agentProfileRevisions.revision))
}
