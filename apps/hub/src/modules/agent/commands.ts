import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { authorize } from '@whalepod/domain'
import type { Actor } from '@whalepod/domain'
import type { Database, Tx } from '@whalepod/db'
import {
  insertAgent,
  insertProfileRevision,
  setCurrentRevision,
  schema,
  transactCommand,
  unwrapPgError,
} from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { toAgentView, toProfileRevisionView } from './queries.js'
import type { AgentDetailView, ProfileRevisionView } from './queries.js'

export interface ProfileFields {
  persona: string
  provider: string
  model: string
  credentialSlot: string
  maxTokens?: number | null
  pluginPackId: string
}

/**
 * Profile Revision 的规范化 digest（03 §2.3：规范化 JSON 的 SHA-256）。
 * 固定按字典序排列字段键，确保同语义输入必得同 digest（可重算）。
 */
export function computeProfileDigest(input: ProfileFields): string {
  const canonical = JSON.stringify({
    credentialSlot: input.credentialSlot,
    maxTokens: input.maxTokens ?? null,
    model: input.model,
    persona: input.persona,
    pluginPackId: input.pluginPackId,
    provider: input.provider,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function authorizeManageAgent(actor: Actor): void {
  if (!authorize(actor, 'manage_agent', {})) {
    throw new ApiError(403, 'FORBIDDEN', 'only owner or admin can manage agents')
  }
}

/** 校验 Plugin Pack 存在（FK 之外显式检查，给出 404 而非裸 FK 错误）。 */
async function requirePluginPack(tx: Tx, pluginPackId: string): Promise<void> {
  const [pack] = await tx
    .select({ id: schema.pluginPacks.id })
    .from(schema.pluginPacks)
    .where(eq(schema.pluginPacks.id, pluginPackId))
  if (pack === undefined) throw new ApiError(404, 'NOT_FOUND', 'plugin pack not found')
}

export interface CreateAgentInput extends ProfileFields {
  name: string
  description?: string
  createdBy: string
  idempotencyKey: string
}

/**
 * 创建 Agent（02 Task 6 Step 4）：Owner/Admin；单事务内插 Agent + 首个 Revision（revision=1）
 * 并回填 currentRevisionId（03 §2.3）。name 唯一冲突映射 409。
 * Agent 变更不经 Team Event 广播（03 §5 的 8 类事件无 agent），Web 经 GET /agents 拉取。
 */
export async function createAgent(
  database: Database,
  actor: Actor,
  input: CreateAgentInput,
): Promise<AgentDetailView> {
  authorizeManageAgent(actor)
  const agentId = uuidv7()
  const revisionId = uuidv7()
  const profileDigest = computeProfileDigest(input)
  try {
    return await transactCommand(database, `agent.create:${input.idempotencyKey}`, async (tx) => {
      await requirePluginPack(tx, input.pluginPackId)
      const agent = await insertAgent(tx, {
        id: agentId,
        name: input.name,
        description: input.description ?? '',
        createdBy: input.createdBy,
      })
      const revision = await insertProfileRevision(tx, {
        id: revisionId,
        agentId: agent.id,
        revision: 1,
        persona: input.persona,
        provider: input.provider,
        model: input.model,
        credentialSlot: input.credentialSlot,
        ...(input.maxTokens !== undefined && input.maxTokens !== null
          ? { maxTokens: input.maxTokens }
          : {}),
        pluginPackId: input.pluginPackId,
        profileDigest,
        createdBy: input.createdBy,
      })
      await setCurrentRevision(tx, agent.id, revision.id)
      return {
        ...toAgentView(agent),
        currentRevisionId: revision.id,
        currentRevision: toProfileRevisionView(revision),
        revisions: [toProfileRevisionView(revision)],
      }
    })
  } catch (error) {
    const pg = unwrapPgError(error)
    if (pg?.code === '23505' && (pg.constraintName ?? '').includes('agent_name')) {
      throw new ApiError(409, 'CONFLICT', 'agent name already taken')
    }
    throw error
  }
}

export interface CreateProfileRevisionInput extends ProfileFields {
  agentId: string
  createdBy: string
  idempotencyKey: string
}

/**
 * 新建不可变 Profile Revision（02 Task 6 Step 4）：Owner/Admin；revision 从 1 单调递增。
 * 锁 Agent 行串行化 revision 编号分配；不可变 Revision 不影响已运行 Run（Run 只存 revision id+digest）。
 */
export async function createProfileRevision(
  database: Database,
  actor: Actor,
  input: CreateProfileRevisionInput,
): Promise<ProfileRevisionView> {
  authorizeManageAgent(actor)
  const revisionId = uuidv7()
  const profileDigest = computeProfileDigest(input)
  return transactCommand(database, `agent.revision:${input.idempotencyKey}`, async (tx) => {
    // 锁 Agent 行串行化 revision 编号；archived Agent 拒绝新建 Revision。
    const [agent] = await tx
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.agentId))
      .for('update')
    if (agent === undefined) throw new ApiError(404, 'NOT_FOUND', 'agent not found')
    if (agent.archivedAt !== null) throw new ApiError(409, 'CONFLICT', 'agent is archived')
    await requirePluginPack(tx, input.pluginPackId)
    // 当前最大 revision 号（revision 单调递增，无间隔）。
    const [latest] = await tx
      .select({ revision: schema.agentProfileRevisions.revision })
      .from(schema.agentProfileRevisions)
      .where(eq(schema.agentProfileRevisions.agentId, input.agentId))
      .orderBy(desc(schema.agentProfileRevisions.revision))
      .limit(1)
    const nextRevision = (latest?.revision ?? 0) + 1
    const revision = await insertProfileRevision(tx, {
      id: revisionId,
      agentId: input.agentId,
      revision: nextRevision,
      persona: input.persona,
      provider: input.provider,
      model: input.model,
      credentialSlot: input.credentialSlot,
      ...(input.maxTokens !== undefined && input.maxTokens !== null
        ? { maxTokens: input.maxTokens }
        : {}),
      pluginPackId: input.pluginPackId,
      profileDigest,
      createdBy: input.createdBy,
    })
    await setCurrentRevision(tx, input.agentId, revision.id)
    return toProfileRevisionView(revision)
  })
}
