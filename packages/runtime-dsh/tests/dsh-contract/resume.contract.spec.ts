/**
 * #176 切片①：**resume 可行性探针**（ADR-0009 决策 3「终态后续跑」的前置验证）。
 *
 * 要回答的问题只有一个：**第二次 Run 能不能接着第一次的会话继续说话**——这正是
 * 用户反馈的「一个 Run 只能进行一次对话」的根因所在。探针必须走产线同一条处理路径，
 * 所以它不用 DSH 的裸 API 写平行实现，而是复用 Q3 契约探针的 replay 运行时
 * （`startReplayRuntime`：真 RuntimeBridge + 真 DSH boot，只有 LLM 出口被 replay
 * 适配器替换），唯一的附加接缝是 `RuntimeBridgeOptions.probeResumeSessionId`
 * ——它把装载方式从「新建会话」换成 DSH 的 **persisted load**（`ctx.agents.resume`），
 * 其余 boot / setup 组合面一字不改。
 *
 * ## 判据为什么是硬的（不是"看起来接上了"）
 *
 * 续跑阶段的 replay 脚本里，assistant 文本带 `{{fromRequest:验证码是 (\d{4})}}`
 * 占位符——它按**模型这次实际收到的请求内容**解析，匹配不到就抛
 * `llm-replay: fromRequest pattern ... matched nothing`（上游实现，非本仓自造）。
 * 也就是说：上下文里没有第一轮那句话，这次 Run 直接失败；解析出 `7788` 才说明
 * 第一轮的用户消息真的进了模型请求。**这是"接上了"的机器判据，不是观感。**
 *
 * ## 同时测的两件事（ADR-0009 风险二）
 *
 * - **日志增长形态**：persisted load 用**同一 session id、同一日志文件**追加，不是
 *   复制历史到新会话。所以逐次续跑应当是**线性**增长；探针按轮测字节数，并断言
 *   第一轮那句话在日志里**只出现一次**（复制式 seed 会让它出现两次以上）。
 * - **续跑耗时**：记录每轮 `runtime.initialize → runtime.ready` 的墙钟时间（含 boot +
 *   装载 + setup + whenIdle，探针如实标注口径，不假装只量了装载）。
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'
import type { RuntimeOutput } from '@whalepod/protocol'

/** 第一轮里那句必须被记住的话——续跑脚本靠它解析占位符。 */
const SECRET = '7788'
const FIRST_PROMPT = `请记住：验证码是 ${SECRET}`
const SECOND_PROMPT = '验证码是多少？'

/** 在 DSH_HOME 下找该会话的持久化日志（布局：sessions/<projectKey>/<sessionId>/session.jsonl）。 */
function sessionLogPath(dshHomePath: string, sessionId: string): string | undefined {
  const sessionsRoot = join(dshHomePath, 'sessions')
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const project of projectDirs) {
    const candidate = join(sessionsRoot, project, sessionId, 'session.jsonl')
    try {
      statSync(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

/** assistant 文本（从 session.event 的 assistant/message 里取）。 */
function assistantTexts(outputs: readonly RuntimeOutput[]): string {
  return sessionEventsOf(outputs)
    .filter((event) => event.type === 'assistant/message')
    .map((event) => JSON.stringify(event.data))
    .join('\n')
}

/**
 * 造一轮续跑脚本：turn 号按轮次给（续跑后的会话 turn 计数继续往上走），assistant
 * 文本带 fromRequest 占位符——上下文里没有第一轮那句话就解析不出来。
 */
function writeContinuationFixture(dir: string, turn: number): string {
  const file = join(dir, `continuation-turn-${turn}.jsonl`)
  const text = `验证码是 {{fromRequest:验证码是 (\\d{4})}}。`
  const base = turn * 10
  const lines = [
    JSON.stringify({
      type: 'session',
      id: `session-replay-resume-turn-${turn}`,
      createdAt: 1755502000000,
      seedLength: 0,
    }),
    ...[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ].map((chunk, index) =>
      JSON.stringify({
        type: 'assistant/chunk',
        seq: base + index,
        time: 1755502000000 + index * 100,
        data: { turn, step: 1, chunk },
      }),
    ),
    JSON.stringify({
      type: 'assistant/chunk',
      seq: base + 9,
      time: 1755502000000 + 900,
      data: { turn, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    }),
  ]
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

describe('probe: resume（#176 切片①，ADR-0009 决策 3 前置）', () => {
  it('第二轮 Run 用 persisted load 接上第一轮会话：同一 session id、上下文可命中、日志不复制', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'whalepod-resume-fixtures-'))
    // 第一阶段：真 boot，一句话进历史，正常收敛到终态。
    const specA = runtimeSpec()
    const runtimeA = await startReplayRuntime('resume', specA, { keepTempDirs: true })
    let sessionId: string
    let freshReadyMs = 0
    try {
      const startedA = Date.now()
      await runtimeA.send(initializeCommand(specA))
      const ready = await runtimeA.until('runtime.ready')
      // 对照组：新建会话的 initialize → ready 耗时（同为 boot + setup + whenIdle），
      // 与续跑那几轮同口径，才能说清"续跑多花了多少"。
      freshReadyMs = Date.now() - startedA
      sessionId = ready.payload.dshSessionId
      expect(typeof sessionId).toBe('string')
      expect(sessionId).toBe(`whalepod-run-${specA.runId}`)

      await runtimeA.send(commandFrame('run.prompt', { runId: specA.runId, text: FIRST_PROMPT }))
      const completed = await runtimeA.until('run.completed')
      expect(completed.payload.runId).toBe(specA.runId)
    } finally {
      await runtimeA.dispose()
    }

    const logPath = sessionLogPath(specA.dshHomePath, sessionId)
    expect(logPath, '第一轮的会话日志没落盘（resume 无从谈起）').toBeDefined()
    const logFile = logPath as string
    const bytesAfterFirst = statSync(logFile).size
    const textAfterFirst = readFileSync(logFile, 'utf8')
    expect(textAfterFirst).toContain(FIRST_PROMPT)
    /**
     * 防复制口径（自校准，不猜记录条数）：第一轮那句话在**续跑前**出现几次，
     * 续跑后就该还是几次。persisted load 是原地追加，不会重写或复制既有历史；
     * 复制式 seed（新建会话 + 复制前缀）会让它成倍出现。
     * 为什么不用验证码本身计数：`7788` 会随每轮 assistant 回复进入日志（delta /
     * block-end / 后续请求都带），那是正常的追加，不是复制——第一版就是这么写错的。
     */
    const firstPromptOccurrences = textAfterFirst.split(FIRST_PROMPT).length - 1
    expect(firstPromptOccurrences).toBeGreaterThan(0)

    // 逐轮续跑：第二轮用静态脚本（含 fromRequest 判据），第三轮起用生成的脚本，
    // 每轮都记字节数与「boot + 装载 + ready」耗时。
    const rounds: { round: number; bytes: number; readyMs: number; assistant: string }[] = []
    for (let round = 2; round <= 8; round += 1) {
      // 关键：workspace 与 DSH_HOME 复用第一轮的——会话日志就躺在那里。
      const specB = runtimeSpec({
        workspacePath: specA.workspacePath,
        dshHomePath: specA.dshHomePath,
      })
      const started = Date.now()
      const runtimeB = await startReplayRuntime(round === 2 ? 'resume-continue' : 'resume', specB, {
        probeResumeSessionId: sessionId,
        keepTempDirs: true,
        ...(round === 2 ? {} : { fixtureFile: writeContinuationFixture(fixtureDir, round) }),
      })
      let readyMs = 0
      let assistant = ''
      try {
        await runtimeB.send(initializeCommand(specB))
        const ready = await runtimeB.until('runtime.ready')
        readyMs = Date.now() - started
        // 判据一：**同一 session id**——接上的是那条线程，不是新建一条。
        expect(ready.payload.dshSessionId, `第 ${round} 轮接到的会话 id 变了`).toBe(sessionId)

        await runtimeB.send(commandFrame('run.prompt', { runId: specB.runId, text: SECOND_PROMPT }))
        await runtimeB.until('run.completed')
        assistant = assistantTexts(runtimeB.outputs)
      } finally {
        await runtimeB.dispose()
      }
      // 判据二：assistant 文本解析出了第一轮的那个验证码——上下文真的进了模型请求
      // （解析不出的话 replay 适配器会抛 "fromRequest pattern ... matched nothing"，
      // 这条 Run 根本走不到 run.completed）。
      expect(assistant, `第 ${round} 轮没拿到续跑回复`).toContain(SECRET)
      const bytes = statSync(logFile).size
      rounds.push({ round, bytes, readyMs, assistant })
    }

    // 判据三：同一日志文件、线性增长、历史不复制。
    const finalText = readFileSync(logFile, 'utf8')
    const finalPromptOccurrences = finalText.split(FIRST_PROMPT).length - 1
    expect(
      finalPromptOccurrences,
      `续跑把第一轮的记录复制了：那句话从 ${firstPromptOccurrences} 次变成 ${finalPromptOccurrences} 次`,
    ).toBe(firstPromptOccurrences)
    expect(rounds.every((entry) => entry.bytes > bytesAfterFirst)).toBe(true)
    // 只应存在这一个会话目录（没有为续跑新建会话）。
    const projectKeyDirs = readdirSync(join(specA.dshHomePath, 'sessions'))
    const sessionDirs = projectKeyDirs.flatMap((project) =>
      readdirSync(join(specA.dshHomePath, 'sessions', project)),
    )
    expect(sessionDirs).toEqual([sessionId])

    // 对照二（**同口径**的关键）：热进程里再新建一个会话（新 workspace / 新 DSH_HOME），
    // 量同一条 initialize → ready。上面那 433 ms 是**冷进程**首次 boot（还要加载模块与
    // 插件），拿它跟续跑比会得出"续跑快十倍"的假结论——真正要回答的是"续跑比**热态新建**
    // 多花多少"，那才是装载既有日志的代价。
    const specC = runtimeSpec()
    const runtimeC = await startReplayRuntime('resume', specC)
    let warmFreshReadyMs = 0
    try {
      const startedC = Date.now()
      await runtimeC.send(initializeCommand(specC))
      await runtimeC.until('runtime.ready')
      warmFreshReadyMs = Date.now() - startedC
    } finally {
      await runtimeC.dispose()
    }

    console.log(
      `[#176 resume 探针] 冷进程新建 ready ${freshReadyMs} ms / 热进程新建 ready ${warmFreshReadyMs} ms；首轮日志 ${bytesAfterFirst} B；` +
        rounds
          .map((entry) => `第 ${entry.round} 轮：${entry.bytes} B / ready ${entry.readyMs} ms`)
          .join('；') +
        `；第一轮那句话出现 ${finalPromptOccurrences} 次（续跑前 ${firstPromptOccurrences} 次）`,
    )
  }, 180_000)
})
