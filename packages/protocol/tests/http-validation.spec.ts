/**
 * HTTP 请求 schema 的**负例**判据（roundtrip 只证明合法 fixture 能过，证明不了
 * 畸形请求会被拒）。这里钉的是跨字段的 fail-closed 约束：
 *   - create-run：`rerunOfRunId` 与 `resumeFromRunId` 互斥（切片⑤ #237）；
 *   - create-task / reassign-task：`assigneeUserId` 与 `assigneeAgentId` 恰好其一（#239）。
 * 单字段自身的 min/max/uuid 由 zod 定义直接保证，不在此重复。
 */
import { describe, expect, it } from 'vitest'
import {
  CreateRunRequestSchema,
  CreateTaskRequestSchema,
  ReassignTaskRequestSchema,
} from '../src/index.js'

const AGENT_ID = '01905f7c-0000-7000-8000-0000000004a1'
const USER_ID = '01905f7c-0000-7000-8000-000000000201'
const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const BASE_RUN = {
  agentId: AGENT_ID,
  deviceId: '01905f7c-0000-7000-8000-000000000501',
  workspaceId: '01905f7c-0000-7000-8000-000000000601',
  prompt: 'do it',
} as const

describe('CreateRunRequestSchema（rerun/resume 互斥，#237）', () => {
  it('双带 rerunOfRunId + resumeFromRunId → 拒绝', () => {
    expect(() =>
      CreateRunRequestSchema.parse({
        ...BASE_RUN,
        rerunOfRunId: RUN_ID,
        resumeFromRunId: RUN_ID,
      }),
    ).toThrow()
  })

  it('各带其一 → 接受', () => {
    expect(CreateRunRequestSchema.parse({ ...BASE_RUN, rerunOfRunId: RUN_ID }).rerunOfRunId).toBe(
      RUN_ID,
    )
    expect(
      CreateRunRequestSchema.parse({ ...BASE_RUN, resumeFromRunId: RUN_ID }).resumeFromRunId,
    ).toBe(RUN_ID)
  })
})

describe('CreateTaskRequestSchema（assignee 二选一，#239）', () => {
  const BASE = { title: '把登录页改成深色' } as const

  it('双带 assigneeUserId + assigneeAgentId → 拒绝', () => {
    expect(() =>
      CreateTaskRequestSchema.parse({
        ...BASE,
        assigneeUserId: USER_ID,
        assigneeAgentId: AGENT_ID,
      }),
    ).toThrow()
  })

  it('双空（只给标题）→ 拒绝', () => {
    expect(() => CreateTaskRequestSchema.parse(BASE)).toThrow()
  })

  it('各带其一 → 接受', () => {
    expect(CreateTaskRequestSchema.parse({ ...BASE, assigneeUserId: USER_ID }).assigneeUserId).toBe(
      USER_ID,
    )
    expect(
      CreateTaskRequestSchema.parse({ ...BASE, assigneeAgentId: AGENT_ID }).assigneeAgentId,
    ).toBe(AGENT_ID)
  })
})

describe('ReassignTaskRequestSchema（assignee 二选一，#239）', () => {
  it('双带 → 拒绝；双空 → 拒绝', () => {
    expect(() =>
      ReassignTaskRequestSchema.parse({ assigneeUserId: USER_ID, assigneeAgentId: AGENT_ID }),
    ).toThrow()
    expect(() => ReassignTaskRequestSchema.parse({})).toThrow()
  })

  it('指派 Agent 带显式 instruction → 接受', () => {
    expect(
      ReassignTaskRequestSchema.parse({
        assigneeAgentId: AGENT_ID,
        instruction: '接手这个任务',
      }).instruction,
    ).toBe('接手这个任务')
  })
})
