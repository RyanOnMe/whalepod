/**
 * SessionOwner —— 一个 Run 的 DSH Agent/Session 生命周期持有面
 * （02 Task 11 Step 5）：create（含 run-scoped ports 安装）、followup、cancel、
 * turn 终态收敛（whenIdle → flush → 通知 bridge 发帧）、dispose。
 *
 * dispose 次序是契约：先 cancel 未完成 turn，再 flush session，最后
 * handle.dispose()；任一阶段失败都记结构化日志并继续后续阶段（尽力收敛），
 * 首个错误在收敛完成后抛出。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { createPublishArtifactTool, type ArtifactPort } from './artifact-tool.js'
import { createReadArtifactInputTool } from './artifact-input-tool.js'
import type { WorkspaceArtifactValidator } from './artifact-validation.js'
import type { ApprovalPort } from './approval-port.js'
import type { LogSink } from './log.js'
import { dshSessionIdOf, type RuntimeSpec } from './runtime-spec.js'

/** Run 级事件回调（由 bridge 绑定 runId 后转成 wire output 帧）。 */
export interface SessionOwnerEvents {
  /** DSH SessionEvent 原样透传（03 §7.2；形状由 DSH 拥有）。 */
  sessionEvent(event: SessionEvent): void
  agentStatus(status: AgentStatus): void
  /**
   * 一个 turn 收敛完毕（已 whenIdle + flush）：completed / aborted(reason) /
   * error(LlmFailure) / 其他边界 kind，附带最后一个 assistant message id。
   */
  turnSettled(reason: TurnEndReason, finalMessageId: string | undefined): void
}

export interface RunScopedPorts {
  readonly artifact: ArtifactPort
  readonly approval: ApprovalPort
  /**
   * P1-15：publish_artifact 的桥内工作区校验（realpath/边界/size）。缺省
   * （契约探针）不校验直接登记——生产由 bridge 按 spec.workspacePath 装配。
   */
  readonly artifactValidator?: WorkspaceArtifactValidator
}

/** systemPrompt 服务的结构式（P1-11 只锁十个 DSH 直接依赖，dsh-system-prompt 不在其中）。 */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): unknown
}

/** dsh-system-prompt 的 persona 槽位名；agent scope 同名 section 覆盖部署默认。 */
const PERSONA_SECTION = 'deployment:persona'

export class SessionOwner {
  private settleChain: Promise<void> = Promise.resolve()
  private disposed = false

  private constructor(
    private readonly handle: AgentHandle,
    private readonly ctx: Context,
    private readonly events: SessionOwnerEvents,
    private readonly log: LogSink,
  ) {}

  get agent(): Agent {
    return this.handle.agent
  }

  get session(): Session {
    return this.handle.agent.session
  }

  /**
   * 创建 Run 的 Agent（02 Step 5 的 ctx.agents.create 形态）：run-scoped ports
   * 在 setup 里装进 agent scope —— publish_artifact 工具、审批 answerer、
   * 全量工具调用审批闸、persona section。
   */
  static async create(
    ctx: Context,
    spec: RuntimeSpec,
    ports: RunScopedPorts,
    events: SessionOwnerEvents,
    log: LogSink,
  ): Promise<SessionOwner> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(dshSessionIdOf(spec)),
      meta: { cwd: spec.workspacePath },
      agentOptions: {
        provider: spec.provider,
        model: spec.model,
        ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
      },
      setup: (agentCtx) => {
        agentCtx.tools.register(createPublishArtifactTool(ports.artifact, ports.artifactValidator))
        // P1-15：Reviewer Run 带输入清单时注册只读读取工具（清单为空不注册）。
        if (
          spec.artifactInputs !== undefined &&
          spec.artifactInputs.length > 0 &&
          spec.artifactInputsDir !== undefined
        ) {
          agentCtx.tools.register(
            createReadArtifactInputTool(spec.artifactInputs, spec.artifactInputsDir),
          )
        }
        ports.approval.install(agentCtx)
        // Runtime 姿态：本 Run 内每次工具调用都要回 Node 拿一次性批准（不永久授权）。
        agentCtx.on('tools/pre-execute', (exec): Promise<PreToolDecision> =>
          Promise.resolve({
            kind: 'ask',
            reason: `Run tool call requires approval: ${exec.name}`,
          }),
        )
        const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptLike | undefined
        systemPrompt?.section({ name: PERSONA_SECTION, order: 0, text: spec.persona })
      },
    })
    const owner = new SessionOwner(handle, ctx, events, log)
    owner.subscribe()
    // setup 落定后再向 Node 报 ready（headless runner 同一契约）。
    await handle.agent.whenIdle()
    return owner
  }

  /** `run.prompt` 与 `run.followup` 在桥内同态：排队一次普通 follow-up turn。 */
  followup(text: string): void {
    this.agent.followup(
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    )
  }

  /** `run.cancel`：wire 的 user/parent → DSH 的 AgentCancelCause。 */
  cancel(cause: 'user' | 'parent'): void {
    this.agent.cancel({ kind: cause })
  }

  /** sessions.flush 契约（dsh-session SessionStore.flush）。 */
  async flush(): Promise<boolean> {
    return this.ctx.sessions.flush(this.session)
  }

  private subscribe(): void {
    const sessionId = String(this.session.id)
    this.ctx.on('session/event', (eventSession, event) => {
      if (String(eventSession.id) !== sessionId) return
      this.events.sessionEvent(event)
      if (event.type === 'turn/end') this.queueSettle(event.data.reason)
    })
    this.ctx.on('agent/status', (payload) => {
      if (payload.agent !== this.agent) return
      this.events.agentStatus(payload.status)
    })
  }

  /** turn/end 监听是同步的；whenIdle/flush 的收尾链按序追加，互不重叠。 */
  private queueSettle(reason: TurnEndReason): void {
    this.settleChain = this.settleChain.then(() => this.settle(reason))
  }

  private async settle(reason: TurnEndReason): Promise<void> {
    try {
      await this.agent.whenIdle()
      await this.flush()
    } catch (error) {
      // 收敛/持久化失败不吞：记日志后仍按原 turn 终态通知（Node 侧按帧决策）。
      this.log({
        level: 'error',
        component: 'runtime.bridge.session',
        msg: 'turn settle failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    this.events.turnSettled(reason, this.finalMessageId())
  }

  private finalMessageId(): string | undefined {
    const events = this.session.events
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'assistant/message') return event.data.message.id
    }
    return undefined
  }

  /**
   * dispose 次序契约（02 Step 5）：cancel 未完成 turn → 等收敛（含 turn/end
   * 收尾链）→ flush → handle.dispose()。幂等。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    let firstError: unknown
    const stage = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        firstError ??= error
        this.log({
          level: 'error',
          component: 'runtime.bridge.session',
          msg: `dispose stage failed: ${name}`,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (this.agent.status !== 'idle') this.agent.cancel({ kind: 'disposed' })
    await stage('whenIdle', () => this.agent.whenIdle())
    await stage('settleChain', () => this.settleChain)
    await stage('flush', () => this.flush())
    await stage('agent dispose', () => this.handle.dispose())
    if (firstError !== undefined) throw firstError
  }
}
