import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createDiscoveryLiveModelPort,
  DISCOVERY_LIVE_ACCOUNT,
  DISCOVERY_LIVE_ENDPOINT,
  DISCOVERY_LIVE_MODEL,
  DISCOVERY_LIVE_PROVIDER,
  type DiscoveryLiveOptions,
  type DiscoveryModelHubPort,
  type DiscoveryModelProviderTransport,
} from '../src/work/discovery-live-model.js'

const options: DiscoveryLiveOptions = {
  executor: {
    provider: DISCOVERY_LIVE_PROVIDER,
    model: DISCOVERY_LIVE_MODEL,
    endpoint: DISCOVERY_LIVE_ENDPOINT,
    account: DISCOVERY_LIVE_ACCOUNT,
    credentialDigest: createHash('sha256').update('synthetic-local-test-only').digest('hex'),
    policyGeneration: 1,
  },
  apiKey: 'synthetic-local-test-only',
  maxOutputTokens: 400,
}

const raw = {
  model: DISCOVERY_LIVE_MODEL,
  messages: [{ role: 'user', content: 'fake approved material' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 2000,
  reasoning_effort: 'max',
  tools: [
    { type: 'function', function: { name: 'read_work_input', parameters: { type: 'object' } } },
  ],
}
const request = Buffer.from(JSON.stringify(raw))
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const finish = event({
  id: 'synthetic-request',
  choices: [{ index: 0, finish_reason: 'tool_calls' }],
})
const done = 'data: [DONE]\n\n'
const usage = (inputTokens: number, outputTokens: number) =>
  event({
    id: 'synthetic-request',
    choices: [],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  })
const withUsage = (inputTokens = 327, outputTokens = 123) =>
  Buffer.from(finish + usage(inputTokens, outputTokens) + done)
const signal = () => new AbortController().signal
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

describe('RD-04c3 provider egress port', () => {
  it('rejects a replaced credential even when the recipient account label is unchanged', () => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>()
    const settle = vi.fn<DiscoveryModelHubPort['settle']>()
    const transport = vi.fn<DiscoveryModelProviderTransport>()
    expect(() =>
      createDiscoveryLiveModelPort(
        { ...options, apiKey: 'different-synthetic-local-key' },
        { begin, settle },
        undefined,
        transport,
      ),
    ).toThrow('discovery model call unavailable')
    expect(begin).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })

  it('binds each distinct attempt to the exact capped bytes sent and waits for settlement', async () => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>().mockResolvedValue(true)
    const settle = vi.fn<DiscoveryModelHubPort['settle']>()
    let finishSettlement: ((allow: boolean) => void) | undefined
    settle.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishSettlement = resolve
        }),
    )
    settle.mockResolvedValue(true)
    const transport = vi
      .fn<DiscoveryModelProviderTransport>()
      .mockImplementation(async (_bytes, _key, _signal, onSent) => {
        expect(begin).toHaveBeenCalledTimes(transport.mock.calls.length)
        onSent()
        return { body: withUsage() }
      })
    const observe = vi.fn()
    const port = createDiscoveryLiveModelPort(options, { begin, settle }, observe, transport)
    const result = port.request(request, signal())
    let returned = false
    void result.then(() => {
      returned = true
    })
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
    expect(returned).toBe(false)
    expect(port.mayUpload()).toBe(false)
    expect(transport).toHaveBeenCalledTimes(1)
    const sent = transport.mock.calls[0]![0]
    const body = JSON.parse(sent.toString())
    expect(body).toMatchObject({
      max_tokens: 400,
      reasoning_effort: 'low',
      stream: true,
      stream_options: { include_usage: true },
    })
    const reservation = begin.mock.calls[0]![0]
    expect(reservation).toMatchObject({
      requestDigest: sha(sent),
      requestBytes: sent.byteLength,
      maxOutputTokens: 400,
    })
    expect(reservation).not.toHaveProperty('messages')
    expect(settle.mock.calls[0]![0]).toEqual({
      attemptId: reservation.attemptId,
      requestDigest: reservation.requestDigest,
      outcome: {
        kind: 'actual',
        inputTokens: 327,
        outputTokens: 123,
        responseIdDigest: sha('synthetic-request'),
      },
    })
    expect(observe.mock.calls.map(([fact]) => fact.stage)).toEqual(['sent', 'provider_usage'])
    finishSettlement?.(true)
    expect(await result).toEqual(withUsage())
    expect(port.mayUpload()).toBe(true)
    const next = Buffer.from(
      JSON.stringify({
        ...raw,
        messages: [...raw.messages, { role: 'user', content: 'new synthetic history' }],
      }),
    )
    await port.request(next, signal())
    expect(begin.mock.calls[1]![0].attemptId).not.toBe(reservation.attemptId)
    await expect(port.request(next, signal())).rejects.toThrow('unavailable')
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('denies missing authorization, invalid routes, extra tool types, and oversized requests before provider I/O', async () => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>().mockResolvedValue(false)
    const settle = vi.fn<DiscoveryModelHubPort['settle']>()
    const transport = vi.fn<DiscoveryModelProviderTransport>()
    const make = () =>
      createDiscoveryLiveModelPort(options, { begin, settle }, undefined, transport)
    await expect(make().request(request, signal())).rejects.toThrow('unavailable')
    for (const invalid of [
      { ...raw, model: 'unapproved' },
      { ...raw, tools: [{ type: 'web_search' }] },
      { ...raw, tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }] },
      { ...raw, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] },
    ])
      await expect(make().request(Buffer.from(JSON.stringify(invalid)), signal())).rejects.toThrow(
        'unavailable',
      )
    expect(begin).toHaveBeenCalledTimes(1)
    expect(transport).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(() =>
      createDiscoveryLiveModelPort(
        {
          ...options,
          executor: { ...options.executor, endpoint: 'http://127.0.0.1:4321' },
        },
        { begin, settle },
      ),
    ).toThrow('unavailable')
  })

  it.each([
    { name: 'unconfirmed provider failure', body: undefined, kind: 'unknown' },
    { name: 'partial stream', body: Buffer.from(finish), kind: 'unknown' },
    {
      name: 'confirmed completion without usage',
      body: Buffer.from(finish + done),
      kind: 'confirmed_missing_usage',
    },
    { name: 'overshot output ceiling', body: withUsage(19, 401), kind: 'actual' },
    {
      name: 'attributable overage followed by socket truncation',
      body: withUsage(19, 401).subarray(0, -done.length),
      incomplete: true,
      kind: 'actual',
    },
    {
      name: 'attributable overage followed by malformed SSE',
      body: Buffer.concat([withUsage(19, 401), Buffer.from('data: {invalid-json}\n\n')]),
      kind: 'actual',
    },
    {
      name: 'attributable overage followed by invalid UTF-8',
      body: Buffer.concat([withUsage(19, 401), Buffer.from([0xff])]),
      kind: 'actual',
    },
    {
      name: 'a second usage with conflicting counts after malformed SSE',
      body: Buffer.from(
        withUsage(19, 401).toString() +
          'data: {invalid-json}\n\n' +
          event({
            id: 'synthetic-request',
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
      ),
      kind: 'unknown',
    },
    {
      name: 'a conflicting provider response identity after malformed SSE',
      body: Buffer.from(
        withUsage(19, 401).toString() +
          'data: {invalid-json}\n\n' +
          event({ id: 'different-response', choices: [] }),
      ),
      kind: 'unknown',
    },
    { name: 'zero input counters on a nonempty request', body: withUsage(0, 123), kind: 'unknown' },
    {
      name: 'zero output counters on a finished tool call',
      body: withUsage(327, 0),
      kind: 'unknown',
    },
  ])('settles $name without exposing content or retrying', async ({ body, kind, incomplete }) => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>().mockResolvedValue(true)
    const settle = vi.fn<DiscoveryModelHubPort['settle']>().mockResolvedValue(true)
    const transport = vi.fn<DiscoveryModelProviderTransport>().mockImplementation(async () => {
      if (body === undefined) throw new Error('fake network failure')
      return { body, complete: !incomplete }
    })
    const port = createDiscoveryLiveModelPort(options, { begin, settle }, undefined, transport)
    await expect(port.request(request, signal())).rejects.toThrow('unavailable')
    expect(settle.mock.calls[0]![0].outcome.kind).toBe(kind)
    if (kind === 'actual')
      expect(settle.mock.calls[0]![0].outcome).toMatchObject({ outputTokens: 401 })
    expect(port.mayUpload()).toBe(false)
    await expect(port.request(request, signal())).rejects.toThrow('unavailable')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(begin).toHaveBeenCalledTimes(1)
  })

  it('settles known usage after client abort but releases no content', async () => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>().mockResolvedValue(true)
    const settle = vi.fn<DiscoveryModelHubPort['settle']>().mockResolvedValue(true)
    const client = new AbortController()
    const port = createDiscoveryLiveModelPort(options, { begin, settle }, undefined, async () => {
      client.abort()
      return { body: withUsage() }
    })
    await expect(port.request(request, client.signal)).rejects.toThrow('unavailable')
    expect(settle.mock.calls[0]![0].outcome.kind).toBe('actual')
    expect(settle.mock.calls[0]![1].aborted).toBe(false)
    expect(port.mayUpload()).toBe(false)
  })

  it('settles a validated empty completion at its positive prompt usage but never releases it', async () => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>().mockResolvedValue(true)
    const settle = vi.fn<DiscoveryModelHubPort['settle']>().mockResolvedValue(true)
    const transport = vi.fn<DiscoveryModelProviderTransport>()
    const emptyStop = event({
      id: 'synthetic-request',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '', reasoning_content: null, tool_calls: [] },
          finish_reason: 'stop',
        },
      ],
    })
    transport.mockResolvedValue({ body: Buffer.from(emptyStop + usage(327, 0) + done) })
    const port = createDiscoveryLiveModelPort(options, { begin, settle }, undefined, transport)
    await expect(port.request(request, signal())).rejects.toThrow('unavailable')
    expect(settle.mock.calls[0]![0].outcome).toEqual({
      kind: 'actual',
      inputTokens: 327,
      outputTokens: 0,
      responseIdDigest: sha('synthetic-request'),
    })
    expect(port.mayUpload()).toBe(false)
    await expect(port.request(request, signal())).rejects.toThrow('unavailable')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'generated text', delta: { content: 'private draft' }, tail: done },
    { name: 'generated reasoning', delta: { reasoning_content: 'plan' }, tail: done },
    { name: 'generated tool call', delta: { tool_calls: [{ index: 0, id: 'call' }] }, tail: done },
    { name: 'incomplete stream', delta: {}, tail: '' },
  ])('holds the reservation for zero counters with $name', async ({ delta, tail }) => {
    const begin = vi.fn<DiscoveryModelHubPort['begin']>().mockResolvedValue(true)
    const settle = vi.fn<DiscoveryModelHubPort['settle']>().mockResolvedValue(true)
    const chunk = event({
      id: 'synthetic-request',
      choices: [{ index: 0, delta, finish_reason: null }],
    })
    const stop = event({ id: 'synthetic-request', choices: [{ index: 0, finish_reason: 'stop' }] })
    const body = Buffer.from(chunk + stop + usage(327, 0) + tail)
    const port = createDiscoveryLiveModelPort(options, { begin, settle }, undefined, async () => ({
      body,
    }))
    await expect(port.request(request, signal())).rejects.toThrow('unavailable')
    expect(settle.mock.calls[0]![0].outcome).toEqual({ kind: 'unknown' })
    expect(port.mayUpload()).toBe(false)
  })
})
