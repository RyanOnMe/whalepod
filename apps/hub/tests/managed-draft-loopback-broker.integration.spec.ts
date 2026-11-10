import { createServer, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forwardManagedDraftLoopback,
  parseManagedDraftLoopbackEndpoint,
} from '../src/modules/draft-share/loopback-broker.js'

const validResult = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '固定草稿' } }],
  usage: { prompt_tokens: 14, completion_tokens: 4 },
}
const payload = Buffer.from('{"source":"固定来源"}\n')

function json(reply: ServerResponse, value: unknown): void {
  reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture(
  reply: (response: ServerResponse, url?: string) => void = (response) =>
    json(response, validResult),
) {
  const requests: {
    method?: string | undefined
    url?: string | undefined
    authorization?: string | undefined
    bytes: Buffer
  }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      bytes: Buffer.concat(chunks),
    })
    reply(response, request.url)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback fixture')
  return {
    endpoint: parseManagedDraftLoopbackEndpoint(`http://127.0.0.1:${address.port}/fixture`),
    requests,
  }
}

describe('managed draft Hub loopback model forwarding', () => {
  it('pins literal HTTP endpoints and gives only a fixed diagnostic on invalid configuration', () => {
    expect(parseManagedDraftLoopbackEndpoint('http://127.0.0.1:45001/model').hostname).toBe(
      '127.0.0.1',
    )
    expect(parseManagedDraftLoopbackEndpoint('http://[::1]:45001/model').hostname).toBe('[::1]')
    for (const value of [
      'http://localhost:45001/model',
      'http://127.1:45001/model',
      'http://2130706433:45001/model',
      'https://127.0.0.1:45001/model',
      'http://127.0.0.1/model',
      'http://127.0.0.1:80/model',
      'http://127.0.0.1:65536/model',
      'http://192.0.2.1:45001/model',
      'http://fixture-credential@127.0.0.1:45001/model',
      'http://127.0.0.1:45001/model?',
      'http://127.0.0.1:45001/model#',
      'http://127.0.0.1:45001/model\n',
      'http://127.0.0.1:45001/model\\elsewhere',
    ]) {
      expect(() => parseManagedDraftLoopbackEndpoint(value)).toThrowError(
        /^managed_draft_loopback_endpoint_invalid$/,
      )
    }
  })

  it('uses one credential-free POST and sends exactly the bytes admitted at invocation', async () => {
    const { endpoint, requests } = await fixture()
    const bytes = Buffer.from(payload)
    const pending = forwardManagedDraftLoopback(endpoint, bytes)
    bytes.fill(0)
    await expect(pending).resolves.toEqual({ text: '固定草稿', inputTokens: 14, outputTokens: 4 })
    expect(requests).toEqual([
      { method: 'POST', url: '/fixture', authorization: undefined, bytes: payload },
    ])
  })

  it('does not follow a redirect, retry an error, or expose downstream error content', async () => {
    const { endpoint, requests } = await fixture((reply, url) => {
      if (url === '/fixture')
        reply.writeHead(307, { location: '/redirected' }).end('private error marker')
      else json(reply, validResult)
    })
    await expect(forwardManagedDraftLoopback(endpoint, payload)).rejects.toThrowError(
      /^managed_draft_loopback_failed$/,
    )
    expect(requests.map((request) => request.url)).toEqual(['/fixture'])
  })

  it('validates strict completion and usage and rejects oversized chunked responses', async () => {
    const replies = [
      (reply: ServerResponse) =>
        json(reply, {
          ...validResult,
          choices: [{ finish_reason: 'length', message: { content: 'truncated' } }],
        }),
      (reply: ServerResponse) =>
        json(reply, {
          ...validResult,
          choices: [{ finish_reason: 'stop', message: { content: 'tool output', tool_calls: [] } }],
        }),
      (reply: ServerResponse) =>
        json(reply, { ...validResult, usage: { prompt_tokens: '14', completion_tokens: 4 } }),
      (reply: ServerResponse) =>
        json(reply, { ...validResult, usage: { prompt_tokens: 14, completion_tokens: 1025 } }),
      (reply: ServerResponse) =>
        json(reply, {
          ...validResult,
          choices: [{ finish_reason: 'stop', message: { content: '\ud800' } }],
        }),
      (reply: ServerResponse) => {
        reply.writeHead(200, { 'content-type': 'application/json' })
        reply.write(' '.repeat(128 * 1024))
        reply.end(JSON.stringify(validResult))
      },
    ]
    const { endpoint, requests } = await fixture((reply) => replies.shift()!(reply))
    const replyCount = replies.length
    for (let index = 0; index < replyCount; index++) {
      await expect(forwardManagedDraftLoopback(endpoint, payload)).rejects.toThrowError(
        /^managed_draft_loopback_failed$/,
      )
    }
    expect(requests).toHaveLength(replyCount)
  })

  it('honors cancellation during the sole in-flight provider request', async () => {
    const entered = Promise.withResolvers<void>()
    const { endpoint, requests } = await fixture(() => entered.resolve())
    const cancellation = new AbortController()
    const rejected = expect(
      forwardManagedDraftLoopback(endpoint, payload, cancellation.signal),
    ).rejects.toThrowError(/^managed_draft_loopback_failed$/)
    await entered.promise
    cancellation.abort('private reason')
    await rejected
    expect(requests).toHaveLength(1)
  })

  it('revalidates mutable endpoint objects and makes no request after a pre-abort or size rejection', async () => {
    const { endpoint, requests } = await fixture()
    const changed = new URL(endpoint)
    changed.username = 'unexpected'
    await expect(forwardManagedDraftLoopback(changed, payload)).rejects.toThrowError(
      /^managed_draft_loopback_endpoint_invalid$/,
    )
    await expect(
      forwardManagedDraftLoopback(endpoint, payload, AbortSignal.abort('private reason')),
    ).rejects.toThrowError(/^managed_draft_loopback_failed$/)
    await expect(
      forwardManagedDraftLoopback(endpoint, Buffer.alloc(128 * 1024 + 1)),
    ).rejects.toThrowError(/^managed_draft_loopback_failed$/)
    expect(requests).toEqual([])
  })
})
