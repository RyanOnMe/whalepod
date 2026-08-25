/**
 * Browser WebSocket 下行帧（03-领域模型与运行协议.md §5）。
 *
 * 服务端只下行事件；未知帧按 §11 fail-closed——解析层拒绝后由 Web
 * 记录并触发 resync，不执行状态变更（02 Task 3 Step 5）。
 */
import { z } from 'zod'
import { PROTOCOL_VERSION, parseWireFrame } from './envelope.js'

const clientEvent = <TType extends string>(type: TType) =>
  z.strictObject({
    type: z.literal(type),
    // §5 记为 unknown：各 Team Event 的投影 payload，wire 上必须是 JSON 值；
    // 各事件的投影形状随对应 Hub 模块落地后再逐项收紧。
    payload: z.json(),
  })

/** persistent 帧里的 Team Event 类型（§5 的 8 个字面量）。 */
export const ClientPersistentEventSchema = z.discriminatedUnion('type', [
  clientEvent('project.changed'),
  clientEvent('task.changed'),
  clientEvent('comment.created'),
  clientEvent('run.changed'),
  clientEvent('run.event'),
  clientEvent('approval.changed'),
  clientEvent('artifact.changed'),
  clientEvent('device.changed'),
])
export type ClientPersistentEvent = z.infer<typeof ClientPersistentEventSchema>

export const ClientFrameSchema = z.discriminatedUnion('kind', [
  // 持久 Team Event，占 cursor，24 小时保留窗口内可补发。
  z.strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    kind: z.literal('persistent'),
    cursor: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    event: ClientPersistentEventSchema,
  }),
  // 不持久的 owner-only assistant.delta，不占 Team Event cursor。
  z.strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    kind: z.literal('live'),
    runId: z.uuid(),
    audience: z.literal('owner'),
    deltaSeq: z.number().int().positive(),
    delta: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    kind: z.literal('control'),
    type: z.literal('resync.required'),
    latestCursor: z.string().min(1),
  }),
])
export type ClientFrame = z.infer<typeof ClientFrameSchema>

export const CLIENT_FRAME_KINDS = ClientFrameSchema.options.map((option) => option.shape.kind.value)

export const CLIENT_PERSISTENT_EVENT_TYPES = ClientPersistentEventSchema.options.map(
  (option) => option.shape.type.value,
)

/** 解析 Browser WS 下行帧；未知 kind/event type 抛 ProtocolError（fail-closed）。 */
export function parseClientFrame(input: unknown): ClientFrame {
  return parseWireFrame({
    schema: ClientFrameSchema,
    knownTypes: CLIENT_FRAME_KINDS,
    input,
    discriminator: 'kind',
  })
}
