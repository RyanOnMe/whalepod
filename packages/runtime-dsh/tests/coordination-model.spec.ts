import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestCoordinationModel } from '../src/coordination-model.js'

const endpoint = 'https://api.commandcode.ai/provider/v1/chat/completions'
const model = 'deepseek/deepseek-v4.1-flash'
const signal = new AbortController().signal
const request = {
  endpoint,
  model,
  apiKey: 'fixture-key',
  maxOutputTokens: 4096,
  system: 'Return a JSON proposal.',
  user: 'Synthetic routing context.',
  signal,
}

function mockTransport(response: Response) {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', transport)
  return transport
}

const response = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 25 },
  })

afterEach(() => vi.unstubAllGlobals())

describe('Router broker Chat Completions transport', () => {
  it('requests low reasoning only on the verified Command Code model route without changing limits', async () => {
    const transport = mockTransport(response())
    await expect(requestCoordinationModel(request)).resolves.toEqual({
      text: '{}',
      inputTokens: 100,
      outputTokens: 25,
    })
    expect(transport).toHaveBeenCalledOnce()
    const [target, init] = transport.mock.calls[0]!
    expect(String(target)).toBe(endpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
    expect(JSON.parse(String(init?.body))).toEqual({
      model,
      stream: false,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    })
  })

  it.each([
    { endpoint, model: 'deepseek/deepseek-v4.1-flash-fast' },
    { endpoint: 'https://api.commandcode.ai:444/provider/v1/chat/completions', model },
    { endpoint: 'https://api.commandcode.ai/chat/completions', model },
    { endpoint: 'http://127.0.0.1:1234/provider/v1/chat/completions', model },
    { endpoint: 'https://another-provider.example/provider/v1/chat/completions', model },
  ])('keeps the generic request unchanged for $endpoint ($model)', async (override) => {
    const transport = mockTransport(response())
    await requestCoordinationModel({ ...request, ...override })
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body)) as object
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking')
  })

  it('rejects a truncated low-effort response and preserves aggregate provider usage', async () => {
    const transport = mockTransport(
      Response.json({
        choices: [{ finish_reason: 'length', message: { content: '{', reasoning: 'omitted' } }],
        usage: {
          prompt_tokens: 1450,
          completion_tokens: 4096,
          completion_tokens_details: { reasoning_tokens: 4090 },
        },
      }),
    )
    await expect(requestCoordinationModel(request)).rejects.toMatchObject({
      message: 'incomplete_model_result',
      usage: { inputTokens: 1450, outputTokens: 4096 },
    })
    expect(transport).toHaveBeenCalledOnce()
  })

  it('does not retry or silently fall back if the provider refuses the effort option', async () => {
    const transport = mockTransport(Response.json({ error: 'unsupported field' }, { status: 400 }))
    await expect(requestCoordinationModel(request)).rejects.toThrow('provider_request_failed')
    expect(transport).toHaveBeenCalledOnce()
  })
})
