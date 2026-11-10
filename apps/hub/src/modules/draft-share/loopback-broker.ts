import { request, type IncomingMessage } from 'node:http'
import { MANAGED_DRAFT_MAX_CONTENT_BYTES, MANAGED_DRAFT_MODEL_MAX_TOKENS } from '@whalepod/protocol'

const maxBodyBytes = 128 * 1024
const timeoutMs = 30_000
const invalidEndpoint = () => new Error('managed_draft_loopback_endpoint_invalid')
const failed = () => new Error('managed_draft_loopback_failed')

/** Only explicit, non-default ports on literal loopback; the host never uses a proxy or DNS. */
export function parseManagedDraftLoopbackEndpoint(value: string): URL {
  // Check the original spelling so URL normalization cannot turn an alias such as 127.1,
  // a decimal IPv4 integer or empty user information into an approved endpoint.
  const literal =
    /^http:\/\/(?:127(?:\.(?:0|[1-9][0-9]{0,2})){3}|\[::1\]):[1-9][0-9]{0,4}(?:\/[\x21-\x7e]*)?(?![\s\S])/u
  if (value.length > 2048 || /[\\?#]/u.test(value) || !literal.test(value)) throw invalidEndpoint()
  try {
    const endpoint = new URL(value)
    // WHATWG URL drops :80, so an endpoint on the implicit HTTP port is also refused.
    if (!endpoint.port) throw invalidEndpoint()
    return endpoint
  } catch {
    throw invalidEndpoint()
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

interface ModelResult {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

async function readResult(response: IncomingMessage): Promise<ModelResult> {
  if (response.statusCode !== 200) throw failed()
  let size = 0
  const chunks: Buffer[] = []
  for await (const raw of response) {
    const chunk = Buffer.from(raw)
    size += chunk.byteLength
    if (size > maxBodyBytes) throw failed()
    chunks.push(chunk)
  }
  const payload = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))),
  )
  const choices = payload?.['choices']
  if (!Array.isArray(choices) || choices.length !== 1) throw failed()
  const choice = object(choices[0])
  const message = object(choice?.['message'])
  const usage = object(payload?.['usage'])
  const text = message?.['content']
  const role = message?.['role']
  const inputTokens = usage?.['prompt_tokens']
  const outputTokens = usage?.['completion_tokens']
  const totalTokens = usage?.['total_tokens']
  if (
    choice?.['finish_reason'] !== 'stop' ||
    (role !== undefined && role !== 'assistant') ||
    message?.['tool_calls'] != null ||
    message?.['function_call'] != null ||
    typeof text !== 'string' ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) === 0 ||
    Buffer.byteLength(text) > MANAGED_DRAFT_MAX_CONTENT_BYTES ||
    !nonnegativeInteger(inputTokens) ||
    inputTokens > maxBodyBytes ||
    !nonnegativeInteger(outputTokens) ||
    outputTokens > MANAGED_DRAFT_MODEL_MAX_TOKENS ||
    (totalTokens !== undefined && totalTokens !== inputTokens + outputTokens)
  ) {
    throw failed()
  }
  return { text, inputTokens, outputTokens }
}

/** The Hub caller must have already committed the one-use decision for these exact bytes. */
export async function forwardManagedDraftLoopback(
  endpoint: URL,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ModelResult> {
  const target = parseManagedDraftLoopbackEndpoint(endpoint.href)
  if (bytes.byteLength === 0 || bytes.byteLength > maxBodyBytes || signal?.aborted) throw failed()
  // Copy before starting the native asynchronous write; later mutations must not change the body.
  const body = Buffer.from(bytes)
  const deadline = AbortSignal.timeout(timeoutMs)
  const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  try {
    return await new Promise<ModelResult>((resolve, reject) => {
      const outgoing = request(
        target,
        {
          method: 'POST',
          agent: false,
          signal: cancellation,
          headers: {
            'content-type': 'application/json',
            'content-length': String(body.byteLength),
          },
        },
        (response) => {
          void readResult(response).then(resolve, () => {
            response.destroy()
            reject(failed())
          })
        },
      )
      outgoing.once('error', reject)
      outgoing.end(body)
    })
  } catch {
    // Native request errors and downstream parse diagnostics can contain private data.
    throw failed()
  }
}
