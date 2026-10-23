/**
 * Office 只读 PDF 预览（#431；ADR-0021 §2「预览绑定」）。
 *
 * 预览是**派生的阅读副本**，不是新的交付物版本：它与原件的 sha256 绑定，
 * 权限永远继承原件；转换失败只影响预览，不影响原件交付。
 *
 * 这些 schema 只用于 Node ↔ Hub 的派生件上传与 Web 读面；不进入 DSH wire。
 */
import { z } from 'zod'

/** 派生 PDF 与原件的共同上限（50 MiB，02 Global Constraints）。 */
export const ARTIFACT_PREVIEW_MAX_BYTES = 52_428_800

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

/** 稳定转换器标识（如 `libreoffice`；不含本机路径或版本参数）。 */
const ConverterSchema = z.string().min(1).max(100)

/**
 * PUT /node/artifacts/:artifactId/preview 的 query 元数据（body 为 PDF 原始字节）。
 * `sourceSha256` 必须等于原件的 sha256：防止把旧版本/错误文件的预览挂到新版本上。
 */
export const ArtifactPreviewUploadMetadataSchema = z.strictObject({
  sourceSha256: Sha256Schema,
  sha256: Sha256Schema,
  byteSize: z.number().int().min(1).max(ARTIFACT_PREVIEW_MAX_BYTES),
  converter: ConverterSchema,
})
export type ArtifactPreviewUploadMetadata = z.infer<typeof ArtifactPreviewUploadMetadataSchema>

/**
 * POST /node/artifacts/:artifactId/preview-failure：转换失败也要登记，读面才能
 * 区分「还没有预览」与「转换过但失败」并给出下载回退。reason 只接受稳定码/短句，
 * 不允许携带本机路径（Node 侧负责脱敏）。
 */
export const ArtifactPreviewFailureRequestSchema = z.strictObject({
  sourceSha256: Sha256Schema,
  converter: ConverterSchema,
  reason: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^[^\p{Cc}]+$/u),
})
export type ArtifactPreviewFailureRequest = z.infer<typeof ArtifactPreviewFailureRequestSchema>

export const ArtifactPreviewStatusSchema = z.enum(['none', 'ready', 'failed'])
export type ArtifactPreviewStatus = z.infer<typeof ArtifactPreviewStatusSchema>

/** GET /artifacts/:artifactId/preview-info（可读原件即可读；不授予任何新权限）。 */
export const ArtifactPreviewViewSchema = z.strictObject({
  artifactId: z.uuid(),
  status: ArtifactPreviewStatusSchema,
  sourceSha256: Sha256Schema.nullable(),
  converter: z.string().nullable(),
  mediaType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
})
export type ArtifactPreviewView = z.infer<typeof ArtifactPreviewViewSchema>
