/**
 * ADR-0028（RD-02a-2b）：工作输入从 Run 清单到 Node 受控下载、Runtime 读取回执的
 * 线上形状。
 *
 * `run.start` 只带 #492 冻结的清单（身份/版本/摘要/标题，不含正文）；正文由 Node
 * 经 `GET /node/runs/:runId/work-input/bundle` 按 Run 归属下载。回执是独立通道：
 * Run 终态后仍接受（窗口内 consumed，窗口后只更新对账记录），不复活 Run。
 */
import { z } from 'zod'
import { DiscoveryExecutionExecutorSchema } from './discovery.js'
import {
  FrozenWorkSourceTypeSchema,
  WORK_INPUT_MANIFEST_MAX_ENTRIES,
  WorkInputManifestEntrySchema,
  WorkInputManifestSchema,
  type WorkInputManifestEntry,
} from './work-input.js'

export const WORK_INPUT_CAPABILITY = 'work-input.v1' as const
export const DISCOVERY_EXECUTION_REPLAY_CAPABILITY = 'discovery-execution-replay.v1' as const
export const DISCOVERY_EXECUTION_LIVE_CAPABILITY = 'discovery-execution-live.v1' as const
export const WorkInputCapabilitySchema = z.enum([WORK_INPUT_CAPABILITY])

export const WORK_INPUT_MAX_ENTRY_BYTES = 65_536
export const RUN_WORK_INPUT_RECEIPT_MAX_READ_EVENTS = 32

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const IsoDateTimeSchema = z.iso.datetime({ offset: true })

/** Hub → Node：Run 创建事务里冻结的工作输入清单头 + 清单（正文走受控下载）。 */
export const RunStartWorkInputSchema = z
  .strictObject({
    manifestDigest: Sha256DigestSchema,
    manifest: WorkInputManifestSchema,
    discoveryExecutionId: z.uuid().optional(),
    discoveryReplayEndpoint: z.url().optional(),
    discoveryLiveExecutor: DiscoveryExecutionExecutorSchema.optional(),
  })
  .refine((value) => {
    const discovery = value.discoveryExecutionId !== undefined
    const modes =
      Number(value.discoveryReplayEndpoint !== undefined) +
      Number(value.discoveryLiveExecutor !== undefined)
    return (
      modes === Number(discovery) &&
      value.manifest.entries.every(
        (entry) => (entry.sourceType === 'discovery_source') === discovery,
      )
    )
  }, 'a dedicated discovery manifest requires exactly one discovery model binding')
export type RunStartWorkInput = z.infer<typeof RunStartWorkInputSchema>

/** Node → Hub：受控下载应答；正文只在本次 HTTP 响应出现。 */
export const WorkInputBundleEntrySchema = z.strictObject({
  inboxItemId: z.uuid(),
  sourceType: FrozenWorkSourceTypeSchema,
  sourceId: z.uuid(),
  sourceVersion: z.string().min(1).max(200),
  sourceDigest: Sha256DigestSchema,
  bodyDigest: Sha256DigestSchema,
  byteSize: z.number().int().min(0).max(WORK_INPUT_MAX_ENTRY_BYTES),
  authorizationGeneration: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  bodyBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
})
export type WorkInputBundleEntry = z.infer<typeof WorkInputBundleEntrySchema>

export const WorkInputBundleSchema = z.strictObject({
  version: z.literal('rd02a2.v1'),
  workKey: z.uuid(),
  manifestDigest: Sha256DigestSchema,
  entries: z.array(WorkInputBundleEntrySchema).min(1).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
})
export type WorkInputBundle = z.infer<typeof WorkInputBundleSchema>

/** Runtime → Node：首条交付与每次工具读取的回执（本地 wire）。 */
export const RuntimeWorkInputReceiptPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('delivered'),
    runId: z.uuid(),
    workKey: z.uuid(),
    manifestDigest: Sha256DigestSchema,
    entriesDelivered: z.array(z.uuid()).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
    at: IsoDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal('read'),
    runId: z.uuid(),
    workKey: z.uuid(),
    manifestDigest: Sha256DigestSchema,
    inboxItemId: z.uuid(),
    digestVerified: z.boolean(),
    byteSize: z.number().int().min(0).max(WORK_INPUT_MAX_ENTRY_BYTES),
    at: IsoDateTimeSchema,
  }),
])
export type RuntimeWorkInputReceiptPayload = z.infer<typeof RuntimeWorkInputReceiptPayloadSchema>

export const RunWorkInputReadEventSchema = z.strictObject({
  inboxItemId: z.uuid(),
  digestVerified: z.boolean(),
  byteSize: z.number().int().min(0).max(WORK_INPUT_MAX_ENTRY_BYTES),
  at: IsoDateTimeSchema,
})
export type RunWorkInputReadEvent = z.infer<typeof RunWorkInputReadEventSchema>

/**
 * Node → Hub：专用上行回执。`entriesDelivered/entriesRead` 是累计集合（Node 重启后
 * 仍从持久状态重建）；`readEvents` 只带本批新读取，避免重复消费行。
 */
export const RunWorkInputReceiptSchema = z.strictObject({
  runId: z.uuid(),
  workKey: z.uuid(),
  manifestDigest: Sha256DigestSchema,
  receiptSeq: z.number().int().positive(),
  entriesDelivered: z.array(z.uuid()).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
  entriesRead: z.array(z.uuid()).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
  readEvents: z.array(RunWorkInputReadEventSchema).max(RUN_WORK_INPUT_RECEIPT_MAX_READ_EVENTS),
  missing: z.array(z.uuid()).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
  digestVerified: z.boolean(),
  at: IsoDateTimeSchema,
})
export type RunWorkInputReceipt = z.infer<typeof RunWorkInputReceiptSchema>

/** Runtime initialize 的清单 + 本地副本目录（成对字段）。 */
export const RuntimeWorkInputsSchema = z.strictObject({
  discoveryExecutionId: z.uuid().optional(),
  workKey: z.uuid(),
  manifestDigest: Sha256DigestSchema,
  entries: z.array(WorkInputManifestEntrySchema).min(1).max(WORK_INPUT_MANIFEST_MAX_ENTRIES),
  entriesDir: z.string().min(1),
})
export type RuntimeWorkInputs = z.infer<typeof RuntimeWorkInputsSchema>
export type WorkInputManifestEntryWire = WorkInputManifestEntry
