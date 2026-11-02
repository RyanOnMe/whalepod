/**
 * ADR-0028（RD-02a-2a）：Run 的不可变工作输入清单。
 *
 * 清单只含条目身份、版本、摘要与只读元数据，不含正文；正文留在收件箱私有快照，
 * 由 Node 受控下载（RD-02a-2b）。创建后清单不可改，新输入只能进入下一 Run。
 */
import { z } from 'zod'
import { WorkSourceTypeSchema } from './work.js'

export const WORK_INPUT_MANIFEST_VERSION = 'rd02a2.v1'
export const WORK_INPUT_MANIFEST_MAX_ENTRIES = 32

export const WorkInputManifestEntrySchema = z.strictObject({
  inboxItemId: z.uuid(),
  sourceType: WorkSourceTypeSchema,
  sourceId: z.uuid(),
  sourceVersion: z.string().min(1).max(200),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative().max(65_536),
  authorizationGeneration: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
})
export type WorkInputManifestEntry = z.infer<typeof WorkInputManifestEntrySchema>

export const WorkInputManifestSchema = z.strictObject({
  version: z.literal(WORK_INPUT_MANIFEST_VERSION),
  workKey: z.uuid(),
  entries: z.array(WorkInputManifestEntrySchema).min(1).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
})
export type WorkInputManifest = z.infer<typeof WorkInputManifestSchema>

export const WORK_INPUT_MANIFEST_DIGEST_PATTERN = /^[a-f0-9]{64}$/
