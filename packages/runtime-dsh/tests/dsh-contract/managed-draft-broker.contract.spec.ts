/** Actual downstream HTTP replay; the authorization port sees only the frozen binding. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { MANAGED_DRAFT_SOURCE_INSTRUCTION } from '@whalepod/protocol'
import {
  createManagedDraftModelBroker,
  type ManagedDraftEgressAuthorization,
} from '../../src/managed-draft-broker.js'

async function downstream(redirect = false) {
  const posts: Buffer[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (req.method === 'POST') posts.push(Buffer.concat(chunks))
    if (redirect && req.url === '/model') {
      res.writeHead(307, { location: '/other-model' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'fixed draft' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fixture endpoint')
  return {
    endpoint: `http://127.0.0.1:${address.port}/model`,
    posts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const source = 'private-source-marker'

function fixture(endpoint: string) {
  const runId = randomUUID()
  const model = 'fixed-model'
  return {
    binding: {
      runId,
      provider: 'fixture-provider',
      model,
      endpoint,
      accountId: 'fixture-account',
      policyVersion: '1',
      manifestDigest: 'a'.repeat(64),
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      sourceByteSize: Buffer.byteLength(source),
    },
    attempt: {
      attemptId: randomUUID(),
      sessionId: SessionId(`whalepod-managed-draft-${runId}`),
      model,
      maxTokens: 256,
      system: MANAGED_DRAFT_SOURCE_INSTRUCTION,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: source }],
          source: { kind: 'user' },
        }),
      ],
      tools: [],
    },
  }
}

describe('RD-03c3a managed source model broker', () => {
  it('does not POST when authorization is revoked before final egress admission', async () => {
    const target = await downstream()
    const { binding, attempt } = fixture(target.endpoint)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let active = true
    let checked: ManagedDraftEgressAuthorization | undefined
    const broker = createManagedDraftModelBroker(binding, 'fixture-credential', async (request) => {
      checked = request
      entered.resolve()
      await resume.promise
      return active ? { ...request, decisionId: randomUUID() } : undefined
    })
    try {
      const result = broker.request(attempt)
      const denied = expect(result).rejects.toThrow('managed_draft_egress_denied')
      await entered.promise
      expect(target.posts).toEqual([])
      active = false
      resume.resolve()
      await denied
      expect(target.posts).toEqual([])
      expect(checked).toMatchObject({ ...binding, attemptId: attempt.attemptId })
      expect(JSON.stringify(checked)).not.toContain('private-source-marker')
      expect(JSON.stringify(checked)).not.toContain('fixture-credential')
      await expect(broker.request(attempt)).rejects.toThrow('managed_draft_egress_denied')
    } finally {
      await target.close()
    }
  })

  it('binds actual sent bytes and refuses a second POST using the same attempt', async () => {
    const target = await downstream()
    const { binding, attempt } = fixture(target.endpoint)
    const checked: ManagedDraftEgressAuthorization[] = []
    const broker = createManagedDraftModelBroker(binding, 'fixture-credential', async (request) => {
      checked.push(request)
      return { ...request, decisionId: randomUUID() }
    })
    try {
      expect(await broker.request(attempt)).toMatchObject({
        text: 'fixed draft',
        inputTokens: 3,
        outputTokens: 2,
      })
      await expect(broker.request(attempt)).rejects.toThrow('managed_draft_egress_denied')
      await expect(broker.request({ ...attempt, attemptId: randomUUID() })).rejects.toThrow(
        'managed_draft_egress_denied',
      )
      expect(target.posts).toHaveLength(1)
      expect(checked).toHaveLength(1)
      expect(checked[0]?.payloadSha256).toBe(
        createHash('sha256').update(target.posts[0]!).digest('hex'),
      )
    } finally {
      await target.close()
    }
  })

  it('never follows a redirect or retries a consumed admission', async () => {
    const target = await downstream(true)
    const { binding, attempt } = fixture(target.endpoint)
    const broker = createManagedDraftModelBroker(
      binding,
      'fixture-credential',
      async (request) => ({
        ...request,
        decisionId: randomUUID(),
      }),
    )
    try {
      await expect(broker.request(attempt)).rejects.toThrow('managed_draft_provider_failed')
      await expect(broker.request(attempt)).rejects.toThrow('managed_draft_egress_denied')
      expect(target.posts).toHaveLength(1)
    } finally {
      await target.close()
    }
  })

  it('rejects an authorization for a different account or payload before sending', async () => {
    const target = await downstream()
    const { binding, attempt } = fixture(target.endpoint)
    const broker = createManagedDraftModelBroker(
      binding,
      'fixture-credential',
      async (request) => ({
        ...request,
        accountId: 'other-account',
        decisionId: randomUUID(),
      }),
    )
    try {
      await expect(broker.request(attempt)).rejects.toThrow('managed_draft_egress_denied')
      expect(target.posts).toEqual([])
    } finally {
      await target.close()
    }
  })

  it('rejects an extra instruction or different source bytes before authorization', async () => {
    const target = await downstream()
    const { binding, attempt } = fixture(target.endpoint)
    let authorizations = 0
    const broker = createManagedDraftModelBroker(binding, 'fixture-credential', async (request) => {
      authorizations++
      return { ...request, decisionId: randomUUID() }
    })
    const anotherSource = (text: string) => [
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    ]
    try {
      for (const changes of [
        { system: 'unregistered instruction' },
        { messages: anotherSource('!' + source.slice(1)) },
        { messages: anotherSource(source + '!') },
      ]) {
        await expect(
          broker.request({ ...attempt, ...changes, attemptId: randomUUID() }),
        ).rejects.toThrow('managed_draft_egress_denied')
      }
      expect(authorizations).toBe(0)
      expect(target.posts).toEqual([])
    } finally {
      await target.close()
    }
  })
})
