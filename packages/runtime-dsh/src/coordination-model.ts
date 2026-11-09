/** Trusted broker transport. Model-controlled text never selects a URL or credential. */
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

const COMMAND_CODE_CHAT_ENDPOINT = 'https://api.commandcode.ai/provider/v1/chat/completions'
const COMMAND_CODE_DEEPSEEK_FLASH = 'deepseek/deepseek-v4.1-flash'

export function validateCoordinationEndpoint(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('invalid_provider_endpoint')
  }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== ''
  )
    throw new Error('invalid_provider_endpoint')
  return url
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export interface CoordinationModelResponse {
  text: string
  inputTokens: number
  outputTokens: number
}

export class CoordinationModelFailure extends Error {
  constructor(
    code: string,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(code)
  }
}

export function parseCoordinationModelResponse(value: unknown): CoordinationModelResponse {
  const root = record(value)
  const choices = Array.isArray(root['choices']) ? root['choices'] : []
  const choice = record(choices[0])
  const message = record(choice['message'])
  const rawUsage = record(root['usage'])
  const rawInput = rawUsage['prompt_tokens']
  const rawOutput = rawUsage['completion_tokens']
  const knownUsage =
    typeof rawInput === 'number' &&
    Number.isSafeInteger(rawInput) &&
    rawInput >= 0 &&
    typeof rawOutput === 'number' &&
    Number.isSafeInteger(rawOutput) &&
    rawOutput >= 0
      ? { inputTokens: rawInput, outputTokens: rawOutput }
      : undefined
  if (
    choice['finish_reason'] === 'tool_calls' ||
    (Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0) ||
    message['function_call'] !== undefined
  )
    throw new CoordinationModelFailure('unsupported_tool_call', knownUsage)
  const usage = record(root['usage'])
  const inputTokens = usage['prompt_tokens']
  const outputTokens = usage['completion_tokens']
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  )
    throw new Error('usage_missing')
  if (choice['finish_reason'] !== 'stop' || typeof message['content'] !== 'string') {
    throw new CoordinationModelFailure('incomplete_model_result', knownUsage)
  }
  return { text: message['content'], inputTokens, outputTokens }
}

export async function requestCoordinationModel(input: {
  endpoint: string
  apiKey: string
  model: string
  maxOutputTokens: number
  system: string
  user: string
  signal: AbortSignal
}): Promise<CoordinationModelResponse> {
  const endpoint = validateCoordinationEndpoint(input.endpoint)
  if (!/^[\x21-\x7e]+$/.test(input.apiKey)) throw new Error('credential_unavailable')
  // Command Code's exact V4.1 Flash route can spend the Router's output budget on
  // reasoning. Request its lowest effort without changing the total token limit.
  // Never send vendor-specific options to an arbitrary compatible endpoint.
  const lowEffort =
    endpoint.href === COMMAND_CODE_CHAT_ENDPOINT && input.model === COMMAND_CODE_DEEPSEEK_FLASH
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: input.signal,
    headers: {
      ...attributionHeaders(),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      stream: false,
      max_tokens: input.maxOutputTokens,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      response_format: { type: 'json_object' },
      ...(lowEffort ? { reasoning_effort: 'low' } : {}),
    }),
  })
  if (!response.ok) throw new Error('provider_request_failed')
  if (response.body === null) throw new Error('invalid_model_result')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > 256 * 1024) {
        await reader.cancel()
        throw new Error('output_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return parseCoordinationModelResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}
