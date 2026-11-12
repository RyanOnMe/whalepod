/**
 * ADR-0030 RD-04b：预授权立项的共享协议形状。
 *
 * 这里只放 Hub 入口与人工建 Task 都需要的最小结构，避免 http/handoff/router 互相
 * import 形成环。模板正文仍在 router 的配置请求里。
 */
import { z } from 'zod'

const Id = z.uuid()
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const DiscoveryTierSchema = z.enum(['discover', 'create', 'execute'])
export type DiscoveryTier = z.infer<typeof DiscoveryTierSchema>

/**
 * 人工建 Task 时的槽位分类：认领一个具名槽位，或明确提交「与槽位无关」建议。
 * 后者只是建议，不会把槽位标成空；普通创建者的建议不能维持 eligible_empty。
 */
export const DiscoveryTaskClassificationSchema = z.union([
  z.strictObject({ slotId: Id }),
  z.strictObject({ unrelated: z.literal(true) }),
])
export type DiscoveryTaskClassification = z.infer<typeof DiscoveryTaskClassificationSchema>

/** 责任人确认本人许可：必须确认看过的模板摘要（创建档）。 */
export const DiscoveryPermitRequestSchema = z.strictObject({
  configVersion: Positive,
  tier: DiscoveryTierSchema.optional(),
  templateDigest: Digest.optional(),
})
export type DiscoveryPermitRequest = z.infer<typeof DiscoveryPermitRequestSchema>

/** 责任人核对完整目录：entries 必须与 Hub 当前目录逐项一致。 */
export const DiscoverySlotVerificationRequestSchema = z.strictObject({
  catalogDigest: Digest,
  complete: z.literal(true),
  entries: z
    .array(
      z.strictObject({
        taskId: Id,
        coverage: z.enum(['covered', 'not_covered']),
      }),
    )
    .max(64),
})
export type DiscoverySlotVerificationRequest = z.infer<
  typeof DiscoverySlotVerificationRequestSchema
>

/** 原作者提交版本化更正；原文不改，发现链改用新版本。 */
export const DiscoverySourceCorrectionRequestSchema = z.strictObject({
  body: z.string().trim().min(1).max(20000),
})
export type DiscoverySourceCorrectionRequest = z.infer<
  typeof DiscoverySourceCorrectionRequestSchema
>

/** 核实人确认自己看过的确切来源版本。 */
export const DiscoverySourceVerificationRequestSchema = z.strictObject({
  sourceVersion: z.string().min(1).max(64),
  sourceDigest: Digest,
})
export type DiscoverySourceVerificationRequest = z.infer<
  typeof DiscoverySourceVerificationRequestSchema
>

/** Executor 的实际路由身份；授权时固定，执行前再与部署策略逐项核对。 */
export const DiscoveryExecutionExecutorSchema = z.strictObject({
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  endpoint: z.string().trim().min(1).max(128),
  account: z.string().trim().min(1).max(128),
  /** Deployment policy generation; a newer route/policy must be reconfirmed. */
  policyGeneration: z.number().int().positive().max(2_147_483_647),
})
export type DiscoveryExecutionExecutor = z.infer<typeof DiscoveryExecutionExecutorSchema>

/**
 * RD-04c1：责任人本人对已立项候选的第二次确认。
 * 只接受精确来源包摘要与 Executor 路由；不包含正文、路径或凭据。
 */
export const DiscoveryExecutionAuthorizationRequestSchema = z.strictObject({
  sourceManifestDigest: Digest,
  executor: DiscoveryExecutionExecutorSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  confirmsPrivateDraft: z.literal(true),
})
export type DiscoveryExecutionAuthorizationRequest = z.infer<
  typeof DiscoveryExecutionAuthorizationRequestSchema
>
