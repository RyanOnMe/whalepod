/**
 * 单一 projector（03 §8 投影表 + §9 脱敏/二层收缩；02 Task 13）。
 *
 * 全仓只有这里把 Runtime 上行事实翻译成 ProjectedRunEvent：DSH SessionEvent
 * （session.event 帧的 unknown 载荷，形状由 DSH 拥有——本模块鸭式判读，不
 * import @deepseek-ai/*，红线）与 runtime 生命周期帧 → owner/project 两行
 * run_event 草稿 + owner-only live delta。
 *
 * 纪律：
 * - 一事实两行：owner 全量（已脱敏）、project 二层收缩；内容不同必须两行，
 *   各占一个 seq（03 §2.6 run_event (run_id, seq) 唯一）。
 * - 一切文本过 redact（§9「离开设备前」）；project 行再执行第二层收缩
 *   （无命令正文/文件名列表/中间文本/Token 用量）。
 * - 未登记事件类型不投影（fail-silent）：DSH 事件词汇会增长，未知即跳过，
 *   绝不猜测归属（§8 末行：禁止依赖"最后一条消息"或数组位置猜关联）。
 * - artifact.candidate 的落库与 sha256/byteSize 是 P1-15 的活；subagent.*
 *   在 DSH rc.8 无 SessionEvent 事实源（child session 独立日志）——两者本版
 *   不投影，边界登记在验收文档。
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { ProjectedRunEvent, RuntimeOutput } from '@project311/protocol'
import { redactString, redactValue, type RedactionContext } from './redact.js'

export interface ProjectionContext extends RedactionContext {
  readonly runId: string
}

/** run_event 草稿：seq 由 spool 层分配（本模块不管序号，只管内容）。 */
export interface ProjectedEventDraft {
  readonly audience: 'owner' | 'project'
  readonly occurredAt: string
  readonly event: ProjectedRunEvent['event']
}

export interface ProjectionResult {
  readonly events: ProjectedEventDraft[]
  /** owner-only 直播文本（已过脱敏；不持久，03 §8 首行）。 */
  readonly liveTexts: string[]
}

export interface RunProjectorOptions {
  readonly now?: () => Date
  readonly newId?: () => string
}

const EMPTY: ProjectionResult = { events: [], liveTexts: [] }

/** §2.6 approval 默认 10 分钟过期。 */
const APPROVAL_TTL_MS = 10 * 60 * 1000
/** project 受众最终摘要上限（确定式截断，不引入 LLM 摘要）。 */
const PROJECT_SUMMARY_MAX_CHARS = 500
/** §9 规则 5：preview 单项 2048 字节、总体 8192 字节。 */
const PREVIEW_ITEM_MAX_BYTES = 2048
const PREVIEW_TOTAL_MAX_BYTES = 8192

const SHELL_TOOL = /^(bash|shell|terminal|run)/i
const FS_TOOL = /^(read|write|edit|glob|grep|ls|list|str_replace|file|fs)/i

/** wire 上 preview 的静态类型（z.json() 推断形；本模块构造的值保证 JSON 可序列化）。 */
type WireJson = Extract<ProjectedRunEvent['event'], { type: 'tool.started' }>['preview']

/** project 受众的工具类别（§8「工具类别 + 执行中」；类别是显示语义，不含参数）。 */
function toolCategory(toolName: string): string {
  if (SHELL_TOOL.test(toolName)) return 'shell'
  if (FS_TOOL.test(toolName)) return 'fs'
  if (/publish_artifact/i.test(toolName)) return 'artifact'
  if (/(search|fetch|http|web|browser)/i.test(toolName)) return 'web'
  return 'other'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capStringBytes(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= maxBytes) return text
  // 截断可能切断多字节字符：decode 流式容错（fatal:false 默认替换符兜底）。
  return new TextDecoder().decode(encoded.subarray(0, maxBytes))
}

/** §9 规则 5：递归压单项上限；总量超 8192 时整棵替换为占位（宁缺毋滥）。 */
function capPreview(value: unknown): unknown {
  const capped = capStrings(value)
  const total = new TextEncoder().encode(JSON.stringify(capped)).length
  return total <= PREVIEW_TOTAL_MAX_BYTES ? capped : { truncated: true }
}

function capStrings(value: unknown): unknown {
  if (typeof value === 'string') return capStringBytes(value, PREVIEW_ITEM_MAX_BYTES)
  if (Array.isArray(value)) return value.map(capStrings)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = capStrings(item)
    return out
  }
  return value
}

/** project 受众的最终摘要：折叠空白 + 截断（确定式，可测试，可复跑）。 */
function summarizeForProject(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= PROJECT_SUMMARY_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, PROJECT_SUMMARY_MAX_CHARS - 1)}…`
}

/** 越界判定（与 workspace/path-policy 同语义：relative 不以 .. 开头且非绝对）。 */
function workspaceRelativePath(workspaceRoot: string, candidate: string): string | undefined {
  if (!isAbsolute(candidate)) return undefined
  const rel = relative(workspaceRoot, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel
}

export class RunProjector {
  private readonly now: () => Date
  private readonly newId: () => string
  /** turn/end 收敛时 lastAssistantText → run.completed finalText（owner 全文）。 */
  private lastAssistantText: string | undefined
  /** callId → approvalId（approval.decided 回显关联用；§8 关联纪律）。 */
  private readonly approvals = new Map<string, string>()
  /** callId → 登记的 tool/call 参数（approval preview 的事实源）。 */
  private readonly toolCalls = new Map<string, { readonly name: string; readonly args: string }>()
  /** 未闭环的 tool call（turn/end 非正常时收 cancelled）。 */
  private readonly openCalls = new Set<string>()

  constructor(
    private readonly ctx: ProjectionContext,
    options: RunProjectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
  }

  /** Runtime 上行帧入口：session.event 解包 + 生命周期帧直译。 */
  projectRuntimeOutput(frame: RuntimeOutput): ProjectionResult {
    switch (frame.type) {
      case 'session.event':
        return this.projectSessionEvent(frame.payload.event, frame.sentAt)
      case 'runtime.ready':
        return this.both(frame.sentAt, {
          type: 'runtime.ready',
          dshSessionId: frame.payload.dshSessionId,
        })
      case 'run.completed': {
        const full = this.lastAssistantText ?? ''
        return {
          liveTexts: [],
          events: [
            {
              audience: 'owner',
              occurredAt: frame.sentAt,
              event: { type: 'run.completed', finalText: full },
            },
            {
              audience: 'project',
              occurredAt: frame.sentAt,
              event: { type: 'run.completed', finalText: summarizeForProject(full) },
            },
          ],
        }
      }
      case 'run.cancelled':
        return this.both(frame.sentAt, { type: 'run.cancelled', forced: false })
      case 'runtime.fatal': {
        const code = frame.payload.code
        return {
          liveTexts: [],
          events: [
            {
              audience: 'owner',
              occurredAt: frame.sentAt,
              event: {
                type: 'run.failed',
                code,
                summary: capStringBytes(redactString(frame.payload.summary, this.ctx), 1000),
              },
            },
            {
              audience: 'project',
              occurredAt: frame.sentAt,
              // §8 stderr 行：project 只见错误码。
              event: { type: 'run.failed', code, summary: code },
            },
          ],
        }
      }
      case 'approval.requested':
        return this.projectApprovalRequested(
          frame.payload.callId,
          frame.payload.toolName,
          frame.payload.reason,
          frame.sentAt,
        )
      default:
        // agent.status（phase 已由 step/start 派生）与 artifact.candidate（P1-15）。
        return EMPTY
    }
  }

  /**
   * approval.decide 的本地回显（决定经 Node 生效后上报；§8 approval/decided：
   * owner 见决定、project 见状态变化——schema 本就不带理由正文，两行同形）。
   */
  projectApprovalDecided(callId: string, decision: 'allowed_once' | 'rejected'): ProjectionResult {
    const approvalId = this.approvals.get(callId)
    if (approvalId === undefined) return EMPTY
    return this.both(this.now().toISOString(), {
      type: 'approval.decided',
      approvalId,
      status: decision,
    })
  }

  /**
   * P1-16（G7-02）：取消升级的本地合成事实。Runtime 自身确认的取消由
   * 'run.cancelled' 帧直译（forced=false）；这里供 Supervisor 强杀后合成
   * forced=true——03 §3.2「cancel_requested 15 秒未确认 → 终止 Runtime，写
   * cancelled(forced)」。同样走 owner/project 双受众。
   */
  projectCancelledLocal(forced: boolean): ProjectionResult {
    return this.both(this.now().toISOString(), { type: 'run.cancelled', forced })
  }

  /**
   * P1-16（G7-03/R9）：Runtime 消失（异常退出/超时回收）且无更具体事实时的
   * 本地合成失败——code 固定 RUNTIME_LOST（§10），owner 见脱敏 summary，
   * project 只见错误码（§8 stderr 行语义）。绝不据此自动重启或重放工具。
   */
  projectRuntimeLost(summary: string): ProjectionResult {
    const safeSummary = capStringBytes(redactString(summary, this.ctx), 1000)
    return {
      liveTexts: [],
      events: [
        {
          audience: 'owner',
          occurredAt: this.now().toISOString(),
          event: { type: 'run.failed', code: 'RUNTIME_LOST', summary: safeSummary },
        },
        {
          audience: 'project',
          occurredAt: this.now().toISOString(),
          event: { type: 'run.failed', code: 'RUNTIME_LOST', summary: 'RUNTIME_LOST' },
        },
      ],
    }
  }

  // ---------- session.event 内部 ----------

  private projectSessionEvent(input: unknown, fallbackOccurredAt: string): ProjectionResult {
    if (!isRecord(input) || typeof input['type'] !== 'string') return EMPTY
    const occurredAt =
      typeof input['time'] === 'number' ? new Date(input['time']).toISOString() : fallbackOccurredAt
    const data = input['data']
    switch (input['type']) {
      case 'assistant/chunk':
        return this.projectAssistantChunk(data, occurredAt)
      case 'assistant/message':
        return this.projectAssistantMessage(data, occurredAt)
      case 'step/start':
        return this.both(occurredAt, { type: 'run.phase', phase: 'thinking' })
      case 'tool/call':
        return this.projectToolCall(data, occurredAt)
      case 'tool/result':
        return this.projectToolResult(data, occurredAt)
      case 'turn/end':
        return this.projectTurnEnd(data, occurredAt)
      default:
        return EMPTY
    }
  }

  private projectAssistantChunk(data: unknown, _occurredAt: string): ProjectionResult {
    if (!isRecord(data) || !isRecord(data['chunk'])) return EMPTY
    const chunk = data['chunk']
    // §8 首行：只有 text-delta 进 owner live；reasoning-delta 不外流。
    if (chunk['type'] === 'text-delta' && typeof chunk['text'] === 'string') {
      return { events: [], liveTexts: [redactString(chunk['text'], this.ctx)] }
    }
    return EMPTY
  }

  private projectAssistantMessage(data: unknown, occurredAt: string): ProjectionResult {
    if (!isRecord(data) || !isRecord(data['message'])) return EMPTY
    const content = data['message']['content']
    if (!Array.isArray(content)) return EMPTY
    const text = content
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
      .map((block) => block['text'] as string)
      .join('\n')
    const redacted = redactString(text, this.ctx)
    this.lastAssistantText = redacted
    if (redacted === '') return EMPTY
    // §8：project 运行中不见中间文本——最终摘要由 run.completed 携带。
    return {
      liveTexts: [],
      events: [
        {
          audience: 'owner',
          occurredAt,
          event: { type: 'assistant.message', text: redacted },
        },
      ],
    }
  }

  private projectToolCall(data: unknown, occurredAt: string): ProjectionResult {
    if (!isRecord(data)) return EMPTY
    const callId = data['callId']
    const name = data['name']
    const args = data['arguments']
    if (typeof callId !== 'string' || typeof name !== 'string') return EMPTY
    const argsJson = typeof args === 'string' ? args : '{}'
    this.toolCalls.set(callId, { name, args: argsJson })
    this.openCalls.add(callId)
    const phase = { type: 'run.phase', phase: 'tool' } as const
    return {
      liveTexts: [],
      events: [
        { audience: 'owner', occurredAt, event: phase },
        { audience: 'project', occurredAt, event: phase },
        {
          audience: 'owner',
          occurredAt,
          event: {
            type: 'tool.started',
            callId,
            toolName: name,
            preview: this.buildOwnerPreview(name, argsJson) as WireJson,
          },
        },
        {
          audience: 'project',
          occurredAt,
          // §9 二层收缩：project 只有工具类别，无命令正文/文件名。
          event: {
            type: 'tool.started',
            callId,
            toolName: name,
            preview: { category: toolCategory(name) },
          },
        },
      ],
    }
  }

  private projectToolResult(data: unknown, occurredAt: string): ProjectionResult {
    if (!isRecord(data)) return EMPTY
    const message = data['message']
    const block =
      isRecord(message) && Array.isArray(message['content']) ? message['content'][0] : undefined
    const callId =
      (isRecord(block) && typeof block['toolCallId'] === 'string'
        ? block['toolCallId']
        : undefined) ?? (typeof data['callId'] === 'string' ? data['callId'] : undefined)
    if (callId === undefined) return EMPTY
    this.openCalls.delete(callId)
    const failed = data['error'] !== undefined || (isRecord(block) && block['isError'] === true)
    const event = {
      type: 'tool.finished',
      callId,
      outcome: failed ? 'failed' : 'succeeded',
    } as const
    return this.both(occurredAt, event)
  }

  private projectTurnEnd(data: unknown, occurredAt: string): ProjectionResult {
    const events: ProjectedEventDraft[] = []
    const reason = isRecord(data) ? data['reason'] : undefined
    const kind = isRecord(reason) ? reason['kind'] : undefined
    if (kind !== 'completed') {
      // 非正常收敛（aborted/error/…）：未闭环的 tool call 收 cancelled，不悬空。
      for (const callId of [...this.openCalls]) {
        events.push(
          {
            audience: 'owner',
            occurredAt,
            event: { type: 'tool.finished', callId, outcome: 'cancelled' },
          },
          {
            audience: 'project',
            occurredAt,
            event: { type: 'tool.finished', callId, outcome: 'cancelled' },
          },
        )
      }
    }
    this.openCalls.clear()
    events.push(
      { audience: 'owner', occurredAt, event: { type: 'run.phase', phase: 'finalizing' } },
      { audience: 'project', occurredAt, event: { type: 'run.phase', phase: 'finalizing' } },
    )
    return { events, liveTexts: [] }
  }

  // ---------- approval ----------

  private projectApprovalRequested(
    callId: string,
    toolName: string,
    reason: string,
    occurredAt: string,
  ): ProjectionResult {
    let approvalId = this.approvals.get(callId)
    if (approvalId === undefined) {
      approvalId = this.newId()
      this.approvals.set(callId, approvalId)
    }
    const recorded = this.toolCalls.get(callId)
    const expiresAt = new Date(new Date(occurredAt).getTime() + APPROVAL_TTL_MS).toISOString()
    const base = {
      approvalId,
      runId: this.ctx.runId,
      callId,
      toolName,
      status: 'pending' as const,
      requestedAt: occurredAt,
      expiresAt,
    }
    return {
      liveTexts: [],
      events: [
        {
          audience: 'owner',
          occurredAt,
          event: {
            type: 'approval.requested',
            approval: {
              ...base,
              reason: capStringBytes(redactString(reason, this.ctx), 1000),
              preview: this.buildOwnerPreview(toolName, recorded?.args ?? '{}') as WireJson,
            },
          },
        },
        {
          audience: 'project',
          occurredAt,
          // §8：project 只见「等待责任人批准」——无理由正文、无参数。
          event: {
            type: 'approval.requested',
            approval: { ...base, reason: '', preview: { category: toolCategory(toolName) } },
          },
        },
      ],
    }
  }

  // ---------- preview 构造（§9 规则 5/6/7） ----------

  private buildOwnerPreview(toolName: string, argsJson: string): unknown {
    let args: unknown = {}
    try {
      args = JSON.parse(argsJson)
    } catch {
      // 模型产出的非法 JSON：不猜内容，空 preview。
    }
    const redacted = redactValue(args, this.ctx)
    if (SHELL_TOOL.test(toolName)) {
      // 规则 6：Bash 只显示命令模板（模型产出的原串，未经 shell 展开）。
      const command = isRecord(redacted) ? redacted['command'] : undefined
      return capPreview(typeof command === 'string' ? { command } : {})
    }
    if (FS_TOOL.test(toolName)) {
      // 规则 7：只显示 Workspace 相对路径；越界不产生 preview。相对化在脱敏前
      // 的路径语义上做（raw 参数），随后字符串仍过一遍脱敏兜底。
      const rawPath = isRecord(args) && typeof args['path'] === 'string' ? args['path'] : undefined
      if (rawPath === undefined) return capPreview({})
      const rel = workspaceRelativePath(this.ctx.workspaceRoot, rawPath)
      return capPreview(rel === undefined ? {} : { path: redactString(rel, this.ctx) })
    }
    return capPreview(redacted)
  }

  // ---------- 小工具 ----------

  private both(occurredAt: string, event: ProjectedRunEvent['event']): ProjectionResult {
    return {
      liveTexts: [],
      events: [
        { audience: 'owner', occurredAt, event },
        { audience: 'project', occurredAt, event },
      ],
    }
  }
}
