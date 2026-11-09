/**
 * Trusted source broker side. The isolated worker neither imports this module
 * nor chooses an endpoint/account. The authorization port must record a fresh
 * admission at the Hub's final egress boundary; a cached receipt is invalid.
 */
import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import {
  MANAGED_DRAFT_MAX_CONTENT_BYTES,
  MANAGED_DRAFT_SOURCE_INSTRUCTION,
} from '@whalepod/protocol'

export interface ManagedDraftBrokerBinding {
  readonly runId: string
  readonly provider: string
  readonly model: string
  readonly endpoint: string
  readonly accountId: string
  readonly policyVersion: string
  readonly manifestDigest: string
  readonly sourceSha256: string
  readonly sourceByteSize: number
}

export interface ManagedDraftEgressAuthorization extends ManagedDraftBrokerBinding {
  readonly attemptId: string
  readonly payloadSha256: string
  readonly payloadByteSize: number
}

type AuthorizeManagedDraftEgress = (
  request: ManagedDraftEgressAuthorization,
  signal: AbortSignal,
) => Promise<(ManagedDraftEgressAuthorization & { readonly decisionId: string }) | undefined>

interface ManagedDraftModelResult {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

const MAX_BODY_BYTES = 128 * 1024
const MAX_OUTPUT_TOKENS = 1024
const TIMEOUT_MS = 30_000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/
const OPAQUE = /^[A-Za-z0-9_./:-]{1,128}$/
const denied = () => new Error('managed_draft_egress_denied')
const providerFailed = () => new Error('managed_draft_provider_failed')

function parseEndpoint(value: string): URL {
  try {
    const endpoint = new URL(value)
    const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]'
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
    )
      throw denied()
    return endpoint
  } catch {
    throw denied()
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function readResponse(
  response: IncomingMessage,
  maxTokens: number,
): Promise<ManagedDraftModelResult> {
  if (response.statusCode !== 200) {
    response.destroy()
    throw providerFailed()
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const raw of response) {
    const chunk = Buffer.from(raw)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw providerFailed()
    chunks.push(chunk)
  }
  const payload = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
  )
  const choices = payload?.['choices']
  if (!Array.isArray(choices) || choices.length !== 1) throw providerFailed()
  const choice = object(choices[0])
  const message = object(choice?.['message'])
  const usage = object(payload?.['usage'])
  const text = message?.['content']
  const inputTokens = usage?.['prompt_tokens']
  const outputTokens = usage?.['completion_tokens']
  if (
    choice?.['finish_reason'] !== 'stop' ||
    message?.['tool_calls'] != null ||
    message?.['function_call'] != null ||
    typeof text !== 'string' ||
    Buffer.byteLength(text) === 0 ||
    Buffer.byteLength(text) > MANAGED_DRAFT_MAX_CONTENT_BYTES ||
    !count(inputTokens) ||
    !count(outputTokens) ||
    outputTokens > maxTokens
  )
    throw providerFailed()
  return { text, inputTokens, outputTokens }
}

function postOnce(
  endpoint: URL,
  apiKey: string,
  bytes: Buffer,
  maxTokens: number,
  signal: AbortSignal,
): Promise<ManagedDraftModelResult> {
  const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    // Native single request, private connection, no redirect or retry helper.
    const req = send(
      endpoint,
      {
        method: 'POST',
        agent: false,
        signal,
        ...(endpoint.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          'content-length': String(bytes.byteLength),
          authorization: `Bearer ${apiKey}`,
        },
      },
      (response) => void readResponse(response, maxTokens).then(resolve, reject),
    )
    req.once('error', reject)
    req.end(bytes)
  })
}

export function createManagedDraftModelBroker(
  binding: ManagedDraftBrokerBinding,
  apiKey: string,
  authorize: AuthorizeManagedDraftEgress,
) {
  const endpoint = parseEndpoint(binding.endpoint)
  if (
    !UUID.test(binding.runId) ||
    !SHA.test(binding.manifestDigest) ||
    !SHA.test(binding.sourceSha256) ||
    !count(binding.sourceByteSize) ||
    binding.sourceByteSize === 0 ||
    binding.sourceByteSize > MANAGED_DRAFT_MAX_CONTENT_BYTES ||
    ![binding.provider, binding.model, binding.accountId, binding.policyVersion].every(
      (id) => typeof id === 'string' && OPAQUE.test(id),
    ) ||
    typeof apiKey !== 'string' ||
    !/^[\x21-\x7e]{1,512}$/.test(apiKey)
  )
    throw denied()
  const route = Object.freeze({ ...binding, endpoint: endpoint.href })
  const sessionId = `whalepod-managed-draft-${route.runId}`
  // The fixed v1 worker generates one draft from one model request.
  let attempted = false
  return {
    async request(input: unknown, cancellation?: AbortSignal): Promise<ManagedDraftModelResult> {
      const raw = object(input)
      const supported = [
        'attemptId',
        'sessionId',
        'model',
        'maxTokens',
        'messages',
        'tools',
        'system',
      ]
      if (raw === undefined || Object.keys(raw).some((key) => !supported.includes(key)))
        throw denied()
      const { attemptId, maxTokens, messages, tools, system } = raw
      const message =
        Array.isArray(messages) && messages.length === 1 ? object(messages[0]) : undefined
      const blocks = message?.['content']
      const content = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
      const text = content?.['text']
      if (
        raw['sessionId'] !== sessionId ||
        raw['model'] !== route.model ||
        typeof attemptId !== 'string' ||
        !UUID.test(attemptId) ||
        attempted ||
        !count(maxTokens) ||
        maxTokens === 0 ||
        maxTokens > MAX_OUTPUT_TOKENS ||
        !Array.isArray(tools) ||
        tools.length !== 0 ||
        message?.['role'] !== 'user' ||
        content?.['type'] !== 'text' ||
        typeof text !== 'string' ||
        Buffer.byteLength(text) !== route.sourceByteSize ||
        createHash('sha256').update(text).digest('hex') !== route.sourceSha256 ||
        system !== MANAGED_DRAFT_SOURCE_INSTRUCTION
      )
        throw denied()
      const bytes = Buffer.from(
        JSON.stringify({
          model: route.model,
          stream: false,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: MANAGED_DRAFT_SOURCE_INSTRUCTION },
            { role: 'user', content: text },
          ],
        }),
      )
      if (bytes.byteLength > MAX_BODY_BYTES) throw denied()
      attempted = true
      const request = Object.freeze({
        ...route,
        attemptId,
        payloadSha256: createHash('sha256').update(bytes).digest('hex'),
        payloadByteSize: bytes.byteLength,
      })
      const deadline = AbortSignal.timeout(TIMEOUT_MS)
      const signal =
        cancellation === undefined ? deadline : AbortSignal.any([deadline, cancellation])
      if (signal.aborted) throw denied()
      let rejectAbort!: () => void
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(denied())
        signal.addEventListener('abort', rejectAbort, { once: true })
      })
      let decision
      try {
        decision = await Promise.race([authorize(request, signal), cancelled])
      } catch {
        throw denied()
      } finally {
        signal.removeEventListener('abort', rejectAbort)
      }
      if (
        signal.aborted ||
        decision === undefined ||
        typeof decision.decisionId !== 'string' ||
        !OPAQUE.test(decision.decisionId) ||
        !Object.entries(request).every(([key, value]) => Reflect.get(decision, key) === value)
      )
        throw denied()
      try {
        // No async gap between validating this decision and initiating this one send.
        return await postOnce(endpoint, apiKey, bytes, maxTokens, signal)
      } catch {
        throw providerFailed()
      }
    },
  }
}
