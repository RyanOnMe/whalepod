/**
 * Node ↔ DSH Runtime wire（03-领域模型与运行协议.md §7）。
 *
 * Runtime 子进程 stdout 只写 NDJSON 协议帧，stdin 收命令；本条 wire
 * 不离开 Device，workspacePath 等绝对路径只允许出现在这里（红线：
 * Hub 数据、日志、WebSocket 与 Evidence 中不得出现绝对路径）。
 */
import { z } from 'zod'
import { envelope, parseWireFrame } from './envelope.js'
import { ErrorCodeSchema } from './errors.js'

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const DshSessionIdSchema = z.string().min(1).max(128)
const CallIdSchema = z.string().min(1).max(128)

// ---------- §7.1 Node 命令（stdin） ----------

export const RuntimeInitializeSchema = envelope(
  'runtime.initialize',
  z.strictObject({
    runId: z.uuid(),
    // Node 本地绝对路径，仅存在于本条本地 wire；fixture 中用 <workspace> 占位。
    workspacePath: z.string().min(1),
    dshHomePath: z.string().min(1),
    profileDigest: Sha256DigestSchema,
    pluginPackDigest: Sha256DigestSchema,
    // P1-17：Node preflight 为该 pack 生成的 Cordis overlay yml 绝对路径（本地
    // wire 专用——Runtime 在本机按该路径加载 patch 层）。不进 Hub、日志与
    // evidence（红线同 workspacePath）；pack 为 core-empty 时不携带。
    pluginPackOverlayPath: z.string().min(1).optional(),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    maxTokens: z.number().int().positive().optional(),
    persona: z.string().min(1).max(20_000),
  }),
)

export const RunPromptSchema = envelope(
  'run.prompt',
  z.strictObject({
    runId: z.uuid(),
    text: z.string().min(1).max(20_000),
  }),
)

export const RunFollowupSchema = envelope(
  'run.followup',
  z.strictObject({
    runId: z.uuid(),
    text: z.string().min(1).max(20_000),
  }),
)

export const RuntimeRunCancelSchema = envelope(
  'run.cancel',
  z.strictObject({
    runId: z.uuid(),
    cause: z.enum(['user', 'parent']),
  }),
)

export const RuntimeApprovalDecideSchema = envelope(
  'approval.decide',
  z.strictObject({
    runId: z.uuid(),
    callId: CallIdSchema,
    decision: z.enum(['allowed_once', 'rejected']),
  }),
)

export const RuntimeShutdownSchema = envelope(
  'runtime.shutdown',
  z.strictObject({
    runId: z.uuid(),
  }),
)

export const RuntimeCommandSchema = z.discriminatedUnion('type', [
  RuntimeInitializeSchema,
  RunPromptSchema,
  RunFollowupSchema,
  RuntimeRunCancelSchema,
  RuntimeApprovalDecideSchema,
  RuntimeShutdownSchema,
])
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>

// ---------- §7.2 Runtime 事件（stdout NDJSON） ----------

export const RuntimeReadySchema = envelope(
  'runtime.ready',
  z.strictObject({
    runId: z.uuid(),
    dshSessionId: DshSessionIdSchema,
  }),
)

export const SessionEventSchema = envelope(
  'session.event',
  z.strictObject({
    runId: z.uuid(),
    dshSessionId: DshSessionIdSchema,
    // 全协议唯一的 z.unknown()（02 Task 3 Step 3）：DSH SessionEvent 形状由
    // DSH 拥有，Runtime Adapter 归一化后才允许进入 Hub wire（03 §11）。
    event: z.unknown(),
  }),
)

export const AgentStatusSchema = envelope(
  'agent.status',
  z.strictObject({
    runId: z.uuid(),
    status: z.enum(['running', 'idle']),
  }),
)

export const RuntimeApprovalRequestedSchema = envelope(
  'approval.requested',
  z.strictObject({
    runId: z.uuid(),
    callId: CallIdSchema,
    toolName: z.string().min(1).max(200),
    reason: z.string().min(1).max(1000),
  }),
)

export const RuntimeArtifactCandidateSchema = envelope(
  'artifact.candidate',
  z.strictObject({
    runId: z.uuid(),
    relativePath: z.string().min(1),
    title: z.string().min(1).max(200),
    mediaType: z.string().min(1).max(200),
  }),
)

export const RuntimeRunCompletedSchema = envelope(
  'run.completed',
  z.strictObject({
    runId: z.uuid(),
    dshSessionId: DshSessionIdSchema,
    finalMessageId: z.string().min(1).optional(),
  }),
)

export const RuntimeRunCancelledSchema = envelope(
  'run.cancelled',
  z.strictObject({
    runId: z.uuid(),
  }),
)

export const RuntimeFatalSchema = envelope(
  'runtime.fatal',
  z.strictObject({
    runId: z.uuid(),
    code: ErrorCodeSchema,
    summary: z.string().min(1).max(1000),
  }),
)

export const RuntimeOutputSchema = z.discriminatedUnion('type', [
  RuntimeReadySchema,
  SessionEventSchema,
  AgentStatusSchema,
  RuntimeApprovalRequestedSchema,
  RuntimeArtifactCandidateSchema,
  RuntimeRunCompletedSchema,
  RuntimeRunCancelledSchema,
  RuntimeFatalSchema,
])
export type RuntimeOutput = z.infer<typeof RuntimeOutputSchema>

export const RUNTIME_COMMAND_TYPES = RuntimeCommandSchema.options.map(
  (option) => option.shape.type.value,
)
export const RUNTIME_OUTPUT_TYPES = RuntimeOutputSchema.options.map(
  (option) => option.shape.type.value,
)

/**
 * 解析 Runtime wire 帧（fail-closed，§11）：
 * 未知 command → PROTOCOL_MISMATCH（Runtime 不执行）；
 * 未知 Runtime output → PROTOCOL_MISMATCH（Node 据此使当前 Run 失败）。
 */
export function parseRuntimeFrame(input: unknown, direction: 'command'): RuntimeCommand
export function parseRuntimeFrame(input: unknown, direction: 'output'): RuntimeOutput
export function parseRuntimeFrame(
  input: unknown,
  direction: 'command' | 'output',
): RuntimeCommand | RuntimeOutput {
  return direction === 'command'
    ? parseWireFrame({ schema: RuntimeCommandSchema, knownTypes: RUNTIME_COMMAND_TYPES, input })
    : parseWireFrame({ schema: RuntimeOutputSchema, knownTypes: RUNTIME_OUTPUT_TYPES, input })
}
