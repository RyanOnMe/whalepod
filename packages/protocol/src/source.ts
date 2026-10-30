/**
 * 项目来源绑定（ADR-0024；PC-02a）。
 *
 * 这里只定义团队可见的绑定生命周期与来源权限检查帧；来源正文、修订与上下文条目
 * 由后续切片（PC-03/PC-04）按 ADR-0025 增加。字段语义以 ADR-0024 §10 为准：
 * `resourceKey` 是平台侧不透明资源身份，不进视图；凭据只在采集 Node。
 */
import { z } from 'zod'

/** 首轮只支持飞书；新增平台时同步 capability 与适配器。 */
export const SourcePlatformSchema = z.enum(['feishu'])
export type SourcePlatform = z.infer<typeof SourcePlatformSchema>

/** 一条绑定只对应一个明确资源身份（ADR-0024 §1）。 */
export const SourceKindSchema = z.enum(['group', 'thread', 'doc', 'sheet_range'])
export type SourceKind = z.infer<typeof SourceKindSchema>

/** Node 在 node.hello 里声明的来源读取能力；缺省 = 不支持来源绑定。 */
export const SourceCapabilitySchema = z.enum(['feishu.read.v1'])
export type SourceCapability = z.infer<typeof SourceCapabilitySchema>

export const SourceStatusSchema = z.enum(['active', 'paused', 'unavailable', 'revoked'])
export type SourceStatus = z.infer<typeof SourceStatusSchema>

export const SourcePermissionStateSchema = z.enum(['verified', 'unknown', 'denied'])
export type SourcePermissionState = z.infer<typeof SourcePermissionStateSchema>

/** Node 只读检查的结果；`readable` 必须带回不透明 appKey 供采集租约分桶。 */
export const SourcePermissionCheckResultSchema = z.enum([
  'readable',
  'denied',
  'not_found',
  'unsupported',
])
export type SourcePermissionCheckResult = z.infer<typeof SourcePermissionCheckResultSchema>

/** POST /projects/:projectId/sources（ADR-0024 §10）。 */
export const CreateProjectSourceRequestSchema = z.strictObject({
  platform: SourcePlatformSchema,
  kind: SourceKindSchema,
  /** 平台侧不透明资源身份；不写入日志、不进视图。 */
  resourceKey: z.string().trim().min(1).max(500),
  /** 成员填写、供团队识别的标签；不存平台原名。 */
  displayLabel: z.string().trim().min(1).max(120),
  collectorNodeId: z.uuid(),
  credentialSlot: z.string().trim().min(1).max(80),
  /** 当前没有 Project 私有 ACL：必须显式确认团队共享。 */
  shareScope: z.literal('team'),
  autoExtraction: z.boolean().optional().default(false),
})
export type CreateProjectSourceRequest = z.infer<typeof CreateProjectSourceRequestSchema>

/** POST /sources/:sourceId/revoke：撤销必须说明理由（ADR-0024 §2）。 */
export const RevokeProjectSourceRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
})
export type RevokeProjectSourceRequest = z.infer<typeof RevokeProjectSourceRequestSchema>

/** 来源视图：只含团队可读的生命周期与状态，不含 resourceKey/appKey/凭据。 */
export const ProjectSourceViewSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  platform: SourcePlatformSchema,
  kind: SourceKindSchema,
  displayLabel: z.string().min(1).max(120),
  collectorNodeId: z.uuid(),
  shareScope: z.literal('team'),
  autoExtraction: z.boolean(),
  status: SourceStatusSchema,
  permissionState: SourcePermissionStateSchema,
  permissionCheckedAt: z.iso.datetime({ offset: true }),
  permissionExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  authorizationGeneration: z.number().int().positive(),
  lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
  latestRevisionId: z.uuid().nullable(),
  boundBy: z.uuid(),
  boundAt: z.iso.datetime({ offset: true }),
  pausedAt: z.iso.datetime({ offset: true }).nullable(),
  unavailableAt: z.iso.datetime({ offset: true }).nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  revokedBy: z.uuid().nullable(),
  revokeReason: z.string().min(1).max(500).nullable(),
})
export type ProjectSourceView = z.infer<typeof ProjectSourceViewSchema>

/** 有界只读检查帧的载荷（Hub → Node）；不携带凭据明文。 */
export const SourcePermissionCheckPayloadSchema = z.strictObject({
  requestId: z.uuid(),
  platform: SourcePlatformSchema,
  kind: SourceKindSchema,
  resourceKey: z.string().trim().min(1).max(500),
  credentialSlot: z.string().trim().min(1).max(80),
})
export type SourcePermissionCheckPayload = z.infer<typeof SourcePermissionCheckPayloadSchema>

/** 权限检查结果载荷（Node → Hub）：readable 必须带回 appKey，其余不得带。 */
export const SourcePermissionResultPayloadSchema = z
  .strictObject({
    requestId: z.uuid(),
    result: SourcePermissionCheckResultSchema,
    appKey: z.string().trim().min(1).max(128).optional(),
    upstreamVersion: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.result === 'readable' && value.appKey === undefined) {
      ctx.addIssue({ code: 'custom', message: 'readable result requires appKey' })
    }
    if (value.result !== 'readable' && value.appKey !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'appKey is only allowed for readable result' })
    }
  })
export type SourcePermissionResultPayload = z.infer<typeof SourcePermissionResultPayloadSchema>
