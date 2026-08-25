import type { AgentId, ProfileRevisionId } from '@project311/domain'

/**
 * Builder/Reviewer 标准 fixture（P1-02 Issue 交付物）。
 * 对应 04-验收矩阵与测试策略.md 的两个长期 Agent：
 * Builder 产生报告 Artifact；Reviewer 读取已发布 Artifact 并复核。
 * 仅 import type（运行时零依赖），digest 为固定的 64 位十六进制串。
 */
export interface AgentFixture {
  readonly agentId: AgentId
  readonly profileRevisionId: ProfileRevisionId
  readonly name: 'Builder' | 'Reviewer'
  readonly persona: string
  readonly model: string
  /** char(64)，与 Profile Revision 一致。 */
  readonly profileDigest: string
  /** char(64)，与 Plugin Pack 一致。 */
  readonly pluginPackDigest: string
}

export const builderAgent: AgentFixture = {
  agentId: '00000000-0000-4000-8000-00000000b01d' as AgentId,
  profileRevisionId: '00000000-0000-4000-8000-0000000b01d1' as ProfileRevisionId,
  name: 'Builder',
  persona: 'Produces report Artifacts for the Task.',
  model: 'deepseek-chat',
  profileDigest: 'b'.repeat(64),
  pluginPackDigest: 'c'.repeat(64),
}

export const reviewerAgent: AgentFixture = {
  agentId: '00000000-0000-4000-8000-0000000e1e5e' as AgentId,
  profileRevisionId: '00000000-0000-4000-8000-000000e1e5e1' as ProfileRevisionId,
  name: 'Reviewer',
  persona: 'Reviews published Artifacts and returns a redacted summary.',
  model: 'deepseek-chat',
  profileDigest: 'd'.repeat(64),
  pluginPackDigest: 'e'.repeat(64),
}
