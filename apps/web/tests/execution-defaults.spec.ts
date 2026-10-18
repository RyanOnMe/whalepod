/**
 * 输入框默认目标与自动草稿判据（P1-393；ADR-0019 决定 3/4）。
 *
 * 默认目标是一条规则：无历史 → 新执行；有活跃运行 → 追问；运行结束 →
 * 续聊最近一次业务运行（purpose='business'）。自动草稿只在「空白、未调整设置、
 * 未发送」时跟随运行状态更新默认模式；用户输入或明确选择后不再改写。
 */
import { describe, expect, it } from 'vitest'
import { makeRun } from './fixtures.js'
import {
  defaultComposeTarget,
  followsDefaultMode,
} from '../src/features/task/execution-defaults.js'
import type { ExecutionDraftLike } from '../src/features/task/execution-defaults.js'

const pristineSettings = { agentId: '', profileRevisionId: '', deviceId: '', workspaceId: '' }

const baseDraft: ExecutionDraftLike = {
  text: '',
  mode: 'resume',
  sourceId: 'run-1',
  modeOrigin: 'auto',
  sending: false,
  reviewArtifactIds: [],
  revisionContext: null,
  launch: { key: 'resume-', settings: pristineSettings },
}

describe('输入框默认目标（ADR-0019 决定 3）', () => {
  it('没有运行历史时默认新执行', () => {
    expect(defaultComposeTarget([])).toEqual({ mode: 'new', sourceId: '' })
  })

  it('有活跃业务运行时默认追问它', () => {
    const target = defaultComposeTarget([
      makeRun({ id: 'run-1', status: 'completed' }),
      makeRun({ id: 'run-2', status: 'running' }),
    ])
    expect(target).toEqual({ mode: 'followup', sourceId: 'run-2' })
  })

  it('运行结束后默认续聊最近一次业务运行', () => {
    const target = defaultComposeTarget([
      makeRun({ id: 'run-1', status: 'completed' }),
      makeRun({ id: 'run-2', status: 'failed' }),
    ])
    expect(target).toEqual({ mode: 'resume', sourceId: 'run-2' })
  })

  it('辅助运行（约定草稿/交接草稿）不冒充续聊来源；不跳过业务运行去续更早会话', () => {
    const target = defaultComposeTarget([
      makeRun({ id: 'run-1', status: 'completed', purpose: 'business' }),
      makeRun({ id: 'run-2', status: 'completed', purpose: 'handoff_draft' }),
    ])
    expect(target).toEqual({ mode: 'resume', sourceId: 'run-1' })

    // 只有辅助运行终结、没有业务运行时，默认新执行（不拿辅助运行当会话来源）。
    expect(
      defaultComposeTarget([
        makeRun({ id: 'run-9', status: 'completed', purpose: 'agreement_draft' }),
      ]),
    ).toEqual({ mode: 'new', sourceId: '' })
  })

  it('只有辅助运行活跃时仍默认追问它（否则默认不可发送）', () => {
    const target = defaultComposeTarget([
      makeRun({ id: 'run-1', status: 'completed', purpose: 'business' }),
      makeRun({ id: 'run-2', status: 'running', purpose: 'handoff_draft' }),
    ])
    expect(target).toEqual({ mode: 'followup', sourceId: 'run-2' })
  })
})

describe('自动草稿跟随默认模式（ADR-0019 决定 4）', () => {
  it('空白、未调整设置、未发送的自动草稿跟随默认', () => {
    expect(followsDefaultMode(baseDraft)).toBe(true)
  })

  it('已输入文字后不再被默认规则改写', () => {
    expect(followsDefaultMode({ ...baseDraft, text: '还有一句话' })).toBe(false)
    expect(followsDefaultMode({ ...baseDraft, text: '   ' })).toBe(true)
  })

  it('用户明确选择过模式/来源/材料/设置/修订上下文后不再被改写', () => {
    expect(followsDefaultMode({ ...baseDraft, modeOrigin: 'user' })).toBe(false)
    expect(
      followsDefaultMode({
        ...baseDraft,
        // 参数只在会用到它们的模式里算「调整过」（详见下一条用例）。
        mode: 'new',
        launch: { key: 'new-', settings: { ...pristineSettings, agentId: 'agent-1' } },
      }),
    ).toBe(false)
    expect(followsDefaultMode({ ...baseDraft, reviewArtifactIds: ['artifact-1'] })).toBe(false)
    expect(
      followsDefaultMode({ ...baseDraft, revisionContext: { artifactId: 'artifact-1' } }),
    ).toBe(false)
  })

  it('已发送过的新执行留下的执行参数不冻结之后的追问/续聊跟随', () => {
    // 参数只在 new/review 模式会被发出；追问/续聊里的残留不影响「未动过」判据。
    const withLaunchSettings = {
      ...baseDraft,
      mode: 'followup',
      launch: { key: 'new-', settings: { ...pristineSettings, agentId: 'agent-1' } },
    }
    expect(followsDefaultMode(withLaunchSettings)).toBe(true)
    expect(followsDefaultMode({ ...withLaunchSettings, mode: 'new' })).toBe(false)
  })

  it('发送中不跟随（草稿在途，默认规则不得改投）', () => {
    expect(followsDefaultMode({ ...baseDraft, sending: true })).toBe(false)
  })
})
