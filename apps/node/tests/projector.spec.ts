/**
 * 切片 A2 —— 单一 projector（03 §8 投影表 + §9 二层收缩）红测试。
 *
 * 映射表（测试即规格）：
 * - assistant/chunk text-delta → 仅 owner live delta（不持久）；reasoning-delta 不投影
 * - step/start → run.phase thinking（owner+project 两行）
 * - tool/call → run.phase tool + tool.started（owner 全量脱敏 preview / project 收缩为工具类别）
 * - tool/result → tool.finished（owner+project；error/isError→failed）
 * - assistant/message → 仅 owner 完整正文（project 运行中不见中间文本）
 * - turn/end → run.phase finalizing；aborted 时未闭环 tool call 收 cancelled
 * - approval.requested → owner 完整卡（preview 取自登记的 tool/call 参数，已脱敏）
 * - approval.decide 回显 → approval.decided（owner+project，无理由正文）
 * - run.completed → owner 完整 finalText / project 确定式摘要（≤500 字符）
 * - runtime.fatal → owner 脱敏 summary / project 仅错误码
 * - 未登记事件类型 → 不投影（fail-silent 是投影纪律，不是错误）
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import { RunProjector, type ProjectionContext } from '../src/projection/projector.js'

const CTX: ProjectionContext = {
  runId: '11111111-1111-4111-8111-111111111111',
  workspaceRoot: '/Users/bob/work/team-app',
  homeDir: '/Users/bob',
  // 默认留空：既有语料按 §9 原始两前缀断言；P1-17 扩展项（stateDir/packsRoot）
  // 用 home 之外的自定义 stateDir 上下文单测（review m2 场景）。
  stateDir: '',
  packsRoot: '',
}

/** 自定义 --state-dir 在 home 之外：pack overlay 绝对路径会越过 home 替换项。 */
const CUSTOM_STATE_CTX: ProjectionContext = {
  runId: CTX.runId,
  workspaceRoot: CTX.workspaceRoot,
  homeDir: CTX.homeDir,
  stateDir: '/var/lib/whalepod/state',
  packsRoot: '/var/lib/whalepod/state/plugin-packs',
}

const NOW = new Date('2026-08-25T10:00:00.000Z')

function makeProjector(): RunProjector {
  return new RunProjector(CTX, { now: () => NOW })
}

let seqCounter = 100
function sessionEvent(type: string, data: unknown): RuntimeOutput {
  seqCounter += 1
  return {
    protocolVersion: 1,
    messageId: `m-${seqCounter}`,
    sentAt: NOW.toISOString(),
    type: 'session.event',
    payload: {
      runId: CTX.runId,
      dshSessionId: 'session-1',
      event: { type, seq: seqCounter, time: NOW.getTime(), data },
    },
  } as RuntimeOutput
}

function lifecycleFrame(type: string, payload: Record<string, unknown>): RuntimeOutput {
  return {
    protocolVersion: 1,
    messageId: `m-${type}`,
    sentAt: NOW.toISOString(),
    type,
    payload: { runId: CTX.runId, ...payload },
  } as RuntimeOutput
}

describe('live delta（§8：assistant/chunk text delta → run.live_delta，不持久）', () => {
  it('text-delta → 仅 live，零持久事件', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'Hello' },
      }),
    )
    expect(out.liveTexts).toEqual(['Hello'])
    expect(out.events).toEqual([])
  })

  it('reasoning-delta 不进 live（中间推理不外流）', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' },
      }),
    )
    expect(out.liveTexts).toEqual([])
    expect(out.events).toEqual([])
  })

  it('live delta 也过脱敏（语料原文不得出现在直播帧）', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'token: npm_xxx_fake_token' },
      }),
    )
    expect(out.liveTexts[0]).not.toContain('npm_xxx_fake_token')
  })
})

describe('run.phase（G4-04：project 受众的直播信号）', () => {
  it('step/start → thinking（owner+project 两行，内容相同）', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(sessionEvent('step/start', { turn: 1, step: 1 }))
    expect(out.events).toHaveLength(2)
    expect(out.events.map((e) => e.audience).sort()).toEqual(['owner', 'project'])
    for (const e of out.events) {
      expect(e.event).toEqual({ type: 'run.phase', phase: 'thinking' })
    }
  })

  it('turn/end → finalizing', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    )
    expect(out.events.map((e) => e.event)).toEqual([
      { type: 'run.phase', phase: 'finalizing' },
      { type: 'run.phase', phase: 'finalizing' },
    ])
  })
})

describe('tool 投影（§8：owner 脱敏 preview / project 类别+执行中）', () => {
  it('tool/call → phase tool + tool.started 双受众', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo hi' }),
      }),
    )
    const types = out.events.map((e) => `${e.audience}:${e.event.type}`)
    expect(types).toContain('owner:run.phase')
    expect(types).toContain('project:run.phase')
    expect(types).toContain('owner:tool.started')
    expect(types).toContain('project:tool.started')
  })

  it('owner preview 保留命令模板但脱敏秘密（§9 规则 6）', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer test-secret-123" x' }),
      }),
    )
    const ownerStarted = out.events.find(
      (e) => e.audience === 'owner' && e.event.type === 'tool.started',
    )
    expect(ownerStarted).toBeDefined()
    const preview = JSON.stringify(ownerStarted!.event)
    expect(preview).toContain('curl')
    expect(preview).not.toContain('test-secret-123')
  })

  it('project preview 只有工具类别：无命令正文（§9 二层收缩）', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'rm -rf /Users/bob/work/team-app/dist' }),
      }),
    )
    const projectStarted = out.events.find(
      (e) => e.audience === 'project' && e.event.type === 'tool.started',
    )
    const preview = JSON.stringify(projectStarted!.event)
    expect(preview).not.toContain('rm -rf')
    expect(preview).not.toContain('/Users/bob')
    expect(preview).toContain('shell')
  })

  it('文件工具只显示 Workspace 相对路径；越界路径不产生 preview（§9 规则 7）', () => {
    const p = makeProjector()
    const inBound = p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-in',
        name: 'readFile',
        arguments: JSON.stringify({ path: '/Users/bob/work/team-app/src/a.ts' }),
      }),
    )
    const inPreview = JSON.stringify(
      inBound.events.find((e) => e.audience === 'owner' && e.event.type === 'tool.started')!.event,
    )
    expect(inPreview).toContain('src/a.ts')
    expect(inPreview).not.toContain('/Users/bob')

    const outOfBound = p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-out',
        name: 'readFile',
        arguments: JSON.stringify({ path: '/etc/passwd' }),
      }),
    )
    const outPreview = JSON.stringify(
      outOfBound.events.find((e) => e.audience === 'owner' && e.event.type === 'tool.started')!
        .event,
    )
    expect(outPreview).not.toContain('/etc/passwd')
  })

  it('tool/result 正常 → succeeded（双受众）；带 error → failed', () => {
    const p = makeProjector()
    const ok = p.projectRuntimeOutput(
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-1',
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }],
          source: { kind: 'tool', callId: 'call-1', name: 'bash' },
        },
      }),
    )
    expect(ok.events.map((e) => e.event)).toEqual([
      { type: 'tool.finished', callId: 'call-1', outcome: 'succeeded' },
      { type: 'tool.finished', callId: 'call-1', outcome: 'succeeded' },
    ])

    const bad = p.projectRuntimeOutput(
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-2',
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call-2', content: [], isError: true }],
          source: { kind: 'tool', callId: 'call-2', name: 'bash' },
        },
        error: { name: 'ToolError', code: 'E_TOOL' },
      }),
    )
    expect(bad.events[0]!.event).toEqual({
      type: 'tool.finished',
      callId: 'call-2',
      outcome: 'failed',
    })
  })

  it('turn/end aborted 时未闭环的 tool call 收 cancelled', () => {
    const p = makeProjector()
    p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-open',
        name: 'bash',
        arguments: '{}',
      }),
    )
    const out = p.projectRuntimeOutput(
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'aborted', cause: { kind: 'user' } } }),
    )
    const cancelled = out.events.find(
      (e) => e.event.type === 'tool.finished' && e.event.callId === 'call-open',
    )
    expect(cancelled?.event).toEqual({
      type: 'tool.finished',
      callId: 'call-open',
      outcome: 'cancelled',
    })
  })
})

describe('assistant/message 与 run.completed（§8：owner 全文 / project 完成后摘要）', () => {
  it('assistant/message → 仅 owner 行，正文完整；project 运行中无行', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      sessionEvent('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Full answer text.' }],
          source: { kind: 'model', provider: 'replay', model: 'replay-model' },
        },
      }),
    )
    expect(out.events).toHaveLength(1)
    expect(out.events[0]!.audience).toBe('owner')
    expect(out.events[0]!.event).toEqual({
      type: 'assistant.message',
      text: 'Full answer text.',
    })
  })

  it('run.completed：owner 拿完整 finalText，project 拿确定式摘要（≤500 字符）', () => {
    const p = makeProjector()
    const longText = `  回答正文。\n\n${'细节。'.repeat(400)}  `
    p.projectRuntimeOutput(
      sessionEvent('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: longText }],
          source: { kind: 'model', provider: 'replay', model: 'replay-model' },
        },
      }),
    )
    const out = p.projectRuntimeOutput(
      lifecycleFrame('run.completed', { dshSessionId: 'session-1', finalMessageId: 'msg-1' }),
    )
    const owner = out.events.find((e) => e.audience === 'owner')
    const project = out.events.find((e) => e.audience === 'project')
    expect(owner?.event).toEqual({ type: 'run.completed', finalText: longText })
    expect(project?.event.type).toBe('run.completed')
    const projectText = (project?.event as { finalText: string }).finalText
    expect(projectText.length).toBeLessThanOrEqual(500)
    expect(projectText).not.toContain('\n\n')
  })

  it('无 assistant/message 时 run.completed finalText 为空串', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(lifecycleFrame('run.completed', { dshSessionId: 's' }))
    const owner = out.events.find((e) => e.audience === 'owner')
    expect(owner?.event).toEqual({ type: 'run.completed', finalText: '' })
  })
})

describe('approval 投影（卡关联 §8：runId+dshSessionId+callId）', () => {
  it('approval.requested：preview 取自登记的 tool/call 参数并脱敏；expiresAt=+10min', () => {
    const p = makeProjector()
    p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-a',
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo $DEEPSEEK_API_KEY' }),
      }),
    )
    const out = p.projectRuntimeOutput(
      lifecycleFrame('approval.requested', {
        callId: 'call-a',
        toolName: 'bash',
        reason: 'Run tool call requires approval: bash',
      }),
    )
    const ownerCard = out.events.find(
      (e) => e.audience === 'owner' && e.event.type === 'approval.requested',
    )
    expect(ownerCard).toBeDefined()
    const approval = (ownerCard!.event as { approval: Record<string, unknown> }).approval
    expect(approval['callId']).toBe('call-a')
    expect(approval['toolName']).toBe('bash')
    expect(approval['status']).toBe('pending')
    expect(typeof approval['approvalId']).toBe('string')
    expect(new Date(approval['expiresAt'] as string).getTime() - NOW.getTime()).toBe(600_000)
    // project 行存在但 preview 收缩（不含命令正文）
    const projectCard = out.events.find(
      (e) => e.audience === 'project' && e.event.type === 'approval.requested',
    )
    expect(JSON.stringify(projectCard!.event)).not.toContain('echo')
  })

  it('同一 callId 的 approval.decide 回显映射同一 approvalId（双受众，无理由正文）', () => {
    const p = makeProjector()
    p.projectRuntimeOutput(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-a',
        name: 'bash',
        arguments: '{}',
      }),
    )
    const requested = p.projectRuntimeOutput(
      lifecycleFrame('approval.requested', {
        callId: 'call-a',
        toolName: 'bash',
        reason: 'needs approval',
      }),
    )
    const approvalId = (requested.events[0]!.event as { approval: { approvalId: string } }).approval
      .approvalId
    const decided = p.projectApprovalDecided('call-a', 'allowed_once')
    expect(decided.events).toHaveLength(2)
    for (const e of decided.events) {
      expect(e.event).toEqual({ type: 'approval.decided', approvalId, status: 'allowed_once' })
    }
  })

  it('未知 callId 的 decide 回显不产事件', () => {
    const p = makeProjector()
    expect(p.projectApprovalDecided('nope', 'rejected').events).toEqual([])
  })
})

describe('runtime 生命周期帧', () => {
  it('runtime.ready → 双受众，携带 dshSessionId', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      lifecycleFrame('runtime.ready', { dshSessionId: 'session-1' }),
    )
    expect(out.events).toHaveLength(2)
    expect(out.events[0]!.event).toEqual({ type: 'runtime.ready', dshSessionId: 'session-1' })
  })

  it('runtime.fatal → owner 脱敏 summary / project 仅错误码（§8 stderr 行）', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(
      lifecycleFrame('runtime.fatal', {
        code: 'INTERNAL_ERROR',
        summary: 'boom at /Users/bob/private/project with npm_xxx_fake_token',
      }),
    )
    const owner = out.events.find((e) => e.audience === 'owner')
    const project = out.events.find((e) => e.audience === 'project')
    const ownerSummary = (owner!.event as { summary: string }).summary
    expect(ownerSummary).not.toContain('npm_xxx_fake_token')
    expect(ownerSummary).not.toContain('/Users/bob/private')
    expect(project!.event).toEqual({
      type: 'run.failed',
      code: 'INTERNAL_ERROR',
      summary: 'INTERNAL_ERROR',
    })
  })

  it('runtime.fatal：summary 含 packsRoot 下绝对路径（pack overlay）时投影已脱敏（P1-17 红线）', () => {
    const p = new RunProjector(CUSTOM_STATE_CTX, { now: () => NOW })
    const overlayPath = '/var/lib/whalepod/state/plugin-packs/abcdef1234/cordis.overlay.yml'
    const out = p.projectRuntimeOutput(
      lifecycleFrame('runtime.fatal', {
        code: 'RUNTIME_START_FAILED',
        summary: `whalepod-runtime: plugin tree failed to load: failed to read overlay ${overlayPath}: ENOENT`,
      }),
    )
    const owner = out.events.find((e) => e.audience === 'owner')
    const ownerSummary = (owner!.event as { summary: string }).summary
    expect(ownerSummary).toContain('<packs-root>/abcdef1234/cordis.overlay.yml')
    expect(ownerSummary).not.toContain('/var/lib/whalepod')
    expect(ownerSummary).not.toContain(overlayPath)
    const project = out.events.find((e) => e.audience === 'project')
    expect(project!.event).toEqual({
      type: 'run.failed',
      code: 'RUNTIME_START_FAILED',
      summary: 'RUNTIME_START_FAILED',
    })
  })

  it('runtime.fatal：summary 含 stateDir 下路径（非 packs 子树）时归约为 <state-dir>', () => {
    const p = new RunProjector(CUSTOM_STATE_CTX, { now: () => NOW })
    const out = p.projectRuntimeOutput(
      lifecycleFrame('runtime.fatal', {
        code: 'RUNTIME_START_FAILED',
        summary:
          'failed to read config file /var/lib/whalepod/state/runtime-home/run-1/settings.yaml',
      }),
    )
    const owner = out.events.find((e) => e.audience === 'owner')
    const ownerSummary = (owner!.event as { summary: string }).summary
    expect(ownerSummary).toContain('<state-dir>/runtime-home/run-1/settings.yaml')
    expect(ownerSummary).not.toContain('/var/lib/whalepod')
  })

  it('run.cancelled → 双受众 forced=false', () => {
    const p = makeProjector()
    const out = p.projectRuntimeOutput(lifecycleFrame('run.cancelled', {}))
    expect(out.events.map((e) => e.event)).toEqual([
      { type: 'run.cancelled', forced: false },
      { type: 'run.cancelled', forced: false },
    ])
  })

  it('agent.status / artifact.candidate 不产持久事件（P1-15 边界，登记不投影）', () => {
    const p = makeProjector()
    expect(
      p.projectRuntimeOutput(lifecycleFrame('agent.status', { status: 'running' })).events,
    ).toEqual([])
    expect(
      p.projectRuntimeOutput(
        lifecycleFrame('artifact.candidate', {
          relativePath: 'out/r.md',
          title: 'R',
          mediaType: 'text/markdown',
        }),
      ).events,
    ).toEqual([])
  })
})

describe('未登记事件类型（fail-silent 投影纪律）', () => {
  it.each(['turn/start', 'step/end', 'user/message', 'request/header', 'todo/write', 'unknown/x'])(
    '%s → 零输出',
    (type) => {
      const p = makeProjector()
      const out = p.projectRuntimeOutput(sessionEvent(type, {}))
      expect(out.events).toEqual([])
      expect(out.liveTexts).toEqual([])
    },
  )
})

describe('固定语料全链（04 §6.4：任一原文出现在任何输出即失败）', () => {
  const CORPUS = [
    'Authorization: Bearer test-secret-123',
    'DEEPSEEK_API_KEY=sk-test-abcdef',
    'npm_xxx_fake_token',
    '-----BEGIN PRIVATE KEY-----',
    '/Users/bob/private/project',
    'https://example.com/path?token=secret#fragment',
  ]

  it('语料种进每类事件后，所有输出帧（owner+project+live）均不含原文', () => {
    for (const secret of CORPUS) {
      const p = makeProjector()
      const outputs = [
        p.projectRuntimeOutput(
          sessionEvent('assistant/message', {
            turn: 1,
            step: 1,
            message: {
              id: 'm1',
              role: 'assistant',
              content: [{ type: 'text', text: `answer: ${secret}` }],
              source: { kind: 'model', provider: 'replay', model: 'replay-model' },
            },
          }),
        ),
        p.projectRuntimeOutput(
          sessionEvent('tool/call', {
            turn: 1,
            step: 1,
            callId: 'c1',
            name: 'bash',
            arguments: JSON.stringify({ command: `echo ${secret}` }),
          }),
        ),
        p.projectRuntimeOutput(
          lifecycleFrame('approval.requested', {
            callId: 'c1',
            toolName: 'bash',
            reason: `needs ${secret}`,
          }),
        ),
        p.projectRuntimeOutput(
          lifecycleFrame('runtime.fatal', { code: 'INTERNAL_ERROR', summary: `fail ${secret}` }),
        ),
        p.projectRuntimeOutput(
          sessionEvent('assistant/chunk', {
            turn: 1,
            step: 1,
            chunk: { type: 'text-delta', index: 0, text: `delta ${secret}` },
          }),
        ),
        p.projectRuntimeOutput(lifecycleFrame('run.completed', { dshSessionId: 's' })),
      ]
      const wire = JSON.stringify(outputs)
      expect(wire).not.toContain(secret)
    }
  })
})
