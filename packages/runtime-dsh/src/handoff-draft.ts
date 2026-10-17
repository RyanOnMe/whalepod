/**
 * 交接草稿的收尾生成（#379；ADR-0017 §3）。
 *
 * 位置与纪律：
 * - 只发生在**成员 Runtime 内**的收尾阶段（turn 正常完成之后、`run.completed` 之前），
 *   使用本 Run 既有的 provider/model 配置；Hub 不新增模型凭据。
 * - **一次性模型调用**（`llm.stream`，不是 agent turn）：不注册工具、不写业务事实、
 *   不改变会话与终态。最多一次尝试，`HANDOFF_DRAFT_TIMEOUT_MS` 硬超时（默认 60s，
 *   测试用环境变量收窄——这是测试缝不是功能开关）。
 * - 输出解析失败/超限/超时/模型报错一律 `failed(reason)`；调用方据此发
 *   `handoff.draft{status:'failed'}` 帧并继续发 `run.completed`——**不改变业务执行结果**。
 *
 * 输入材料（「仅允许读取本次上下文、证据和提交草稿」）由调用方装配：
 * 本 Run 的指令与助手产出（transcript）、绑定的约定版本（agreement）、
 * 本次 Artifact 候选标题（candidates）。这里只负责 prompt 装配与调用。
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  HANDOFF_NARRATIVE_MAX_BYTES,
  HandoffNarrativeSchema,
  type HandoffNarrative,
  type HandoffRunSpec,
} from '@whalepod/protocol'

export const DEFAULT_HANDOFF_DRAFT_TIMEOUT_MS = 60_000

/** 转录装配上限（字节级预算之外的先头闸；prompt 总量可控）。 */
const TRANSCRIPT_MAX_CHARS = 16_000
const TRANSCRIPT_ENTRY_MAX_CHARS = 2_000
/** 模型流式输出的失控保护（正常叙述远小于此）。 */
const STREAM_TEXT_MAX_CHARS = 200_000

/**
 * 超时毫秒数：`WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS` 覆盖（仅测试用于收窄——
 * 产品口径是 60 秒硬超时，不接受生产环境随意调大）。
 */
export function handoffDraftTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['WHALEPOD_HANDOFF_DRAFT_TIMEOUT_MS']
  if (raw === undefined) return DEFAULT_HANDOFF_DRAFT_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HANDOFF_DRAFT_TIMEOUT_MS
}

export interface HandoffTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

export interface HandoffPromptInput {
  runId: string
  /** 绑定约定版本的正文快照；null = 未绑定（材料里如实说明）。 */
  agreement: HandoffRunSpec['agreement']
  transcript: readonly HandoffTranscriptEntry[]
  /** 本次执行登记过的候选/交付物（标题 + 身份；不含本机路径）。 */
  artifacts: readonly { artifactId?: string; title: string; status?: string }[]
}

const SYSTEM_PROMPT = `你是交接整理助手。一次已完成的 Agent 执行即将结束，请把结果整理成给下一位同事的交接草稿。
要求：
- 只依据下方材料，不编造；不确定的内容不要写。宁缺毋滥。
- 每条 text ≤200 字，尽量具体（做了什么、约定了什么、还剩什么）。
- 「验证证据」只写材料里明确出现过的验证结果（测试/审查/构建/提交），没有证据就留空数组。
- 有 commit 就填进 commits（sha 字符串数组）；有 PR/文档链接就填进 prs（URL 数组）；没有就留空。
- 每条默认 verified=false（还会由责任人核对）；你觉得显然确定的事实也保持 false。
- 输出严格 JSON（不要代码块、不要多余文字），结构：
{"completed":[{"text":"...","verified":false,"refs":[]}],"interfaces":[],"unfinished":[],"decisions":[],"evidence":[],"downstream":[],"commits":[],"prs":[]}
- refs 元素只能是以下四种之一：
  {"kind":"artifact","artifactId":"<下方列出的 Artifact id>"}、{"kind":"run","runId":"<uuid>"}、{"kind":"url","url":"..."}、{"kind":"commit","sha":"..."}。
  下方未列出 Artifact id 时不要使用 artifact 引用；「验证证据」条目优先引用 run（本执行）、url 或 commit。`

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`
}

/** 装配 prompt。transcript 保留**尾部**（越近的产出越相关）。 */
export function buildHandoffPrompt(input: HandoffPromptInput): { system: string; user: string } {
  const lines: string[] = []
  lines.push('# 任务约定（本次执行的依据）')
  if (input.agreement === null) {
    lines.push('本执行未绑定任务约定。')
  } else {
    lines.push(`版本 v${input.agreement.revisionNumber}`)
    lines.push(`目标：${input.agreement.goal || '（未填写）'}`)
    lines.push(`约束：${input.agreement.constraints || '（未填写）'}`)
    lines.push(`验收条件：${input.agreement.acceptance || '（未填写）'}`)
    lines.push(`待确认问题：${input.agreement.openQuestions || '（未填写）'}`)
  }
  lines.push('')
  lines.push('# 本次执行登记过的 Artifact')
  if (input.artifacts.length === 0) {
    lines.push('（无）')
  } else {
    for (const artifact of input.artifacts) {
      const details = [
        artifact.artifactId === undefined ? undefined : `artifactId=${artifact.artifactId}`,
        artifact.status === undefined ? undefined : `状态 ${artifact.status}`,
      ].filter((part): part is string => part !== undefined)
      lines.push(
        details.length === 0
          ? `- ${artifact.title}`
          : `- ${artifact.title}（${details.join('，')}）`,
      )
    }
  }
  lines.push('')
  lines.push('# 执行对话（user=指令，assistant=产出）')
  const entries = input.transcript
  const kept: string[] = []
  let budget = TRANSCRIPT_MAX_CHARS
  for (let i = entries.length - 1; i >= 0 && budget > 0; i--) {
    const entry = entries[i]
    if (entry === undefined) continue
    const line = `[${entry.role}] ${clamp(entry.text, TRANSCRIPT_ENTRY_MAX_CHARS)}`
    if (line.length > budget) break
    kept.unshift(line)
    budget -= line.length
  }
  lines.push(kept.length === 0 ? '（无对话记录）' : kept.join('\n'))
  lines.push('')
  lines.push(`# 来源 Run\nrunId=${input.runId}`)
  return { system: SYSTEM_PROMPT, user: lines.join('\n') }
}

export type HandoffDraftOutcome =
  | { status: 'generated'; content: HandoffNarrative }
  | { status: 'failed'; reason: string }

export interface HandoffDraftCall {
  provider: string
  model: string
  /** 本 Run 的 DSH session id（replay 按它分离回放游标；无功能语义）。 */
  sessionId?: GenerateOptions['sessionId']
  timeoutMs: number
  /**
   * 外部取消信号（评审 M2）：`run.cancel` 在收尾窗口内到达时立刻中断这次整理调用，
   * 不再让对方干等满 60s（取消胜出，由 bridge 负责随后发 run.cancelled）。
   */
  signal?: AbortSignal
}

/** 从模型文本里抽取 JSON（容忍 ```json 围栏与前后白噪声）。 */
function extractJson(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, '')
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in model output')
  return JSON.parse(fenced.slice(start, end + 1))
}

/**
 * 收尾一次性调用：成功返回通过 schema 校验的叙述；任何失败返回 `failed(reason)`。
 * `stream` 由调用方注入（生产 = `ctx.llm.stream`；单测 = 手写 async generator）。
 */
export async function generateHandoffDraft(
  call: HandoffDraftCall,
  prompt: { system: string; user: string },
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
): Promise<HandoffDraftOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, call.timeoutMs)
  const externalAbort = (): void => controller.abort()
  if (call.signal !== undefined) {
    if (call.signal.aborted) controller.abort()
    else call.signal.addEventListener('abort', externalAbort, { once: true })
  }
  let text = ''
  let overflow = false
  /**
   * 适配器失败不会抛给消费者：DSH 的 llm 流把它转成终止 `finish` chunk
   * （`reason.kind='aborted'|'error'`，见 vendor 的 adapterFailureChunk）。所以
   * 必须显式读终止块，不能只依赖 catch。
   */
  let terminalError: string | undefined
  let aborted = false
  try {
    const options: GenerateOptions = {
      provider: call.provider,
      model: call.model,
      system: prompt.system,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt.user }],
          source: { kind: 'user' },
        }),
      ],
      signal: controller.signal,
      ...(call.sessionId !== undefined ? { sessionId: call.sessionId } : {}),
    }
    for await (const chunk of stream(options)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        if (text.length > STREAM_TEXT_MAX_CHARS) {
          overflow = true
          controller.abort()
          break
        }
      }
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        if (chunk.reason.kind === 'aborted') {
          aborted = true
        } else {
          const failure = (chunk.reason as { failure?: { code?: string; message?: string } })
            .failure
          terminalError = failure?.code ?? failure?.message ?? 'model-call-failed'
        }
      }
    }
    if (overflow) return { status: 'failed', reason: 'output-too-large' }
    if (aborted) {
      return { status: 'failed', reason: timedOut ? 'timeout' : 'aborted' }
    }
    if (terminalError !== undefined) {
      return { status: 'failed', reason: `model-call-failed: ${clamp(terminalError, 300)}` }
    }
  } catch (error) {
    if (timedOut) return { status: 'failed', reason: 'timeout' }
    if (call.signal?.aborted === true) return { status: 'failed', reason: 'aborted' }
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `model-call-failed: ${clamp(message, 300)}` }
  } finally {
    clearTimeout(timer)
    call.signal?.removeEventListener('abort', externalAbort)
  }
  let parsed: unknown
  try {
    parsed = extractJson(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `invalid-handoff-json: ${clamp(message, 300)}` }
  }
  const validated = HandoffNarrativeSchema.safeParse(parsed)
  if (!validated.success) {
    const issue = validated.error.issues[0]
    const detail =
      issue === undefined
        ? 'schema violation'
        : `${issue.path.join('.') || '(root)'}: ${issue.message}`
    return { status: 'failed', reason: `invalid-handoff-content: ${clamp(detail, 300)}` }
  }
  // 二次防线：refine 已按字节限制，但把上限常量带进 reason 便于排障（真超限时 schema 会先拒）。
  const bytes = new TextEncoder().encode(JSON.stringify(validated.data)).length
  if (bytes > HANDOFF_NARRATIVE_MAX_BYTES) {
    return { status: 'failed', reason: `handoff-narrative-too-large: ${bytes} bytes` }
  }
  return { status: 'generated', content: validated.data }
}
