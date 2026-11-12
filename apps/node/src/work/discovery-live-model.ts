/**
 * The only c3 provider transport. DSH still addresses its private loopback
 * broker; this port alone sees the actual provider credential and endpoint.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import {
  DISCOVERY_EXECUTOR_MAX_REQUEST_BYTES,
  type DiscoveryExecutionExecutor,
} from '@whalepod/protocol'
import { z } from 'zod'

export const DISCOVERY_LIVE_PROVIDER = 'command-code'
export const DISCOVERY_LIVE_MODEL = 'deepseek/deepseek-v4.1-flash'
export const DISCOVERY_LIVE_ENDPOINT = 'https://api.commandcode.ai/provider/v1/chat/completions'
export const DISCOVERY_LIVE_ACCOUNT = 'rd04c3-acceptance'
const MAX_OUTPUT_TOKENS = 4096
const MAX_RESPONSE_BYTES = 1024 * 1024
const HTTP_TIMEOUT_MS = 30_000
const SETTLEMENT_TIMEOUT_MS = 10_000
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const unavailable = () => new Error('discovery model call unavailable')

export interface DiscoveryLiveOptions {
  readonly executor: DiscoveryExecutionExecutor
  readonly apiKey: string
  readonly maxOutputTokens: number
}

export interface DiscoveryModelBegin {
  readonly attemptId: string
  readonly executor: DiscoveryExecutionExecutor
  readonly requestDigest: string
  readonly requestBytes: number
  readonly maxOutputTokens: number
}

export type DiscoveryModelOutcome =
  | {
      readonly kind: 'actual'
      readonly inputTokens: number
      readonly outputTokens: number
      readonly responseIdDigest?: string
    }
  | { readonly kind: 'confirmed_missing_usage' }
  | { readonly kind: 'unknown' }

export interface DiscoveryModelSettle {
  readonly attemptId: string
  readonly requestDigest: string
  readonly outcome: DiscoveryModelOutcome
}

export interface DiscoveryModelHubPort {
  readonly begin: (input: DiscoveryModelBegin, signal: AbortSignal) => Promise<boolean>
  readonly settle: (input: DiscoveryModelSettle, signal: AbortSignal) => Promise<boolean>
}

const ToolName = z.enum(['read_work_input', 'write', 'publish_artifact'])
const ToolCall = z.strictObject({
  id: z.string().min(1).max(256),
  type: z.literal('function'),
  function: z.strictObject({ name: ToolName, arguments: z.string() }),
})
const Message = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: z.string() }),
  z.strictObject({ role: z.literal('user'), content: z.string() }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(ToolCall).min(1).max(32).optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    content: z.string(),
    tool_call_id: z.string().min(1).max(256),
  }),
])
const Tool = z.strictObject({
  type: z.literal('function'),
  function: z.strictObject({
    name: ToolName,
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()),
  }),
})
const Input = z.strictObject({
  model: z.literal(DISCOVERY_LIVE_MODEL),
  stream: z.literal(true),
  stream_options: z.strictObject({ include_usage: z.literal(true) }),
  messages: z.array(Message).min(1).max(96),
  tools: z.array(Tool).min(1).max(3),
  max_tokens: z.int().positive().optional(),
  // DSH can supply these preferences. Only broker policy reaches the wire.
  thinking: z.strictObject({ type: z.enum(['enabled', 'disabled']) }).optional(),
  reasoning_effort: z.enum(['low', 'high', 'max']).optional(),
  temperature: z.number().optional(),
  stop: z.array(z.string()).max(4).optional(),
})
const requestFields = new Set(Object.keys(Input.shape))

export function isDiscoveryLiveExecutor(executor: DiscoveryExecutionExecutor): boolean {
  return (
    executor.provider === DISCOVERY_LIVE_PROVIDER &&
    executor.model === DISCOVERY_LIVE_MODEL &&
    executor.endpoint === DISCOVERY_LIVE_ENDPOINT &&
    executor.account === DISCOVERY_LIVE_ACCOUNT &&
    Number.isSafeInteger(executor.policyGeneration) &&
    executor.policyGeneration > 0
  )
}

export function sameDiscoveryLiveExecutor(
  expected: DiscoveryExecutionExecutor,
  offered: DiscoveryExecutionExecutor,
): boolean {
  return (
    isDiscoveryLiveExecutor(expected) &&
    isDiscoveryLiveExecutor(offered) &&
    expected.policyGeneration === offered.policyGeneration
  )
}

export function validateDiscoveryLiveOptions(options: DiscoveryLiveOptions): void {
  if (
    !isDiscoveryLiveExecutor(options.executor) ||
    !/^[\x21-\x7e]{8,4096}$/.test(options.apiKey) ||
    !Number.isSafeInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 1 ||
    options.maxOutputTokens > MAX_OUTPUT_TOKENS
  )
    throw unavailable()
}

interface ProviderResponse {
  readonly body: Buffer
  readonly complete?: boolean
}

export interface DiscoveryModelProviderTransport {
  (bytes: Buffer, key: string, signal: AbortSignal, onSent: () => void): Promise<ProviderResponse>
}

async function readProviderBody(response: IncomingMessage): Promise<ProviderResponse> {
  const type = response.headers['content-type']
  if (
    response.statusCode !== 200 ||
    typeof type !== 'string' ||
    type.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream' ||
    (response.headers['content-encoding'] !== undefined &&
      response.headers['content-encoding'] !== 'identity')
  )
    throw unavailable()
  const chunks: Buffer[] = []
  let size = 0
  let complete = false
  try {
    for await (const value of response) {
      const bytes = Buffer.from(value)
      size += bytes.byteLength
      if (size > MAX_RESPONSE_BYTES) throw unavailable()
      chunks.push(bytes)
    }
    complete = response.complete
  } catch (error) {
    if (size > MAX_RESPONSE_BYTES || size === 0) throw error
    // Socket truncation can follow a complete usage frame. Retain the
    // bounded prefix for accounting, never for delivery to Runtime.
  }
  if (size === 0) throw unavailable()
  return { body: Buffer.concat(chunks, size), complete }
}

const postCommandCodeOnce: DiscoveryModelProviderTransport = (bytes, key, signal, onSent) =>
  new Promise((resolve, reject) => {
    // Empty proxyEnv makes this independent of the ambient Node proxy settings.
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, proxyEnv: {} })
    let receivedHeaders = false
    const request = httpsRequest(
      DISCOVERY_LIVE_ENDPOINT,
      {
        method: 'POST',
        // Fresh native connection; no redirect, proxy, SDK or retry layer.
        agent,
        rejectUnauthorized: true,
        signal,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'content-length': bytes.byteLength,
          accept: 'text/event-stream',
          'x-cmd-zdr': '1',
        },
      },
      (response) => {
        receivedHeaders = true
        void readProviderBody(response)
          .then(resolve, reject)
          .finally(() => response.destroy())
      },
    )
    request.once('error', (error) => {
      // Once headers arrive, the response reader owns the error so any
      // validated usage already read can still be accounted for.
      if (!receivedHeaders) reject(error)
    })
    request.once('close', () => agent.destroy())
    request.once('finish', onSent)
    request.end(bytes)
  })

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
}

/** Inspect all data events before allowing any model content to leave the broker. */
function inspectProviderStream(body: Buffer): {
  outcome: DiscoveryModelOutcome
  complete: boolean
} {
  if (body.byteLength < 1 || body.byteLength > MAX_RESPONSE_BYTES) throw unavailable()
  // Split on ASCII SSE separators before decoding. A broken UTF-8 tail must
  // not discard a terminal receipt in an earlier complete frame.
  const blocks = body.toString('latin1').split(/\r?\n\r?\n/)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const unknown = { outcome: { kind: 'unknown' }, complete: false } as const
  let malformed = false
  let done = false
  let finished = false
  let acceptableFinish = false
  let responseId: string | undefined
  let usage: Extract<DiscoveryModelOutcome, { kind: 'actual' }> | undefined
  for (const [index, bytes] of blocks.entries()) {
    if (!bytes) continue
    let block: string
    try {
      block = decoder.decode(Buffer.from(bytes, 'latin1'))
    } catch {
      malformed = true
      continue
    }
    const lines = block.split(/\r?\n/)
    if (index === blocks.length - 1 || lines.some((line) => line && !/^(data:|:)/.test(line)))
      malformed = true
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data === '') continue
    if (data === '[DONE]') {
      if (done) malformed = true
      done = true
      continue
    }
    let event: Record<string, unknown> | undefined
    try {
      event = record(JSON.parse(data))
    } catch {
      malformed = true
      continue
    }
    if (!event) {
      malformed = true
      continue
    }
    const hasUsage = event.usage !== null && event.usage !== undefined
    if (event.id !== undefined) {
      if (
        typeof event.id !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(event.id) ||
        ((responseId !== undefined || usage !== undefined) && responseId !== event.id)
      )
        return unknown
      if (!malformed && !done) responseId = event.id
    }
    // Even after malformed framing, inspect later parseable events for a
    // conflicting receipt or identity rather than trusting whichever came first.
    if (hasUsage && usage !== undefined) return unknown
    if (
      done ||
      event.error !== undefined ||
      usage ||
      !Array.isArray(event.choices) ||
      event.choices.length > 1
    ) {
      malformed = true
      continue
    }
    if (event.choices.length === 1) {
      const choice = record(event.choices[0])
      if (!choice || finished) {
        malformed = true
        continue
      }
      const reason = choice.finish_reason
      if (typeof reason === 'string') {
        finished = true
        acceptableFinish = reason === 'stop' || reason === 'tool_calls'
      } else if (reason !== null && reason !== undefined) malformed = true
    }
    if (hasUsage) {
      const stats = record(event.usage)
      const inputTokens = stats?.prompt_tokens
      const outputTokens = stats?.completion_tokens
      if (malformed || !finished || !tokenCount(inputTokens) || !tokenCount(outputTokens))
        return unknown
      usage = {
        kind: 'actual',
        inputTokens,
        outputTokens,
        ...(responseId === undefined ? {} : { responseIdDigest: hash(responseId) }),
      }
    }
  }
  const outcome = usage ?? {
    kind: !malformed && done && finished ? 'confirmed_missing_usage' : 'unknown',
  }
  return { outcome, complete: !malformed && done && acceptableFinish && usage !== undefined }
}

/** Use a substituted transport only from a unit test, never from packaged CLI options. */
export function createDiscoveryLiveModelPort(
  options: DiscoveryLiveOptions,
  hub: DiscoveryModelHubPort,
  observe?: (
    event:
      | { readonly stage: 'sent'; readonly attemptId: string }
      | {
          readonly stage: 'refused'
          readonly reason: 'request_schema'
          readonly fields: readonly string[]
        }
      | {
          readonly stage: 'refused'
          readonly reason: 'reservation_denied' | 'reservation_unavailable'
          readonly attemptId: string
        }
      | (Extract<DiscoveryModelOutcome, { kind: 'actual' }> & {
          readonly stage: 'provider_usage'
          readonly attemptId: string
        }),
  ) => void,
  transport: DiscoveryModelProviderTransport = postCommandCodeOnce,
) {
  validateDiscoveryLiveOptions(options)
  const executor = Object.freeze({ ...options.executor })
  const key = options.apiKey
  const limit = options.maxOutputTokens
  let inFlight = false
  let blocked = false
  let settledCalls = 0
  const attemptedDigests = new Set<string>()
  return {
    isBlocked: () => blocked,
    mayUpload: () => !blocked && !inFlight && settledCalls > 0,
    async request(body: Buffer, clientSignal: AbortSignal): Promise<Buffer> {
      if (blocked || inFlight || clientSignal.aborted) throw unavailable()
      inFlight = true
      try {
        if (body.byteLength < 1 || body.byteLength > DISCOVERY_EXECUTOR_MAX_REQUEST_BYTES)
          throw unavailable()
        const parsed = Input.safeParse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
        )
        if (!parsed.success) {
          const fields = new Set(
            parsed.error.issues.map(({ path: [field] }) =>
              typeof field === 'string' && requestFields.has(field) ? field : 'other',
            ),
          )
          observe?.({ stage: 'refused', reason: 'request_schema', fields: [...fields].sort() })
          throw unavailable()
        }
        const request = parsed.data
        if (new Set(request.tools.map((tool) => tool.function.name)).size !== request.tools.length)
          throw unavailable()
        const maxOutputTokens = Math.min(limit, request.max_tokens ?? limit)
        const bytes = Buffer.from(
          JSON.stringify({
            model: executor.model,
            messages: request.messages,
            tools: request.tools,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: maxOutputTokens,
            reasoning_effort: 'low',
          }),
        )
        if (bytes.byteLength > DISCOVERY_EXECUTOR_MAX_REQUEST_BYTES) throw unavailable()
        const requestDigest = hash(bytes)
        // The next legitimate agent turn includes a new tool result. An exact
        // replay (including after an interrupted response) is never sent twice.
        if (attemptedDigests.has(requestDigest)) throw unavailable()
        attemptedDigests.add(requestDigest)
        const facts = {
          attemptId: randomUUID(),
          executor,
          requestDigest,
          requestBytes: bytes.byteLength,
          maxOutputTokens,
        }
        const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(HTTP_TIMEOUT_MS)])
        // Once begin succeeds, only this invocation may send this attempt. A
        // lost acknowledgement can never make a cached grant reusable.
        const held = await hub.begin(facts, signal).catch(() => undefined)
        if (!held) {
          observe?.({
            stage: 'refused',
            reason: held === false ? 'reservation_denied' : 'reservation_unavailable',
            attemptId: facts.attemptId,
          })
          throw unavailable()
        }
        let outcome: DiscoveryModelOutcome = { kind: 'unknown' }
        let complete = false
        let response: Buffer | undefined
        try {
          signal.throwIfAborted()
          const provider = await transport(bytes, key, signal, () =>
            observe?.({ stage: 'sent', attemptId: facts.attemptId }),
          )
          response = provider.body
          ;({ outcome, complete } = inspectProviderStream(response))
          if (provider.complete === false) {
            complete = false
            if (outcome.kind !== 'actual') outcome = { kind: 'unknown' }
          }
          if (outcome.kind === 'actual') {
            observe?.({ ...outcome, stage: 'provider_usage', attemptId: facts.attemptId })
            if (outcome.outputTokens > maxOutputTokens) complete = false
          }
        } finally {
          // Keep settlement independent of the client abort. If this receipt
          // cannot be delivered, the durable reservation remains charged.
          const allow = await hub
            .settle(
              {
                attemptId: facts.attemptId,
                requestDigest: facts.requestDigest,
                outcome,
              },
              AbortSignal.timeout(SETTLEMENT_TIMEOUT_MS),
            )
            .catch(() => false)
          if (!allow) complete = false
        }
        if (!complete || response === undefined || signal.aborted) throw unavailable()
        settledCalls++
        return response
      } catch {
        blocked = true
        throw unavailable()
      } finally {
        inFlight = false
      }
    },
  }
}
