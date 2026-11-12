import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { sha256 } from './acceptance-provenance.js'
import { Rd04c2Replay, privateMarker, toolErrorCallId, toolErrorText } from './rd04c2-replay.js'
import * as replayModule from './rd05a-replay.js'
import {
  Rd05aReplay,
  firstDraft,
  firstSource,
  publicBody,
  secondDraft,
  secondSource,
  sourceBody,
} from './rd05a-replay.js'

type ToolCall = { id: string; name: string; args: Record<string, string> }
type Reply = ToolCall | { text: string }
interface Message {
  role: 'user' | 'assistant' | 'tool'
  content?: string
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}
interface Response {
  status: number
  body: string
}
const ids = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
}
const draftPath = '.whalepod/drafts/33333333-3333-4333-8333-333333333333.md'
const tools = ['read_work_input', 'write', 'publish_artifact']

function assistant(call: ToolCall): Message {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    ],
  }
}

function result(call: ToolCall, content: string): Message {
  return { role: 'tool', tool_call_id: call.id, content }
}

function streamed(response: Response): Reply {
  expect(response.status, response.body).toBe(200)
  expect(response.body).toContain('data: [DONE]')
  const chunks = response.body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))
  const delta = chunks[0].choices[0].delta
  expect(delta.role).toBe('assistant')
  const call = delta.tool_calls?.[0]
  expect(chunks[1].choices[0].finish_reason).toBe(call ? 'tool_calls' : 'stop')
  return call
    ? { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }
    : { text: delta.content }
}

function called(response: Response, name: string): ToolCall {
  const reply = streamed(response)
  expect(reply).toMatchObject({ name })
  if (!('id' in reply)) throw new Error('expected a tool call')
  return reply
}

function proposal(response: Response) {
  expect(response.status, response.body).toBe(200)
  const completion = JSON.parse(response.body)
  expect(completion.choices[0].finish_reason).toBe('stop')
  return JSON.parse(completion.choices[0].message.content)
}

async function withLoopback(run: (session: Session) => Promise<void>) {
  const replay = new Rd05aReplay()
  replay.itemIds = { ...ids }
  const controller = new AbortController()
  const pending: Promise<Response>[] = []
  const server = createServer((incoming, response) => void replay.respond(incoming, response))
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing loopback address')
    const send = (
      messages: Message[],
      options: { route?: string; stream?: boolean; tools?: string[]; method?: string } = {},
    ) => {
      const request = fetch(
        `http://127.0.0.1:${address.port}${options.route ?? '/chat/completions'}`,
        {
          method: options.method ?? 'POST',
          headers: { 'content-type': 'application/json', connection: 'close' },
          signal: controller.signal,
          body: JSON.stringify({
            stream: options.stream ?? true,
            messages,
            tools: (options.tools ?? tools).map((name) => ({
              type: 'function',
              function: { name },
            })),
          }),
        },
      ).then(async (response) => ({ status: response.status, body: await response.text() }))
      // A publication-barrier request can still be pending when an assertion fails.
      void request.catch(() => {})
      pending.push(request)
      return request
    }
    await run({ replay, send })
  } finally {
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    await Promise.allSettled(pending)
  }
}

type Session = {
  replay: Rd05aReplay
  send: (
    messages: Message[],
    options?: { route?: string; stream?: boolean; tools?: string[]; method?: string },
  ) => Promise<Response>
}

function routerMessages(second = false): Message[] {
  return [
    {
      role: 'user',
      content: JSON.stringify({
        entries: [
          ...(second ? [] : [{ id: 'S1', kind: 'source', body: firstSource }]),
          { id: second ? 'S1' : 'S2', kind: 'source', body: secondSource },
          { id: 'E1', kind: 'evidence', body: firstDraft },
        ],
      }),
    },
  ]
}

function manifest(key: keyof typeof ids): Message[] {
  return [
    {
      role: 'user',
      content:
        'Use this frozen input:\n' +
        JSON.stringify({ inboxItemId: ids[key], title: 'Venue plan', sourceType: 'comment' }),
    },
  ]
}

const bounded = { route: '/discovery/chat/completions', stream: false, tools: [] as string[] }

function discoveryMessages(): Message[] {
  return [
    {
      role: 'user',
      content: JSON.stringify({
        coverageComplete: true,
        entries: [
          { id: 'S1', kind: 'source', body: sourceBody },
          { id: 'L1', kind: 'slot', body: 'Shuttle boarding' },
          { id: 'E1', kind: 'evidence', body: publicBody },
          { id: 'A1', kind: 'agreement', body: 'Accessible venue' },
          { id: 'W1', kind: 'work', body: 'Confirmed seating plan' },
        ],
      }),
    },
  ]
}

async function expectRejected(session: Session, messages: Message[], options = {}) {
  expect((await session.send(messages, options)).status).toBe(400)
  expect(() => session.replay.assertHealthy()).toThrow()
}

describe('RD05a combined replay over loopback HTTP', () => {
  it('exports the exact fixture bytes and defaults to fast with a replaceable c2 replay', () => {
    expect(replayModule).toMatchObject({
      firstSource: 'RD05A_INITIAL: The venue plan needs accessible signage.',
      secondSource: 'RD05A_SUPPLEMENT: The venue plan must include confirmed wheelchair seating.',
      publicBody: 'RD05A_CONTROL: The separate shuttle stop has no permanent boarding ramp.\n',
      sourceBody:
        'RD05A_SOURCE: The confirmed shuttle stop needs a separate boarding plan using the site survey.',
      secondDraft:
        '# Updated venue plan\nRD05A_SUPPLEMENT: The venue plan must include confirmed wheelchair seating.\n',
    })
    expect(firstDraft).toBe(publicBody)
    const replay = new Rd05aReplay()
    expect(replay.stage).toBe('fast')
    expect(replay.itemIds).toEqual({ first: '', second: '' })
    expect(replay.firstFinal).toBeUndefined()
    expect(replay.routerCalls).toEqual([])
    expect(replay.executorCalls).toEqual([])
    expect(replay.slow).toBeInstanceOf(Rd04c2Replay)
    expect(replay.slow.fixturePublicBody).toBe(publicBody)
    expect(replay.slow.fixtureSourceBody).toBe(sourceBody)
    expect(replay.slow.toolErrorFollowup).toBe(true)
    replay.assertHealthy()
  })

  it('dispatches then waits at the existing coordination endpoint using actual source/evidence bytes', async () => {
    await withLoopback(async ({ replay, send }) => {
      const first = proposal(await send(routerMessages(), bounded))
      expect(first).toMatchObject({
        decision: 'dispatch',
        actionClass: 'draft',
        citations: ['S1', 'S2'],
        coverage: [
          { source: 'S1', status: 'covered', evidence: ['E1'] },
          { source: 'S2', status: 'uncovered', evidence: [] },
        ],
      })
      expect(proposal(await send(routerMessages(true), bounded))).toMatchObject({
        decision: 'wait',
        reason: 'upstream_pending',
        citations: ['S1'],
        coverage: [{ source: 'S1', status: 'unknown', evidence: [] }],
      })
      expect(replay.routerCalls).toEqual([
        { decision: 'dispatch', sources: 2, evidence: 1 },
        { decision: 'wait', sources: 1, evidence: 1 },
      ])
      expect(replay.slow.discoveryRequests).toBe(0)
      replay.assertHealthy()
    })
  })

  it.each(['legacy route', 'streamed', 'tools', 'wrong source', 'wrong evidence', 'third call'])(
    'rejects a fast Router request with %s',
    async (mutation) => {
      await withLoopback(async (session) => {
        const messages = routerMessages()
        const options = { ...bounded }
        if (mutation === 'legacy route') options.route = '/router/chat/completions'
        if (mutation === 'streamed') options.stream = true
        if (mutation === 'tools') options.tools = ['write']
        if (mutation === 'wrong source')
          messages[0]!.content = messages[0]!.content!.replace(
            firstSource,
            firstSource + ' changed',
          )
        if (mutation === 'wrong evidence')
          messages[0]!.content = messages[0]!.content!.replace('RD05A_CONTROL', 'RD05A_SUPPLEMENT')
        if (mutation === 'third call') {
          proposal(await session.send(routerMessages(), bounded))
          proposal(await session.send(routerMessages(true), bounded))
        }
        await expectRejected(session, messages, options)
        expect(session.replay.executorCalls).toEqual([])
      })
    },
  )

  it('reads, writes, uploads and stops both fast inputs, holding the first stop for owner publication', async () => {
    await withLoopback(async ({ replay, send }) => {
      for (const [index, key] of (['first', 'second'] as const).entries()) {
        const messages = manifest(key)
        const read = called(await send(messages), 'read_work_input')
        expect(read.args).toEqual({ inboxItemId: ids[key] })
        messages.push(
          assistant(read),
          result(read, 'work input: ' + ids[key] + '\n\n' + (index ? secondSource : firstSource)),
        )
        const write = called(await send(messages), 'write')
        expect(write.args.content).toBe(index ? secondDraft : firstDraft)
        expect(write.args.file_path).toMatch(/^\.whalepod\/drafts\/.+\.md$/)
        expect(write.args.content).not.toContain(privateMarker)
        messages.push(assistant(write), result(write, 'Written.'))
        const upload = called(await send(messages), 'publish_artifact')
        expect(upload.args).toMatchObject({
          relativePath: write.args.file_path,
          mediaType: 'text/markdown',
        })
        expect(upload.args.title).toBeTypeOf('string')
        messages.push(assistant(upload), result(upload, 'Candidate uploaded.'))
        if (index === 0) {
          let settled = false
          const final = send(messages).then((response) => {
            settled = true
            return response
          })
          void final.catch(() => {})
          await vi.waitFor(() => expect(replay.firstFinal).toBeDefined())
          expect(settled).toBe(false)
          expect(replay.firstFinal!.writableEnded).toBe(false)
          replay.firstFinal!.writeHead(200).end('Owner publication barrier released.')
          expect(await final).toEqual({ status: 200, body: 'Owner publication barrier released.' })
        } else {
          expect(streamed(await send(messages))).toMatchObject({ text: expect.any(String) })
        }
      }
      expect(replay.executorCalls).toEqual(
        (['first', 'second'] as const).flatMap((key, index) => [
          { phase: index + 1, name: 'read_work_input', inboxItemId: ids[key] },
          {
            phase: index + 1,
            name: 'write',
            bodyDigest: sha256(index ? secondSource : firstSource),
          },
          { phase: index + 1, name: 'publish_artifact' },
          { phase: index + 1, name: 'stop' },
        ]),
      )
      expect(replay.slow.publicRequests + replay.slow.privateRequests).toBe(0)
      replay.assertHealthy()
    })
  })

  it.each([
    'unknown id',
    'missing manifest',
    'duplicate manifest',
    'inline body',
    'extra tool',
    'missing tool',
  ])('rejects a fast Executor with %s', async (mutation) => {
    await withLoopback(async (session) => {
      const messages = manifest('first')
      let names = tools
      if (mutation === 'unknown id')
        messages[0]!.content = JSON.stringify({
          inboxItemId: '99999999-9999-4999-8999-999999999999',
        })
      if (mutation === 'missing manifest') messages[0]!.content = 'Draft the venue plan.'
      if (mutation === 'duplicate manifest') messages[0]!.content += '\n' + messages[0]!.content
      if (mutation === 'inline body') messages[0]!.content += '\n' + firstSource
      if (mutation === 'extra tool') names = [...tools, 'shell']
      if (mutation === 'missing tool') names = tools.filter((name) => name !== 'read_work_input')
      await expectRejected(session, messages, { tools: names })
      expect(session.replay.executorCalls).toEqual([])
    })
  })

  it.each([
    'missing read',
    'duplicate read',
    'wrong call id',
    'wrong role',
    'wrong body',
    'missing delimiter',
    'wrong tool name',
    'wrong tool arguments',
    'extra history',
    'changed cumulative read',
    'repeat request',
  ])('rejects fast tool history: %s', async (mutation) => {
    await withLoopback(async (session) => {
      const messages = manifest('second')
      const read = called(await session.send(messages), 'read_work_input')
      if (mutation === 'repeat request') {
        await expectRejected(session, messages)
        expect(session.replay.executorCalls).toHaveLength(1)
        return
      }
      const actual = result(read, 'work input: ' + ids.second + '\n\n' + secondSource)
      const history = assistant(read)
      messages.push(history, actual)
      if (mutation === 'missing read') messages.pop()
      if (mutation === 'duplicate read') messages.push({ ...actual })
      if (mutation === 'wrong call id') actual.tool_call_id = 'unknown-read'
      if (mutation === 'wrong role') actual.role = 'assistant'
      if (mutation === 'wrong body') actual.content += '\n'
      if (mutation === 'missing delimiter') actual.content = secondSource
      if (mutation === 'wrong tool name') history.tool_calls![0]!.function.name = 'write'
      if (mutation === 'wrong tool arguments')
        history.tool_calls![0]!.function.arguments = JSON.stringify({ inboxItemId: ids.first })
      if (mutation === 'extra history')
        messages.push(result({ ...read, id: 'extra-result' }, 'Unexpected result.'))
      if (mutation === 'changed cumulative read') {
        const write = called(await session.send(messages), 'write')
        messages.push(assistant(write), result(write, 'Written.'))
        actual.content += '\n'
      }
      const before = session.replay.executorCalls.length
      await expectRejected(session, messages)
      expect(session.replay.executorCalls).toHaveLength(before)
      expect(session.replay.firstFinal).toBeUndefined()
    })
  })

  it('delegates discovery and the full private error-followup to c2 without consuming the request body', async () => {
    await withLoopback(async ({ replay, send }) => {
      replay.stage = 'discovery'
      expect(proposal(await send(discoveryMessages(), bounded))).toMatchObject({
        classification: 'independent_gap',
        source: 'S1',
        slot: 'L1',
        citations: ['E1', 'A1', 'W1'],
      })
      expect(replay.slow.phase).toBe('discovery')
      expect(replay.slow.discoveryRequests).toBe(1)
      replay.stage = 'private'
      replay.slow.allowedSources = [
        { title: 'Site survey', sourceVersion: 'survey-v1', body: publicBody },
        { title: 'Shuttle source', sourceVersion: 'source-v1', body: sourceBody },
      ]
      const sources = replay.slow.allowedSources
      let beforeReads = 0
      replay.slow.beforePrivateRead = async () => {
        beforeReads++
      }
      const messages: Message[] = [
        {
          role: 'user',
          content:
            sources
              .map((source, index) =>
                JSON.stringify({
                  inboxItemId: index ? ids.second : ids.first,
                  title: source.title,
                  sourceType: 'discovery_source',
                  sourceVersion: source.sourceVersion,
                  byteSize: Buffer.byteLength(source.body),
                }),
              )
              .join('\n') +
            '\nWrite to ' +
            draftPath,
        },
      ]
      for (const [index, source] of sources.entries()) {
        const read = called(await send(messages), 'read_work_input')
        expect(read.args.inboxItemId).toBe(index ? ids.second : ids.first)
        messages.push(assistant(read), result(read, 'work input\n\n' + source.body))
      }
      const error = called(await send(messages), 'read_work_input')
      expect(error.id).toBe(toolErrorCallId)
      messages.push(assistant(error), result(error, toolErrorText))
      const write = called(await send(messages), 'write')
      const body = '# ' + privateMarker + '\n\n' + publicBody + '\n' + sourceBody
      expect(write.args).toEqual({ file_path: draftPath, content: body })
      messages.push(assistant(write), result(write, 'Written.'))
      const upload = called(await send(messages), 'publish_artifact')
      expect(upload.args).toEqual({
        relativePath: draftPath,
        title: privateMarker,
        mediaType: 'text/markdown',
      })
      messages.push(assistant(upload), result(upload, 'Uploaded.'))
      expect(streamed(await send(messages))).toEqual({ text: privateMarker })
      expect(beforeReads).toBe(1)
      expect(replay.slow.phase).toBe('private')
      expect(replay.slow.privateRequests).toBe(6)
      expect(replay.slow.privateReads).toEqual([
        { inboxItemId: ids.first, bodyDigest: sha256(publicBody) },
        { inboxItemId: ids.second, bodyDigest: sha256(sourceBody) },
      ])
      expect(replay.slow.privateDraftDigest).toBe(sha256(body))
      expect(replay.slow.toolErrors).toEqual([
        {
          callId: toolErrorCallId,
          toolName: 'read_work_input',
          role: 'tool',
          resultDigest: sha256(toolErrorText),
        },
      ])
      expect(replay.routerCalls).toEqual([])
      expect(replay.executorCalls).toEqual([])
      replay.assertHealthy()
    })
  })

  it('accepts a fresh slow replay for an independent scenario without resetting fast counters', async () => {
    await withLoopback(async ({ replay, send }) => {
      proposal(await send(routerMessages(), bounded))
      called(await send(manifest('first')), 'read_work_input')
      const fastRouter = structuredClone(replay.routerCalls)
      const fastExecutor = structuredClone(replay.executorCalls)
      replay.stage = 'discovery'
      proposal(await send(discoveryMessages(), bounded))
      const original = replay.slow
      replay.slow = new Rd04c2Replay(publicBody, sourceBody, true)
      proposal(await send(discoveryMessages(), bounded))
      expect(original.discoveryRequests).toBe(1)
      expect(replay.slow.discoveryRequests).toBe(1)
      expect(replay.slow.phase).toBe('discovery')
      expect(replay.slow.privateReads).toEqual([])
      expect(replay.slow.privateDraftDigest).toBeUndefined()
      expect(replay.routerCalls).toEqual(fastRouter)
      expect(replay.executorCalls).toEqual(fastExecutor)
      replay.assertHealthy()
    })
  })

  it.each(['fast', 'discovery'] as const)(
    'reports invalid routes from the %s stage through assertHealthy',
    async (stage) => {
      await withLoopback(async (session) => {
        session.replay.stage = stage
        await expectRejected(session, manifest('first'), { route: '/unexpected/chat/completions' })
      })
    },
  )
})
