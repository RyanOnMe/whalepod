/**
 * 收尾整理生成器的单元判据（#379）：prompt 装配的分支 + 流式输出的失败分类。
 * 真实链路的四态（生成/超时/未启用/取消）在 dsh-contract 的 replay 探针里；
 * 这里只锁「纯函数 + 注入流」一层，跑得快、覆盖负向分支。
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  buildHandoffPrompt,
  generateHandoffDraft,
  handoffDraftTimeoutMs,
} from '../src/handoff-draft.js'

describe('#396 自动叙述的信任边界', () => {
  it('模型自称已核实仍强制为待核实', async () => {
    const result = await generateHandoffDraft(
      CALL,
      { system: 's', user: 'u' },
      chunkStream(textChunks(validJson().replaceAll('"verified":false', '"verified":true'))),
    )
    expect(result.status).toBe('generated')
    if (result.status === 'generated') {
      expect(result.content.completed[0]?.verified).toBe(false)
      expect(result.content.evidence[0]?.verified).toBe(false)
    }
  })

  it('不响应取消的流不能阻塞截止返回，晚到成功不得采用', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = generateHandoffDraft(
      { ...CALL, timeoutMs: 10 },
      { system: 's', user: 'u' },
      async function* () {
        await gate
        yield* textChunks(validJson())
      },
    )
    const result = await Promise.race([
      pending,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ])
    release()
    expect(result).toEqual({ status: 'failed', reason: 'timeout' })
    expect(await pending).toEqual({ status: 'failed', reason: 'timeout' })
  })
})

const AGREEMENT = {
  revisionNumber: 3,
  goal: '交付登录接口',
  constraints: '不引入新依赖',
  acceptance: '全部用例通过',
  openQuestions: '限流阈值',
}

function chunkStream(
  chunks: readonly StreamChunk[],
): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return () =>
    (async function* () {
      for (const chunk of chunks) yield chunk
    })()
}

function validJson(): string {
  return JSON.stringify({
    completed: [{ text: '完成登录接口', verified: false, refs: [] }],
    interfaces: [],
    unfinished: [],
    decisions: [],
    evidence: [
      {
        text: '测试通过',
        verified: false,
        refs: [{ kind: 'run', runId: '01905f7c-0000-7000-8000-000000000301' }],
      },
    ],
    downstream: [],
    commits: ['abc1234'],
    prs: [],
  })
}

const textChunks = (text: string, reason: 'stop' | 'aborted' | 'error' = 'stop'): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  ...(reason === 'stop'
    ? ([{ type: 'finish', reason: { kind: 'stop' } }] as StreamChunk[])
    : ([
        {
          type: 'finish',
          reason: { kind: reason, failure: { code: reason.toUpperCase(), message: reason } },
        },
      ] as unknown as StreamChunk[])),
]

const CALL = { provider: 'replay', model: 'replay-model', timeoutMs: 1000 }

describe('#379 交接草稿生成器（纯函数 + 注入流）', () => {
  it('prompt：绑定约定时四段全带；未绑定如实说明；transcript 取尾部且截断', () => {
    const long = 'x'.repeat(3000)
    const prompt = buildHandoffPrompt({
      runId: 'run-1',
      agreement: AGREEMENT,
      transcript: [
        { role: 'user', text: '实现登录接口' },
        { role: 'assistant', text: long },
        { role: 'assistant', text: '最后一句' },
      ],
      artifacts: [{ title: 'out/report.md' }],
    })
    expect(prompt.user).toContain('版本 v3')
    expect(prompt.user).toContain('验收条件：全部用例通过')
    expect(prompt.user).toContain('out/report.md')
    expect(prompt.user).toContain('最后一句')
    expect(prompt.user).toContain('（已截断）')
    expect(prompt.system).toContain('验证证据')

    const unbound = buildHandoffPrompt({
      runId: 'run-1',
      agreement: null,
      transcript: [],
      artifacts: [],
    })
    expect(unbound.user).toContain('本执行未绑定任务约定')
    expect(unbound.user).toContain('（无对话记录）')
    expect(unbound.user).toContain('（无）')
  })

  it('成功：JSON 过 schema（含围栏容忍与前后噪声）', async () => {
    const stream = chunkStream(textChunks('好的，这是结果：\n```json\n' + validJson() + '\n```\n'))
    const outcome = await generateHandoffDraft(CALL, { system: 's', user: 'u' }, stream)
    expect(outcome.status).toBe('generated')
    if (outcome.status !== 'generated') throw new Error('unreachable')
    expect(outcome.content.evidence[0]?.refs).toHaveLength(1)
    expect(outcome.content.commits).toEqual(['abc1234'])
  })

  it('失败分类：非 JSON / schema 违约 / 超限 / 适配器 error 终止块', async () => {
    const notJson = await generateHandoffDraft(
      CALL,
      { system: 's', user: 'u' },
      chunkStream(textChunks('没有 JSON')),
    )
    expect(notJson).toMatchObject({ status: 'failed' })
    if (notJson.status !== 'failed') throw new Error('unreachable')
    expect(notJson.reason).toContain('invalid-handoff-json')

    const badSchema = await generateHandoffDraft(
      CALL,
      { system: 's', user: 'u' },
      chunkStream(textChunks(JSON.stringify({ completed: 'nope' }))),
    )
    expect(badSchema).toMatchObject({ status: 'failed' })
    if (badSchema.status !== 'failed') throw new Error('unreachable')
    expect(badSchema.reason).toContain('invalid-handoff-content')

    const tooLarge = await generateHandoffDraft(
      CALL,
      { system: 's', user: 'u' },
      chunkStream(textChunks('x'.repeat(300_000))),
    )
    expect(tooLarge).toEqual({ status: 'failed', reason: 'output-too-large' })

    const errored = await generateHandoffDraft(
      CALL,
      { system: 's', user: 'u' },
      chunkStream(textChunks('partial', 'error')),
    )
    expect(errored).toMatchObject({ status: 'failed' })
    if (errored.status !== 'failed') throw new Error('unreachable')
    expect(errored.reason).toContain('model-call-failed')
  })

  it('aborted 终止块：未到超时 = aborted；超时后的 abort = timeout', async () => {
    const aborted = await generateHandoffDraft(
      CALL,
      { system: 's', user: 'u' },
      chunkStream(textChunks('partial', 'aborted')),
    )
    expect(aborted).toEqual({ status: 'failed', reason: 'aborted' })

    // hang 且响应 abort（与 DSH hang 条目同形）：超时掐断 → timeout。
    const hang: (options: GenerateOptions) => AsyncIterable<StreamChunk> = (options) =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        await new Promise((_resolve, reject) => {
          const signal = options.signal
          if (signal?.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })()
    const timedOut = await generateHandoffDraft(
      { ...CALL, timeoutMs: 50 },
      { system: 's', user: 'u' },
      hang,
    )
    expect(timedOut).toEqual({ status: 'failed', reason: 'timeout' })
  })

  it('外部取消信号（评审 M2）：在途中断 = aborted；已取消的入口立刻返回，不干等超时', async () => {
    const hang: (options: GenerateOptions) => AsyncIterable<StreamChunk> = (options) =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        await new Promise((_resolve, reject) => {
          const signal = options.signal
          if (signal?.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })()

    // 在途取消：模型流被中断 → 归类 aborted（不是 model-call-failed），调用方据此让取消胜出。
    const controller = new AbortController()
    const pending = generateHandoffDraft(
      { ...CALL, timeoutMs: 60_000, signal: controller.signal },
      { system: 's', user: 'u' },
      hang,
    )
    controller.abort()
    expect(await pending).toEqual({ status: 'failed', reason: 'aborted' })

    // 已取消的入口：立即归类 aborted（run.cancel 早于收尾窗口到达的形态）。
    const preCancelled = new AbortController()
    preCancelled.abort()
    const immediate = await generateHandoffDraft(
      { ...CALL, timeoutMs: 60_000, signal: preCancelled.signal },
      { system: 's', user: 'u' },
      hang,
    )
    expect(immediate).toEqual({ status: 'failed', reason: 'aborted' })
  })

  it('超时读数：环境变量可收窄；非法值回退默认 60s', () => {
    expect(handoffDraftTimeoutMs({})).toBe(60_000)
    expect(handoffDraftTimeoutMs({ WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS: '250' })).toBe(250)
    expect(handoffDraftTimeoutMs({ WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS: 'abc' })).toBe(60_000)
    expect(handoffDraftTimeoutMs({ WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS: '-5' })).toBe(60_000)
    expect(handoffDraftTimeoutMs({ WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS: '120000' })).toBe(60_000)
  })
})
