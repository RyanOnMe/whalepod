/**
 * Hub ↔ Device Node wire（03-领域模型与运行协议.md §6）。
 *
 * 上行（Node → Hub）：§6.2；下行（Hub → Node）：§6.3。
 * Projected Run Event：§6.4；实体字段规则：§2.4 / §2.6。
 */
import { z } from 'zod'
import { PROTOCOL_VERSION, envelope, parseWireFrame } from './envelope.js'
import { ErrorCodeSchema, WireErrorSchema } from './errors.js'

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const DshSessionIdSchema = z.string().min(1).max(128)
const CallIdSchema = z.string().min(1).max(128)
const IsoDateTimeSchema = z.iso.datetime({ offset: true })

/** §3.2 Run 状态机（终态：completed/failed/cancelled/lost，终态间禁止迁移）。 */
export const RunStatusSchema = z.enum([
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled',
  'lost',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

/** §3.3 Approval 状态机。 */
export const ApprovalStatusSchema = z.enum([
  'pending',
  'allowed_once',
  'rejected',
  'expired',
  'cancelled',
])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

/** node.upstream run.snapshot 的载荷：Run 面向 Hub 的投影（§2.6 run 表）。 */
export const RunSnapshotSchema = z.strictObject({
  runId: z.uuid(),
  taskId: z.uuid(),
  ownerUserId: z.uuid(),
  agentId: z.uuid(),
  profileRevisionId: z.uuid(),
  deviceId: z.uuid(),
  workspaceId: z.uuid(),
  dshSessionId: DshSessionIdSchema.nullable(),
  status: RunStatusSchema,
  failureCode: ErrorCodeSchema.nullable(),
  failureSummary: z.string().max(1000).nullable(),
  rerunOfRunId: z.uuid().nullable(),
  profileDigest: Sha256DigestSchema,
  pluginPackDigest: Sha256DigestSchema,
  dshDistributionVersion: z.string().min(1).max(64),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
})
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>

/** approval.requested 事件里的 Approval 卡（§2.6 approval 表，reason/preview 已脱敏）。 */
export const ApprovalWireSchema = z.strictObject({
  approvalId: z.uuid(),
  runId: z.uuid(),
  callId: CallIdSchema,
  toolName: z.string().min(1).max(200),
  reason: z.string().max(1000),
  // 工具级 allowlist 的参数摘要，wire 上必须是 JSON 值（§9 脱敏后）。
  preview: z.json(),
  status: ApprovalStatusSchema,
  requestedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
})
export type ApprovalWire = z.infer<typeof ApprovalWireSchema>

/** artifact.candidate 事件里的 Artifact 元数据（§2.6 artifact 表）。 */
export const ArtifactWireSchema = z.strictObject({
  artifactId: z.uuid(),
  runId: z.uuid(),
  title: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().min(0).max(52_428_800),
  sha256: Sha256DigestSchema,
  // 仅 owner 可见（§2.6）：Node 上行携带，Hub 投影时按受众裁剪。
  sourceRelativePath: z.string().min(1).optional(),
})
export type ArtifactWire = z.infer<typeof ArtifactWireSchema>

/** §6.4 Projected Run Event：Node 上行 run.event 的载荷，已过脱敏策略。 */
export const ProjectedRunEventSchema = z.strictObject({
  runId: z.uuid(),
  seq: z.number().int().positive(),
  occurredAt: IsoDateTimeSchema,
  audience: z.enum(['owner', 'project', 'admin']),
  event: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('runtime.ready'), dshSessionId: DshSessionIdSchema }),
    z.strictObject({
      type: z.literal('run.phase'),
      phase: z.enum(['thinking', 'tool', 'finalizing']),
    }),
    z.strictObject({ type: z.literal('assistant.message'), text: z.string().min(1) }),
    z.strictObject({
      type: z.literal('tool.started'),
      callId: CallIdSchema,
      toolName: z.string().min(1).max(200),
      // §6.4 记为 unknown：脱敏后的 preview，wire 上必须是 JSON 值。
      preview: z.json(),
    }),
    z.strictObject({
      type: z.literal('tool.finished'),
      callId: CallIdSchema,
      outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    }),
    z.strictObject({ type: z.literal('approval.requested'), approval: ApprovalWireSchema }),
    z.strictObject({
      type: z.literal('approval.decided'),
      approvalId: z.uuid(),
      // §3.3 的已决终态（pending 不会出现在 decided 事件里）。
      status: z.enum(['allowed_once', 'rejected', 'expired', 'cancelled']),
    }),
    z.strictObject({ type: z.literal('artifact.candidate'), artifact: ArtifactWireSchema }),
    z.strictObject({
      type: z.literal('subagent.started'),
      childSessionId: DshSessionIdSchema,
      label: z.string().min(1).max(80).optional(),
    }),
    z.strictObject({
      type: z.literal('subagent.finished'),
      childSessionId: DshSessionIdSchema,
      outcome: z.string().min(1),
    }),
    z.strictObject({ type: z.literal('run.completed'), finalText: z.string() }),
    z.strictObject({
      type: z.literal('run.failed'),
      code: ErrorCodeSchema,
      summary: z.string().min(1).max(1000),
    }),
    z.strictObject({ type: z.literal('run.cancelled'), forced: z.boolean() }),
  ]),
})
export type ProjectedRunEvent = z.infer<typeof ProjectedRunEventSchema>

export const PROJECTED_RUN_EVENT_TYPES = ProjectedRunEventSchema.shape.event.options.map(
  (option) => option.shape.type.value,
)

// ---------- §6.2 Node 上行 ----------

export const NodeHelloSchema = envelope(
  'node.hello',
  z.strictObject({
    deviceId: z.uuid(),
    nodeVersion: z.string().min(1).max(32),
    platform: z.enum(['darwin', 'linux', 'win32']),
    architecture: z.string().min(1).max(32),
    // 第一阶段只支持 protocolVersion 1（§11：不含 1 时 Hub 立即关闭连接）。
    supportedProtocolVersions: z.tuple([z.literal(PROTOCOL_VERSION)]),
    dshDistributionVersion: z.string().min(1).max(64),
    pluginPackDigests: z.array(Sha256DigestSchema),
  }),
)

export const NodeHeartbeatSchema = envelope(
  'node.heartbeat',
  z.strictObject({
    deviceId: z.uuid(),
    activeRunIds: z.array(z.uuid()),
    lastEventSeqByRun: z.record(z.uuid(), z.number().int().positive()),
  }),
)

export const NodeInventorySchema = envelope(
  'node.inventory',
  z.strictObject({
    deviceId: z.uuid(),
    credentialSlots: z.array(
      z.strictObject({
        provider: z.string().min(1).max(100),
        slot: z.string().min(1).max(80),
      }),
    ),
    workspaces: z.array(
      z.strictObject({
        workspaceId: z.uuid(),
        name: z.string().min(1).max(80),
        kind: z.enum(['directory', 'git_repository']),
        capabilities: z.strictObject({
          read: z.boolean(),
          write: z.boolean(),
          git: z.boolean(),
        }),
        available: z.boolean(),
        lastCheckedAt: IsoDateTimeSchema,
      }),
    ),
  }),
)

export const CommandAckSchema = envelope(
  'command.ack',
  z.strictObject({
    commandId: z.uuid(),
    accepted: z.boolean(),
    error: WireErrorSchema.optional(),
  }),
)

export const RunSnapshotFrameSchema = envelope('run.snapshot', RunSnapshotSchema)
export const RunEventFrameSchema = envelope('run.event', ProjectedRunEventSchema)

export const RunLiveDeltaSchema = envelope(
  'run.live_delta',
  z.strictObject({
    runId: z.uuid(),
    deltaSeq: z.number().int().positive(),
    text: z.string(),
  }),
)

export const NodeUpstreamSchema = z.discriminatedUnion('type', [
  NodeHelloSchema,
  NodeHeartbeatSchema,
  NodeInventorySchema,
  CommandAckSchema,
  RunSnapshotFrameSchema,
  RunEventFrameSchema,
  RunLiveDeltaSchema,
])
export type NodeUpstream = z.infer<typeof NodeUpstreamSchema>

// ---------- §6.3 Hub 下行 ----------

/** run.start 里固化的 Agent/Profile Revision 快照（§2.3、§6.3）。 */
export const AgentRunSpecSchema = z.strictObject({
  id: z.uuid(),
  profileRevisionId: z.uuid(),
  persona: z.string().min(1).max(20_000),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  credentialSlot: z.string().min(1).max(80),
  maxTokens: z.number().int().positive().optional(),
})
export type AgentRunSpec = z.infer<typeof AgentRunSpecSchema>

export const RunStartSchema = envelope(
  'run.start',
  z.strictObject({
    commandId: z.uuid(),
    runId: z.uuid(),
    taskId: z.uuid(),
    ownerUserId: z.uuid(),
    agent: AgentRunSpecSchema,
    workspaceId: z.uuid(),
    expectedProfileDigest: Sha256DigestSchema,
    expectedPluginPackDigest: Sha256DigestSchema,
    prompt: z.string().min(1).max(20_000),
  }),
)

export const RunCancelSchema = envelope(
  'run.cancel',
  z.strictObject({
    commandId: z.uuid(),
    runId: z.uuid(),
    cause: z.enum(['user', 'admin']),
  }),
)

export const RunStatusRequestSchema = envelope(
  'run.status_request',
  z.strictObject({
    commandId: z.uuid(),
    runId: z.uuid(),
  }),
)

export const RunEventAckSchema = envelope(
  'run.event_ack',
  z.strictObject({
    runId: z.uuid(),
    throughSeq: z.number().int().positive(),
  }),
)

export const RunResendFromSchema = envelope(
  'run.resend_from',
  z.strictObject({
    runId: z.uuid(),
    fromSeq: z.number().int().positive(),
  }),
)

export const ApprovalDecideSchema = envelope(
  'approval.decide',
  z.strictObject({
    commandId: z.uuid(),
    runId: z.uuid(),
    approvalId: z.uuid(),
    callId: CallIdSchema,
    decision: z.enum(['allowed_once', 'rejected']),
  }),
)

/**
 * run.followup（#180 / ADR-0009 决策 3）：Run 执行期间「继续说话」的下行帧。
 *
 * 与 `run.start` 的 `prompt` 不同，它不是新 Run 的首轮输入，而是**注入当前 Run
 * 会话**的一次追问（Runtime 侧排队成一次 follow-up turn，不新开 Run、不换 session）。
 * 命名：`run.followup` 两侧都有，按本仓既有避让方向——**runtime 侧加前缀、node 侧留平名**
 * （先例：本文件的 `RunCancelSchema` / `ApprovalDecideSchema` ↔ runtime-wire 的
 * `RuntimeRunCancelSchema` / `RuntimeApprovalDecideSchema`）。故本地 wire 那个改名
 * `RuntimeRunFollowupSchema`，本帧就是平的 `RunFollowupSchema`。
 *
 * 受理与否由既有 `command.ack { commandId, accepted, error? }` 回报：`accepted=true`
 * 的含义是「已受理并下发到 Runtime stdin」，**不是**「模型已读到」——进展仍走既有
 * `session.event` / `run.*` 上行帧。Hub 侧据此把指令 `instruction_state` 落 accepted
 * （切片③）。
 */
export const RunFollowupSchema = envelope(
  'run.followup',
  z.strictObject({
    commandId: z.uuid(),
    runId: z.uuid(),
    text: z.string().min(1).max(20_000),
  }),
)

export const NodeTokenRevokedSchema = envelope(
  'node.token_revoked',
  z.strictObject({
    reason: z.string().min(1),
  }),
)

export const NodeDownstreamSchema = z.discriminatedUnion('type', [
  RunStartSchema,
  RunCancelSchema,
  RunStatusRequestSchema,
  RunEventAckSchema,
  RunResendFromSchema,
  RunFollowupSchema,
  ApprovalDecideSchema,
  NodeTokenRevokedSchema,
])
export type NodeDownstream = z.infer<typeof NodeDownstreamSchema>

export const NODE_UPSTREAM_TYPES = NodeUpstreamSchema.options.map(
  (option) => option.shape.type.value,
)
export const NODE_DOWNSTREAM_TYPES = NodeDownstreamSchema.options.map(
  (option) => option.shape.type.value,
)

/**
 * 解析 Node wire 帧（fail-closed，§11）：
 * 未知 command type 或版本不符 → PROTOCOL_MISMATCH（Node 不执行）；
 * 载荷畸形 → VALIDATION_FAILED。
 */
export function parseNodeFrame(input: unknown, direction: 'upstream'): NodeUpstream
export function parseNodeFrame(input: unknown, direction: 'downstream'): NodeDownstream
export function parseNodeFrame(
  input: unknown,
  direction: 'upstream' | 'downstream',
): NodeUpstream | NodeDownstream {
  return direction === 'upstream'
    ? parseWireFrame({ schema: NodeUpstreamSchema, knownTypes: NODE_UPSTREAM_TYPES, input })
    : parseWireFrame({ schema: NodeDownstreamSchema, knownTypes: NODE_DOWNSTREAM_TYPES, input })
}
