/** ADR-0026 §13 / ADR-0028 §17: bounded model evaluations, never business Runs. */
import { z } from 'zod'
import { DiscoveryTierSchema } from './discovery.js'

const Id = z.uuid()
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Time = z.iso.datetime({ offset: true })
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Reason = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64)
export const COORDINATION_CAPABILITY = 'coordination.v1' as const
// Capability pins the discovery worker prompt; old advertisements still parse for legacy Router.
export const DISCOVERY_CAPABILITY = 'discovery.v2' as const
export const CoordinationCapabilitySchema = z.enum([
  COORDINATION_CAPABILITY,
  'discovery.v1',
  DISCOVERY_CAPABILITY,
])
export type CoordinationCapability = z.infer<typeof CoordinationCapabilitySchema>
export const CoordinationCredentialSlotSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  slot: z.string().min(1).max(80),
  scope: z.literal('coordination'),
  ownerUserId: Id,
  billingUserId: Id,
  configRevision: z.string().min(1).max(128),
})
export type CoordinationCredentialSlot = z.infer<typeof CoordinationCredentialSlotSchema>
export const ConfigureProjectRouterRequestSchema = z.strictObject({
  enabled: z.boolean(),
  deviceId: Id,
  operatorUserId: Id,
  billingUserId: Id,
  credentialSlot: z.string().min(1).max(80),
  credentialConfigRevision: z.string().min(1).max(128),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  teamDailyCallLimit: Positive,
  teamDailyTokenLimit: Positive,
  teamDailyCostMicrosLimit: Positive,
  projectDailyCallLimit: Positive,
  projectDailyTokenLimit: Positive,
  projectDailyCostMicrosLimit: Positive,
  maxInputTokens: z.number().int().positive().max(128_000),
  maxOutputTokens: z.number().int().positive().max(32_768),
  maxCostMicros: Positive,
  inputPriceMicrosPerMillionTokens: Positive,
  outputPriceMicrosPerMillionTokens: Positive,
  timeoutSeconds: z.number().int().positive().max(120),
  maxRetries: z.number().int().nonnegative().max(10),
})
export type ConfigureProjectRouterRequest = z.infer<typeof ConfigureProjectRouterRequestSchema>
export const CoordinationInputEntrySchema = z.strictObject({
  id: Id,
  kind: z.enum(['source', 'agreement', 'work', 'consumption', 'evidence', 'answer', 'slot']),
  sourceId: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  digest: Digest,
  byteSize: z.number().int().nonnegative().max(262_144),
  authorizationGeneration: z.string().min(1).max(128),
})
export type CoordinationInputEntry = z.infer<typeof CoordinationInputEntrySchema>
export const CoordinationInputDownloadSchema = CoordinationInputEntrySchema.extend({
  bodyBase64: z.string().max(349_528),
})
export const RouterCoverageSchema = z
  .strictObject({
    inputId: Id,
    status: z.enum(['covered', 'uncovered', 'unknown']),
    evidenceIds: z.array(Id).max(32),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'covered' && value.evidenceIds.length === 0)
      ctx.addIssue({ code: 'custom', message: 'covered requires evidence', path: ['evidenceIds'] })
  })
const ProposalBase = {
  summary: z.string().min(1).max(1000),
  citations: z.array(Id).min(1).max(32),
  coverage: z.array(RouterCoverageSchema).min(1).max(32),
}
export const RouterProposalSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...ProposalBase,
    decision: z.literal('dispatch'),
    workKey: Id,
    actionClass: z.enum(['research', 'analysis', 'draft', 'revise']),
  }),
  z.strictObject({
    ...ProposalBase,
    decision: z.literal('wait'),
    reason: Reason,
    deadlineAt: Time,
  }),
  z.strictObject({ ...ProposalBase, decision: z.literal('ignore'), reason: Reason }),
  z
    .strictObject({
      ...ProposalBase,
      decision: z.literal('ask'),
      questionType: z.enum(['choose_option', 'authorize_scope']),
      blockedDecision: z.string().min(1).max(64),
      options: z
        .array(z.strictObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(200) }))
        .min(1)
        .max(8),
      recommendedOptionId: z.string().min(1).max(64).nullable(),
    })
    .superRefine((value, ctx) => {
      if (new Set(value.options.map((option) => option.id)).size !== value.options.length)
        ctx.addIssue({
          code: 'custom',
          message: 'option identities must be unique',
          path: ['options'],
        })
      if (
        value.recommendedOptionId !== null &&
        !value.options.some((option) => option.id === value.recommendedOptionId)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'recommendation must reference an option',
          path: ['recommendedOptionId'],
        })
    }),
])
export type RouterProposal = z.infer<typeof RouterProposalSchema>
export const CoordinationUsageSchema = z.strictObject({
  inputTokens: Count,
  outputTokens: Count,
  costMicros: Count,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
})
export type CoordinationUsage = z.infer<typeof CoordinationUsageSchema>
const EvaluationBinding = {
  evaluationId: Id,
  attempt: Positive,
  leaseToken: z.string().min(32).max(256),
}
export const CoordinationRequestPayloadSchema = z.strictObject({
  ...EvaluationBinding,
  evaluationDigest: Digest,
  projectId: Id,
  workKey: Id,
  taskId: Id,
  principalUserId: Id,
  billingUserId: Id,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  credentialSlot: z.string().min(1).max(80),
  credentialConfigRevision: z.string().min(1).max(128),
  configVersion: Positive,
  manifest: z.array(CoordinationInputEntrySchema).min(1).max(32),
  inputTokensEstimate: Positive,
  maxInputTokens: z.number().int().positive().max(128_000),
  maxOutputTokens: z.number().int().positive().max(32_768),
  maxCostMicros: Positive,
  inputPriceMicrosPerMillionTokens: Positive,
  outputPriceMicrosPerMillionTokens: Positive,
  leaseExpiresAt: Time,
  deadlineAt: Time,
})
export type CoordinationRequest = z.infer<typeof CoordinationRequestPayloadSchema>
export const CoordinationHeartbeatPayloadSchema = z.strictObject({
  ...EvaluationBinding,
  readEntryIds: z.array(Id).max(32),
  modelStartedAt: Time.optional(),
})
export type CoordinationHeartbeat = z.infer<typeof CoordinationHeartbeatPayloadSchema>
export const CoordinationResultPayloadSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...EvaluationBinding,
    evaluationDigest: Digest,
    status: z.literal('completed'),
    resultDigest: Digest,
    proposal: RouterProposalSchema,
    usage: CoordinationUsageSchema.optional(),
    readEntryIds: z.array(Id).max(32),
  }),
  z.strictObject({
    ...EvaluationBinding,
    evaluationDigest: Digest,
    status: z.literal('failed'),
    failureCode: Reason,
    usage: CoordinationUsageSchema.optional(),
    readEntryIds: z.array(Id).max(32),
  }),
])
export type CoordinationResult = z.infer<typeof CoordinationResultPayloadSchema>
export const CoordinationResultAckPayloadSchema = z.strictObject({
  ...EvaluationBinding,
  status: z.enum(['accepted', 'duplicate', 'rejected', 'late']),
})
export type CoordinationResultAck = z.infer<typeof CoordinationResultAckPayloadSchema>
export const CoordinationCancelPayloadSchema = z.strictObject({
  ...EvaluationBinding,
  reason: Reason,
})
export type CoordinationCancel = z.infer<typeof CoordinationCancelPayloadSchema>

/** ADR-0030: independent output and purpose binding. Legacy Router wire remains strict. */
export const DiscoveryRequestPayloadSchema = CoordinationRequestPayloadSchema.omit({
  workKey: true,
  taskId: true,
}).extend({
  purpose: z.literal('discovery'),
  promptVersion: z.literal(DISCOVERY_CAPABILITY),
  operatorUserId: Id,
  permitVersion: Positive,
  coverageComplete: z.boolean(),
})
export type DiscoveryRequest = z.infer<typeof DiscoveryRequestPayloadSchema>

export const DiscoveryProposalSchema = z.strictObject({
  classification: z.enum(['covered', 'independent_gap', 'insufficient', 'irrelevant']),
  source: Id,
  slot: Id.nullable(),
  citations: z.array(Id).max(30),
  reason: z.string().min(1).max(1000),
})
export type DiscoveryProposal = z.infer<typeof DiscoveryProposalSchema>
const DiscoveryPurpose = { purpose: z.literal('discovery') }
export const DiscoveryHeartbeatPayloadSchema =
  CoordinationHeartbeatPayloadSchema.extend(DiscoveryPurpose)
export const DiscoveryCancelPayloadSchema = CoordinationCancelPayloadSchema.extend(DiscoveryPurpose)
export const DiscoveryResultAckPayloadSchema =
  CoordinationResultAckPayloadSchema.extend(DiscoveryPurpose)
export const DiscoveryModelStartAckPayloadSchema = z.strictObject({
  ...EvaluationBinding,
  ...DiscoveryPurpose,
})
export const DiscoveryResultPayloadSchema = z.discriminatedUnion('status', [
  CoordinationResultPayloadSchema.options[0].extend({
    ...DiscoveryPurpose,
    proposal: DiscoveryProposalSchema,
  }),
  CoordinationResultPayloadSchema.options[1].extend(DiscoveryPurpose),
])
export type DiscoveryResult = z.infer<typeof DiscoveryResultPayloadSchema>
export type DiscoveryHeartbeat = z.infer<typeof DiscoveryHeartbeatPayloadSchema>
export type DiscoveryResultAck = z.infer<typeof DiscoveryResultAckPayloadSchema>
export const AnyCoordinationRequestSchema = z.union([
  CoordinationRequestPayloadSchema,
  DiscoveryRequestPayloadSchema,
])
export const AnyCoordinationResultSchema = z.union([
  CoordinationResultPayloadSchema,
  DiscoveryResultPayloadSchema,
])
export type AnyCoordinationRequest = z.infer<typeof AnyCoordinationRequestSchema>
export type AnyCoordinationResult = z.infer<typeof AnyCoordinationResultSchema>

/** 与 TaskSpecContentSchema 同形；此处内联避免 router ↔ task-views ↔ node-wire 的模块环。 */
const DiscoveryTemplateSchema = z.strictObject({
  goal: z.string().max(10000),
  constraints: z.string().max(10000),
  acceptance: z.string().max(10000),
  openQuestions: z.string().max(10000),
})

export const ConfigureDiscoveryRequestSchema = z.strictObject({
  enabled: z.boolean(),
  entryTaskId: Id,
  principalUserId: Id,
  activity: z.string().trim().min(1).max(120),
  slot: z.string().trim().min(1).max(240),
  templateVersion: z.string().trim().min(1).max(128),
  expiresAt: Time,
  maxCalls: Positive,
  maxTokens: Positive,
  maxCostMicros: Positive,
  evidenceArtifactIds: z.array(Id).max(16).default([]),
  agreementTaskIds: z.array(Id).max(16).default([]),
  /** RD-04b：项目允许的最高档位；责任人许可不得超出。默认仅发现，保持旧配置语义。 */
  tier: DiscoveryTierSchema.default('discover'),
  /** 责任人确认时冻结的约定模板；仅当 tier 含立项时要求目标与验收非空。 */
  template: DiscoveryTemplateSchema.default({
    goal: '',
    constraints: '',
    acceptance: '',
    openQuestions: '',
  }),
  /** 预登记的独立核实人；作者本人永远不能核实自己的评论。 */
  verifierUserIds: z.array(Id).max(16).default([]),
  /** 同一许可下最多自动立项数（含人工认领不同槽位的路径不计入）。 */
  maxCreations: Positive.max(2_147_483_647).default(1),
})
export type ConfigureDiscoveryRequest = z.infer<typeof ConfigureDiscoveryRequestSchema>
export const DiscoveryConsentRequestSchema = z.strictObject({ configVersion: Positive })

/** Local Node/broker wire; local paths never cross Hub wire or enter projections. */
export const RouterRuntimeInitializeSchema = z.strictObject({
  type: z.literal('coordination.initialize'),
  request: AnyCoordinationRequestSchema,
  inputsDir: z.string().min(1),
  homePath: z.string().min(1),
  endpoint: z.string().url(),
})
export type RouterRuntimeInitialize = z.infer<typeof RouterRuntimeInitializeSchema>
export const RouterRuntimeInputSchema = z.discriminatedUnion('type', [
  RouterRuntimeInitializeSchema,
  z.strictObject({
    type: z.literal('coordination.model_start_ack'),
    payload: z.strictObject(EvaluationBinding),
  }),
  z.strictObject({
    type: z.literal('coordination.cancel'),
    payload: CoordinationCancelPayloadSchema,
  }),
])
export type RouterRuntimeInput = z.infer<typeof RouterRuntimeInputSchema>
export const RouterRuntimeOutputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('coordination.heartbeat'),
    payload: z.union([CoordinationHeartbeatPayloadSchema, DiscoveryHeartbeatPayloadSchema]),
  }),
  z.strictObject({
    type: z.literal('coordination.result'),
    payload: AnyCoordinationResultSchema,
  }),
])
export type RouterRuntimeOutput = z.infer<typeof RouterRuntimeOutputSchema>

/** Conservative, shared bound for JSON-escaped input and bounded prompt overhead. */
export function coordinationInputTokenEstimate(
  manifest: readonly CoordinationInputEntry[],
): number {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength
  const estimate = manifest.reduce((sum, entry) => sum + entry.byteSize * 6, 0) + bytes * 2 + 16_384
  if (!Number.isSafeInteger(estimate))
    throw new Error('coordination input estimate exceeds safe range')
  return estimate
}

export function coordinationUsageCost(input: {
  inputTokens: number
  outputTokens: number
  inputPriceMicrosPerMillionTokens: number
  outputPriceMicrosPerMillionTokens: number
}): number {
  for (const value of [
    input.inputTokens,
    input.outputTokens,
    input.inputPriceMicrosPerMillionTokens,
    input.outputPriceMicrosPerMillionTokens,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('coordination cost inputs must be nonnegative safe integers')
  const numerator =
    BigInt(input.inputTokens) * BigInt(input.inputPriceMicrosPerMillionTokens) +
    BigInt(input.outputTokens) * BigInt(input.outputPriceMicrosPerMillionTokens)
  const cost = Number((numerator + 999_999n) / 1_000_000n)
  if (!Number.isSafeInteger(cost)) throw new Error('coordination cost exceeds safe range')
  return cost
}
