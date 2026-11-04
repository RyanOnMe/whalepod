/** ADR-0026 §13 / ADR-0028 §17: bounded model evaluations, never business Runs. */
import { z } from 'zod'

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
export const CoordinationCapabilitySchema = z.literal(COORDINATION_CAPABILITY)
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
  kind: z.enum(['source', 'agreement', 'work', 'consumption', 'evidence', 'answer']),
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

/** Local Node/broker wire; local paths never cross Hub wire or enter projections. */
export const RouterRuntimeInitializeSchema = z.strictObject({
  type: z.literal('coordination.initialize'),
  request: CoordinationRequestPayloadSchema,
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
    payload: CoordinationHeartbeatPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('coordination.result'),
    payload: CoordinationResultPayloadSchema,
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
