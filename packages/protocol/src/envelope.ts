/**
 * Wire envelope 与 fail-closed 解析（03-领域模型与运行协议.md §6.1、§11）。
 *
 * 未知字段策略：所有 envelope 与 payload 都是 strictObject——同一版本新增字段
 * 必须可选且有默认行为（§11），wire 上不允许无约定的额外键。
 */
import { z } from 'zod'
import { ProtocolError } from './errors.js'

/** wire 协议的 protocolVersion 固定为 1（02-第一阶段实施计划.md Global Constraints）。 */
export const PROTOCOL_VERSION = 1 as const

export const EnvelopeBaseSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.uuid(),
  sentAt: z.iso.datetime({ offset: true }),
})

/** 构造一个带固定 type 字面量与严格 payload 的 envelope schema。 */
export function envelope<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.strictObject({
    ...EnvelopeBaseSchema.shape,
    type: z.literal(type),
    payload,
  })
}

export interface WireParseOptions<Schema extends z.ZodType> {
  schema: Schema
  /** 该方向已登记的 type/kind 字面量（来自 catalog 登记处）。 */
  knownTypes: readonly string[]
  input: unknown
  /** 判别字段名：Node/Runtime wire 用 'type'，Browser WS 用 'kind'。 */
  discriminator?: string
}

/**
 * fail-closed 解析（§11）：拒绝而不是忽略。
 *
 * - protocolVersion 不为 1、或判别值未登记 → PROTOCOL_MISMATCH（对端协议不符，
 *   Node 对未知 command 不执行，Hub/Web 对未知 event 不改变状态）。
 * - 已登记 type 但载荷畸形 → VALIDATION_FAILED。
 */
export function parseWireFrame<Schema extends z.ZodType>(
  options: WireParseOptions<Schema>,
): z.output<Schema> {
  const { schema, knownTypes, input, discriminator = 'type' } = options
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProtocolError('VALIDATION_FAILED', 'wire frame must be a JSON object')
  }
  const record = input as Record<string, unknown>
  if (record.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      'PROTOCOL_MISMATCH',
      `unsupported protocolVersion: ${JSON.stringify(record.protocolVersion) ?? 'missing'}`,
    )
  }
  const type = record[discriminator]
  if (typeof type !== 'string' || !knownTypes.includes(type)) {
    throw new ProtocolError('PROTOCOL_MISMATCH', `unknown frame ${discriminator}: ${String(type)}`)
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ProtocolError(
      'VALIDATION_FAILED',
      `invalid ${type} frame: ${issue?.message ?? 'schema mismatch'}`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}
