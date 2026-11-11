/**
 * Hub ↔ Device Node wire（03-领域模型与运行协议.md §6）。
 *
 * 上行（Node → Hub）：§6.2；下行（Hub → Node）：§6.3。
 * Projected Run Event：§6.4；实体字段规则：§2.4 / §2.6。
 */
import { z } from 'zod'
import { PROTOCOL_VERSION, envelope, parseWireFrame } from './envelope.js'
import { ErrorCodeSchema, WireErrorSchema } from './errors.js'
import {
  EXECUTION_CONTEXT_MAX_CHARS,
  HandoffNarrativeSchema,
  HandoffRunSpecSchema,
} from './handoff.js'
import { ManagedDraftSourceManifestSchema } from './managed-draft.js'
import { ApprovalPolicySchema } from './approval.js'
import { MandateInvalidationReasonSchema } from './mandate-invalidation.js'
import { RunToolPolicySchema } from './tool-policy.js'
import {
  SourceCapabilitySchema,
  SourcePermissionCheckPayloadSchema,
  SourcePermissionResultPayloadSchema,
} from './source.js'
import {
  ContextStateAckSchema,
  ContextStatePullSchema,
  ContextStateSyncSchema,
  ProjectContextCapabilitySchema,
  RunContextReceiptSchema,
  RunContextStateSchema,
  RunStartProjectContextSchema,
} from './run-context.js'
import {
  WORK_INPUT_CAPABILITY,
  RunStartWorkInputSchema,
  RunWorkInputReceiptSchema,
} from './work-input-wire.js'

import {
  CoordinationCapabilitySchema,
  DiscoveryRequestPayloadSchema,
  DiscoveryHeartbeatPayloadSchema,
  DiscoveryResultPayloadSchema,
  DiscoveryModelStartAckPayloadSchema,
  DiscoveryCancelPayloadSchema,
  DiscoveryResultAckPayloadSchema,
  CoordinationCredentialSlotSchema,
  CoordinationRequestPayloadSchema,
  CoordinationResultPayloadSchema,
  CoordinationHeartbeatPayloadSchema,
  CoordinationCancelPayloadSchema,
  CoordinationResultAckPayloadSchema,
} from './router.js'

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
export const ProjectedRunExecutorUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export type ProjectedRunExecutorUsage = z.infer<typeof ProjectedRunExecutorUsageSchema>
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
    // #379：收尾整理的交接草稿结果——只由 owner 受众上行（草稿私有；project 行不存在）。
    z.strictObject({
      type: z.literal('handoff.draft'),
      status: z.enum(['generated', 'failed']),
      content: HandoffNarrativeSchema.optional(),
      reason: z.string().min(1).max(1000).optional(),
    }),
    z.strictObject({
      type: z.literal('run.completed'),
      finalText: z.string(),
      usage: ProjectedRunExecutorUsageSchema.optional(),
    }),
    z.strictObject({
      type: z.literal('run.failed'),
      code: ErrorCodeSchema,
      summary: z.string().min(1).max(1000),
      usage: ProjectedRunExecutorUsageSchema.optional(),
    }),
    z.strictObject({
      type: z.literal('run.cancelled'),
      forced: z.boolean(),
      usage: ProjectedRunExecutorUsageSchema.optional(),
    }),
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
    /**
     * ADR-0024 §9：来源读取能力。缺省 = 该 Node 不支持来源绑定；Hub 不向未声明的
     * Node 下发来源帧（旧 Node 会以 PROTOCOL_MISMATCH 关闭连接）。新 Node + 旧 Hub
     * 会因 strictObject 的未知字段被拒，部署顺序固定为 Hub 先升级。
     */
    sourceCapabilities: z.array(SourceCapabilitySchema).max(8).optional(),
    coordinationCapabilities: z.array(CoordinationCapabilitySchema).max(2).optional(),
    /**
     * ADR-0027 §3 / ADR-0028 §3：Run 交付能力。缺省 = 旧 Node；Hub 对非空项目
     * 上下文快照或非空工作输入清单不向未声明的 Node 派发。空清单仍可执行。
     */
    contextCapabilities: z
      .array(z.union([ProjectContextCapabilitySchema, z.literal(WORK_INPUT_CAPABILITY)]))
      .max(8)
      .optional(),
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
    coordinationCredentialSlots: z.array(CoordinationCredentialSlotSchema).max(16).optional(),
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

/** ADR-0027 §4：Node 汇总 Runtime 两级回执后的专用上行帧（不投影成产品 Run 事件）。 */
export const RunContextReceiptFrameSchema = envelope('run.context_receipt', RunContextReceiptSchema)

/**
 * ADR-0027 §4（PC-05b-2）：Hub 对 `run.context_receipt` 的接收回执。Node 只有
 * 收到本帧才删除本地待发项。`highestSeq` 仅在 `accepted`/`duplicate` 时有意义
 * （Hub 已接收的最高序号，允许空洞）；`late`/`rejected` 恒为 0，因为该回执
 * 没有落库，Hub 不承诺任何水位。
 */
export const RunContextReceiptAckFrameSchema = envelope(
  'run.context_receipt_ack',
  z.strictObject({
    runId: z.uuid(),
    snapshotId: z.uuid(),
    receiptSeq: z.number().int().positive(),
    highestSeq: z.number().int().min(0),
    result: z.enum(['accepted', 'duplicate', 'late', 'rejected']),
    reason: z.string().min(1).max(200).optional(),
  }),
)

/** ADR-0028 §3：工作输入交付/读取的专用上行回执（独立于 run.context_receipt）。 */
export const RunWorkInputReceiptFrameSchema = envelope(
  'run.work_input_receipt',
  RunWorkInputReceiptSchema,
)

/** ADR-0027 §6（PC-05b）：Node 摘要不一致/本地缺失时拉取完整状态。 */
export const ContextStatePullFrameSchema = envelope('context.state_pull', ContextStatePullSchema)

/** ADR-0027 §6（PC-05b）：状态文件写入与未读副本清理尝试后的回报。 */
export const ContextStateAckFrameSchema = envelope('context.state_ack', ContextStateAckSchema)

/** #320：只读准备检查，结果不能夹带秘密、路径或模型调用结论。 */
export const PreparationFactsSchema = z.strictObject({
  workspace: z.enum(['available', 'unavailable', 'unconfirmed']),
  credential: z.enum(['configured', 'unconfigured', 'unconfirmed']),
})
export type PreparationFacts = z.infer<typeof PreparationFactsSchema>
export const NodePreparationResultSchema = envelope(
  'node.preparation_result',
  z.strictObject({ requestId: z.uuid(), ...PreparationFactsSchema.shape }),
)
export type NodePreparationResult = z.infer<typeof NodePreparationResultSchema>['payload']
export const NodePreparationCheckSchema = envelope(
  'node.preparation_check',
  z.strictObject({
    requestId: z.uuid(),
    workspaceId: z.uuid(),
    provider: z.string().min(1).max(100),
    credentialSlot: z.string().min(1).max(80),
  }),
)

/** ADR-0024 §5/§9：绑定前的有界只读权限检查（Node → Hub 回 result）。 */
export const SourcePermissionResultSchema = envelope(
  'source.permission_result',
  SourcePermissionResultPayloadSchema,
)

export const CoordinationHeartbeatFrameSchema = envelope(
  'coordination.heartbeat',
  CoordinationHeartbeatPayloadSchema,
)
export const CoordinationResultFrameSchema = envelope(
  'coordination.result',
  CoordinationResultPayloadSchema,
)
export const CoordinationRequestFrameSchema = envelope(
  'coordination.request',
  CoordinationRequestPayloadSchema,
)
export const CoordinationCancelFrameSchema = envelope(
  'coordination.cancel',
  CoordinationCancelPayloadSchema,
)
export const CoordinationResultAckFrameSchema = envelope(
  'coordination.result_ack',
  CoordinationResultAckPayloadSchema,
)

/** Private execution check result; never carries model output, filenames, or diagnostics. */
export const ManagedDraftOutcomeSchema = envelope(
  'managed_draft.outcome',
  z
    .strictObject({
      commandId: z.uuid(),
      runId: z.uuid(),
      manifestDigest: Sha256DigestSchema,
      outcome: z.enum(['completed', 'failed']),
      attemptId: z.uuid().optional(),
    })
    .refine((value) => value.outcome !== 'completed' || value.attemptId !== undefined),
)

const DiscoveryRequestFrameSchema = envelope('discovery.request', DiscoveryRequestPayloadSchema)
const DiscoveryHeartbeatFrameSchema = envelope(
  'discovery.heartbeat',
  DiscoveryHeartbeatPayloadSchema,
)
const DiscoveryResultFrameSchema = envelope('discovery.result', DiscoveryResultPayloadSchema)
const DiscoveryModelStartAckFrameSchema = envelope(
  'discovery.model_start_ack',
  DiscoveryModelStartAckPayloadSchema,
)
const DiscoveryCancelFrameSchema = envelope('discovery.cancel', DiscoveryCancelPayloadSchema)
const DiscoveryResultAckFrameSchema = envelope(
  'discovery.result_ack',
  DiscoveryResultAckPayloadSchema,
)

export const NodeUpstreamSchema = z.discriminatedUnion('type', [
  NodeHelloSchema,
  CoordinationHeartbeatFrameSchema,
  CoordinationResultFrameSchema,
  DiscoveryHeartbeatFrameSchema,
  DiscoveryResultFrameSchema,
  NodeHeartbeatSchema,
  NodeInventorySchema,
  NodePreparationResultSchema,
  SourcePermissionResultSchema,
  CommandAckSchema,
  ManagedDraftOutcomeSchema,
  RunSnapshotFrameSchema,
  RunEventFrameSchema,
  RunLiveDeltaSchema,
  RunContextReceiptFrameSchema,
  RunWorkInputReceiptFrameSchema,
  ContextStatePullFrameSchema,
  ContextStateAckFrameSchema,
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
  z
    .strictObject({
      commandId: z.uuid(),
      runId: z.uuid(),
      taskId: z.uuid(),
      ownerUserId: z.uuid(),
      agent: AgentRunSpecSchema,
      workspaceId: z.uuid(),
      expectedProfileDigest: Sha256DigestSchema,
      expectedPluginPackDigest: Sha256DigestSchema,
      prompt: z.string().min(1).max(20_000),
      // ADR-0009 切片⑧（审批档位，#241）：Hub 已解析固化的档位（Task 覆盖 ??
      // Revision 默认），Node 原样透传进 runtime.initialize。缺省 =
      // approval_required（与既有行为一致）。
      approvalPolicy: ApprovalPolicySchema.optional(),
      // #379（ADR-0017 §3）：Task 已启用约定流程时携带——Node 原样透传进
      // runtime.initialize，Runtime 收尾阶段据此生成交接草稿。
      handoff: HandoffRunSpecSchema.optional(),
      executionContext: z.string().max(EXECUTION_CONTEXT_MAX_CHARS).optional(),
      // ADR-0027 §3：创建事务内冻结的项目上下文快照清单。entryCount=0 时不携带；
      // 正文不在本帧（Node 经受控下载接口按快照取得并逐条核对 digest/byteSize）。
      projectContext: RunStartProjectContextSchema.optional(),
      // ADR-0028 §3：创建事务冻结的工作输入清单（正文不在本帧；Node 经受控下载
      // 接口按 Run 归属取得并逐条核对 digest/byteSize）。
      workInput: RunStartWorkInputSchema.optional(),
      // ADR-0028 §7（RD-03c1）：机器 Run 的固定草稿工具面与 Mandate 步级预批准。
      // 只有 origin='mandate' 携带；Node 原样透传进 runtime.initialize。
      toolPolicy: RunToolPolicySchema.optional(),
      // ADR-0009 切片⑤（resume 续跑）：成对携带——resumeOfRunId 让 Node 把
      // initialize 的 dshHomePath 指向**来源 Run** 的 home（per-run 隔离下新
      // runId 的 home 里没有旧日志）；resumeSessionId（= 来源 Run 的
      // dsh_session_id）直达 Runtime 的装载身份。只带其一即畸形，fail-closed。
      resumeOfRunId: z.uuid().optional(),
      resumeSessionId: DshSessionIdSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if ((value.resumeOfRunId !== undefined) !== (value.resumeSessionId !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: 'resumeOfRunId and resumeSessionId must be provided together',
        })
      }
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

/**
 * ADR-0028 §9（RD-03c2）：Hub 通知 Node，在途机器 Run 的 Mandate 已失效。
 *
 * 不是取消：Run 状态不变、不杀 Runtime；Node 原样转发给 Runtime，由
 * `tools/pre-execute` 的逐次复核阻断写/未授权动作。重复 commandId 只回放 ack。
 */
export const RunMandateInvalidatedSchema = envelope(
  'run.mandate_invalidated',
  z.strictObject({
    commandId: z.uuid(),
    runId: z.uuid(),
    mandateId: z.uuid(),
    reason: MandateInvalidationReasonSchema,
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

/** ADR-0024 §5/§9：绑定前只读权限检查（Hub → Node）；不进 Outbox、不启动 Runtime。 */
export const SourcePermissionCheckSchema = envelope(
  'source.permission_check',
  SourcePermissionCheckPayloadSchema,
)

/** ADR-0027 §6（PC-05b）：完整当前状态（变化时与重连时发送）。 */
export const RunContextStateFrameSchema = envelope('run.context_state', RunContextStateSchema)

/** ADR-0027 §6（PC-05b）：周期性水位/摘要帧；不直接应用 entries。 */
export const ContextStateSyncFrameSchema = envelope('context.state_sync', ContextStateSyncSchema)

/** Metadata-only offer for a provisioned managed host; receipt does not authorize model I/O. */
export const ManagedDraftStartSchema = envelope(
  'managed_draft.start',
  z.strictObject({
    commandId: z.uuid(),
    manifest: ManagedDraftSourceManifestSchema,
    manifestDigest: Sha256DigestSchema,
  }),
)

/** Loopback verification lane, distinct from transport-only preparation. */
export const ManagedDraftExecuteSchema = envelope(
  'managed_draft.execute',
  ManagedDraftStartSchema.shape.payload.extend({
    model: z.string().regex(/^[A-Za-z0-9_./-]{1,128}$/),
  }),
)

export const NodeDownstreamSchema = z.discriminatedUnion('type', [
  CoordinationRequestFrameSchema,
  DiscoveryRequestFrameSchema,
  DiscoveryModelStartAckFrameSchema,
  DiscoveryCancelFrameSchema,
  DiscoveryResultAckFrameSchema,
  CoordinationCancelFrameSchema,
  CoordinationResultAckFrameSchema,
  RunStartSchema,
  ManagedDraftStartSchema,
  ManagedDraftExecuteSchema,
  RunCancelSchema,
  RunMandateInvalidatedSchema,
  RunStatusRequestSchema,
  NodePreparationCheckSchema,
  SourcePermissionCheckSchema,
  RunEventAckSchema,
  RunResendFromSchema,
  RunFollowupSchema,
  ApprovalDecideSchema,
  NodeTokenRevokedSchema,
  RunContextStateFrameSchema,
  ContextStateSyncFrameSchema,
  RunContextReceiptAckFrameSchema,
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
