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
 * 续跑阶段的 replay 脚本里，assistant 文本带 `{{fromRequest:请记住：验证码是 (\d{4})}}`
 * 占位符——它按**模型这次实际收到的请求内容**解析，匹配不到就抛
 * `llm-replay: fromRequest pattern ... matched nothing`（上游实现，非本仓自造）。
 *
 * **pattern 为什么必须带「请记住：」前缀**（#177 R3 评审实测纠正）：只用
 * `验证码是 (\d{4})` 的话，第 2 轮的 assistant 回复（"验证码是 7788。"）本身会被持久化
 * 进日志，从第 3 轮起它自己就能满足这个正则——「绿」不再证明第一轮**用户消息**在场，
 * 判据退化成"上一轮回复在场"。assistant 回声永远不含「请记住：」前缀，加上它之后
 * 每一轮的命中都只能来自第一轮那条用户消息。
 *
 * ## 同时测的两件事（ADR-0009 风险二）
 *
 * - **日志增长形态**：persisted load 用**同一 session id、同一日志文件**追加，不是
 *   复制历史到新会话。所以逐次续跑应当是**线性**增长；探针按轮测字节数，并断言
 *   「旧日志字节持续增长 + 会话目录集合恰好只有那一个」（这两条才是"没跨会话复制"的判据）。
 * - **续跑耗时**：记录每轮 `runtime.initialize → runtime.ready` 的墙钟时间（含 boot +
 *   装载 + setup + whenIdle，探针如实标注口径，不假装只量了装载）。
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

describe('probe: resume（#176 切片①，ADR-0009 决策 3 前置）', () => {
  it('第二轮 Run 用 persisted load 接上第一轮会话：同一 session id、上下文可命中、日志不复制', async () => {
    // 第一阶段：真 boot，一句话进历史，正常收敛到终态。
    const specA = runtimeSpec()
    // 证据是「可复跑的判据」本身，不是留在 /tmp 的现场：#177 R5——清理必须在
    // finally 里，原先把 rmSync 写在 happy path 末尾，断言一红就整批留下
    //（含 273 KB 会话日志与 8 轮续跑的全部目录）。
    try {
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
       * 防重复追加口径（自校准，不猜记录条数）：第一轮那句话在**续跑前**出现几次，
       * 续跑后就该还是几次——它只能抓"同一文件里把历史又追加了一遍"。
       * **抓不到跨会话复制**（fork/seed 形态是新会话、新文件，旧文件一字不动、计数当然不变）：
       * 那一条由下面的「字节持续增长」与「会话目录集合唯一」负责（#177 R6 评审纠正）。
       * 为什么不用验证码本身计数：`7788` 会随每轮 assistant 回复进入日志（delta /
       * block-end / 后续请求都带），那是正常的追加，不是复制——第一版就是这么写错的。
       */
      const firstPromptOccurrences = textAfterFirst.split(FIRST_PROMPT).length - 1
      expect(firstPromptOccurrences).toBeGreaterThan(0)

      // 逐轮续跑：8 轮共用同一份静态脚本（`resume-continue`）——上游 replay 只按
      // turn/step 把 chunk 切成"一次模型调用"，fixture 里的 turn 号进不了真实会话
      //（#177 O3 评审核实），所以不必按轮生成脚本。每轮都记字节数与
      // 「boot + 装载 + ready」耗时。
      const rounds: { round: number; bytes: number; readyMs: number; assistant: string }[] = []
      for (let round = 2; round <= 8; round += 1) {
        // 关键：workspace 与 DSH_HOME 复用第一轮的——会话日志就躺在那里。
        // #177 R5：直接继承 specA 的路径、只换 runId，不再走 runtimeSpec({...})——
        // 那种写法会先白造两个临时目录再被覆盖掉（评审实测每次运行漏 14 个孤儿目录）。
        const specB = { ...specA, runId: randomUUID() }
        const started = Date.now()
        const runtimeB = await startReplayRuntime('resume-continue', specB, {
          probeResumeSessionId: sessionId,
          keepTempDirs: true,
        })
        let readyMs = 0
        let assistant = ''
        try {
          await runtimeB.send(initializeCommand(specB))
          const ready = await runtimeB.until('runtime.ready')
          readyMs = Date.now() - started
          // 判据一：**同一 session id**——接上的是那条线程，不是新建一条。
          expect(ready.payload.dshSessionId, `第 ${round} 轮接到的会话 id 变了`).toBe(sessionId)

          await runtimeB.send(
            commandFrame('run.prompt', { runId: specB.runId, text: SECOND_PROMPT }),
          )
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
      //
      // 归因说准（#177 R6 评审纠正）：**"没有跨会话复制"是下面两条抓的**——`bytes`
      // 持续变大（写的是同一个文件）与会话目录集合恰好 [sessionId]（没新建会话）。
      // 出现次数不变只能抓"同一文件内重复追加历史"，抓不到"复制到另一个新会话"
      //（那种形态旧文件一个字不动，计数当然不变）。
      const finalText = readFileSync(logFile, 'utf8')
      const finalPromptOccurrences = finalText.split(FIRST_PROMPT).length - 1
      expect(
        finalPromptOccurrences,
        `第一轮那句话在同一文件里被重复追加了：从 ${firstPromptOccurrences} 次变成 ${finalPromptOccurrences} 次`,
      ).toBe(firstPromptOccurrences)
      expect(
        rounds.every((entry) => entry.bytes > bytesAfterFirst),
        '续跑没有继续写第一轮那个日志文件（字节没增长）',
      ).toBe(true)
      // 只应存在这一个会话目录（没有为续跑新建会话）。
      const projectKeyDirs = readdirSync(join(specA.dshHomePath, 'sessions'))
      const sessionDirs = projectKeyDirs.flatMap((project) =>
        readdirSync(join(specA.dshHomePath, 'sessions', project)),
      )
      expect(sessionDirs).toEqual([sessionId])

      // 对照二（**同口径**的关键）：热进程里再新建一个会话（新 workspace / 新 DSH_HOME），
      // 量同一条 initialize → ready。第一阶段的数字是**冷进程**首次 boot（还要加载模块与
      // 插件），拿它跟续跑比会得出"续跑快十倍"的假结论——真正要回答的是"续跑比**热态新建**
      // 多花多少"，那才是装载既有日志的代价。三个数都按**区间**看（单次样本不足下结论）。
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
    } finally {
      rmSync(specA.workspacePath, { recursive: true, force: true })
      rmSync(specA.dshHomePath, { recursive: true, force: true })
    }
  }, 180_000)

  /**
   * 判据不恒真的反证（本仓的变异验证习惯）：把续跑脚本用在**没有 resume 的新会话**上，
   * 那个 `{{fromRequest:请记住：验证码是 (\\d{4})}}` 占位符就无内容可匹配——上游 llm-replay 会抛
   * `fromRequest pattern ... matched nothing`，turn 以错误收敛、bridge 发 `runtime.fatal`，
   * **不会**出现 run.completed。也就是说判据 2 的"绿"确实要求上下文在场。
   */
  it('反证：同一脚本用在没有续接的新会话上会失败（判据 2 不是恒真）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('resume-continue', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: SECOND_PROMPT }))
      const fatal = await runtime.until('runtime.fatal')
      // 归因钉死到上游那句话（#177 O5：只断言"是个字符串"太松）。summary 由 bridge
      // mapTurnError 拼成 `<code>: <上游 message>`，上游 message 里就有这句。
      expect(fatal.payload.summary).toContain('matched nothing')
      expect(runtime.outputs.some((frame) => frame.type === 'run.completed')).toBe(false)
      expect(assistantTexts(runtime.outputs)).not.toContain(SECRET)
    } finally {
      await runtime.dispose()
    }
  }, 120_000)
})
