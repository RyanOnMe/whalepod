import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from './acceptance-provenance.js'
import * as replayModule from './rd04c2-replay.js'
import { Rd04c2Replay, privateMarker, publicPrompt, type FrozenInput } from './rd04c2-replay.js'

const errorMarker = 'RD04C2_PRIVATE_TOOL_ERROR_ONLY'
const errorCallId = 'private-read-error'
const errorText = 'Error: unknown work input item: ' + errorMarker
const draftPath = '.whalepod/drafts/33333333-3333-4333-8333-333333333333.md'
const servers: Server[] = []

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

function toolResult(callId: string, content: string): Message {
  // Provider HTTP tool messages have no isError field; the real error is rendered as text.
  return { role: 'tool', tool_call_id: callId, content }
}

function streamedReply(response: { status: number; body: string }): Reply {
  expect(response.status, response.body).toBe(200)
  const first = response.body.split('\n').find((line) => line.startsWith('data: '))
  expect(first).toBeDefined()
  const chunk = JSON.parse(first!.slice(6)) as {
    choices: {
      delta: {
        role: string
        content?: string
        tool_calls?: { id: string; function: { name: string; arguments: string } }[]
      }
    }[]
  }
  const delta = chunk.choices[0]!.delta
  expect(delta.role).toBe('assistant')
  const call = delta.tool_calls?.[0]
  if (call)
    return {
      id: call.id,
      name: call.function.name,
      args: JSON.parse(call.function.arguments) as Record<string, string>,
    }
  expect(delta.content).toBeTypeOf('string')
  return { text: delta.content! }
}

async function loopback(replay: Rd04c2Replay) {
  const server = createServer((incoming, response) => {
    void replay.respond(incoming, response)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback address missing')
  const url = `http://127.0.0.1:${address.port}/chat/completions`
  return async (messages: Message[], names = ['publish_artifact', 'read_work_input', 'write']) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        stream: true,
        messages,
        tools: names.map((name) => ({ type: 'function', function: { name } })),
      }),
    })
    return { status: response.status, body: await response.text() }
  }
}

async function privateFixture(replay: Rd04c2Replay) {
  replay.phase = 'private'
  replay.allowedSources = [
    { title: 'Site survey', sourceVersion: 'survey-v1', body: replay.fixturePublicBody },
    { title: 'Shuttle source', sourceVersion: 'source-v1', body: replay.fixtureSourceBody },
  ]
  const inputs: FrozenInput[] = replay.allowedSources.map((source, index) => ({
    inboxItemId: `${index + 1}1111111-1111-4111-8111-111111111111`,
    title: source.title,
    sourceType: 'discovery_source',
    sourceVersion: source.sourceVersion,
    byteSize: Buffer.byteLength(source.body),
  }))
  const messages: Message[] = [
    {
      role: 'user',
      content:
        'Use these frozen inputs:\n' +
        inputs.map((input) => JSON.stringify(input)).join('\n') +
        '\nWrite to ' +
        draftPath,
    },
  ]
  return { replay, inputs, messages, send: await loopback(replay) }
}

type Session = Awaited<ReturnType<typeof privateFixture>>

async function readSources(session: Session) {
  for (const [index, input] of session.inputs.entries()) {
    const call: ToolCall = {
      id: 'private-read-' + index,
      name: 'read_work_input',
      args: { inboxItemId: input.inboxItemId },
    }
    expect(streamedReply(await session.send(session.messages))).toEqual(call)
    session.messages.push(
      assistant(call),
      toolResult(
        call.id,
        'work input: ' + input.inboxItemId + '\n\n' + session.replay.allowedSources[index]!.body,
      ),
    )
  }
}

async function pendingError() {
  const session = await privateFixture(new Rd04c2Replay(undefined, undefined, true))
  await readSources(session)
  const call: ToolCall = {
    id: errorCallId,
    name: 'read_work_input',
    args: { inboxItemId: errorMarker },
  }
  expect(streamedReply(await session.send(session.messages))).toEqual(call)
  session.messages.push(assistant(call))
  expect(session.replay.toolErrors).toEqual([])
  return session
}

function errorFact() {
  return {
    callId: errorCallId,
    toolName: 'read_work_input',
    role: 'tool',
    resultDigest: sha256(errorText),
  }
}

async function completeDraft(session: Session) {
  const body =
    '# ' +
    privateMarker +
    '\n\n' +
    session.replay.allowedSources.map((source) => source.body).join('\n')
  const write: ToolCall = {
    id: 'private-write',
    name: 'write',
    args: { file_path: draftPath, content: body },
  }
  expect(streamedReply(await session.send(session.messages))).toEqual(write)
  expect(body).not.toContain(errorMarker)
  session.messages.push(assistant(write), toolResult(write.id, 'Draft written.'))
  const publish: ToolCall = {
    id: 'private-upload',
    name: 'publish_artifact',
    args: { relativePath: draftPath, title: privateMarker, mediaType: 'text/markdown' },
  }
  expect(streamedReply(await session.send(session.messages))).toEqual(publish)
  session.messages.push(assistant(publish), toolResult(publish.id, 'Draft published.'))
  expect(streamedReply(await session.send(session.messages))).toEqual({ text: privateMarker })
  expect(session.replay.privateDraftDigest).toBe(sha256(body))
  expect(session.replay.privateReads).toEqual(
    session.inputs.map((input, index) => ({
      inboxItemId: input.inboxItemId,
      bodyDigest: sha256(session.replay.allowedSources[index]!.body),
    })),
  )
  session.replay.assertHealthy()
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

describe('RD-04c2 replay state machine over loopback HTTP', () => {
  it('exports the exact real work-input error contract', () => {
    expect(replayModule).toMatchObject({
      toolErrorMarker: errorMarker,
      toolErrorCallId: errorCallId,
      toolErrorText: errorText,
    })
  })

  it.each(['default', 'disabled', 'custom bytes'] as const)(
    'preserves the original read/write/publish/final bytes with %s mode',
    async (mode) => {
      const replay =
        mode === 'default'
          ? new Rd04c2Replay()
          : mode === 'disabled'
            ? new Rd04c2Replay(undefined, undefined, false)
            : new Rd04c2Replay('Control λ\r\n', 'Source 中文\nlast line\n', false)
      const session = await privateFixture(replay)
      let beforeRead = 0
      replay.beforePrivateRead = async () => {
        beforeRead++
      }
      await readSources(session)
      await completeDraft(session)
      expect(beforeRead).toBe(1)
      expect(replay.toolErrorFollowup).toBe(false)
      expect(replay.toolErrors).toEqual([])
      expect(replay.privateRequests).toBe(session.inputs.length + 3)
    },
  )

  it.each([false, true])(
    'does not alter public-control replies when followup=%s',
    async (followup) => {
      const replay = new Rd04c2Replay(undefined, undefined, followup)
      const send = await loopback(replay)
      const messages: Message[] = [{ role: 'user', content: publicPrompt }]
      const write: ToolCall = {
        id: 'public-write',
        name: 'write',
        args: { file_path: 'rd04c2-site-survey.md', content: replay.fixturePublicBody },
      }
      expect(streamedReply(await send(messages))).toEqual(write)
      messages.push(assistant(write), toolResult(write.id, 'Written.'))
      const publish: ToolCall = {
        id: 'public-upload',
        name: 'publish_artifact',
        args: {
          relativePath: 'rd04c2-site-survey.md',
          title: 'Site survey',
          mediaType: 'text/markdown',
        },
      }
      expect(streamedReply(await send(messages))).toEqual(publish)
      messages.push(assistant(publish), toolResult(publish.id, 'Published.'))
      expect(streamedReply(await send(messages))).toEqual({
        text: 'Public comparison draft is ready.',
      })
      expect(replay.publicRequests).toBe(3)
      expect(replay.toolErrors).toEqual([])
      replay.assertHealthy()
    },
  )

  it('consumes one exact error on the next request and resumes the original bytes without leaking it', async () => {
    const session = await pendingError()
    session.messages.push(toolResult(errorCallId, errorText))
    await completeDraft(session)
    expect(session.replay.toolErrors).toEqual([errorFact()])
    expect(session.replay.privateRequests).toBe(session.inputs.length + 4)
    expect(session.replay.privateReads).toHaveLength(2)
  })

  const invalidResults: { name: string; results: Message[] }[] = [
    { name: 'missing result', results: [] },
    { name: 'wrong call id', results: [toolResult('some-other-call', errorText)] },
    { name: 'missing call id', results: [{ role: 'tool', content: errorText }] },
    {
      name: 'duplicate exact results',
      results: [toolResult(errorCallId, errorText), toolResult(errorCallId, errorText)],
    },
    {
      name: 'duplicate id with one non-error',
      results: [toolResult(errorCallId, errorText), toolResult(errorCallId, errorMarker)],
    },
    {
      name: 'assistant-only error',
      results: [{ role: 'assistant', tool_call_id: errorCallId, content: errorText }],
    },
    {
      name: 'user-only error',
      results: [{ role: 'user', tool_call_id: errorCallId, content: errorText }],
    },
    {
      name: 'successful result merely containing the marker',
      results: [toolResult(errorCallId, 'Read succeeded: ' + errorMarker)],
    },
    { name: 'marker alone', results: [toolResult(errorCallId, errorMarker)] },
    {
      name: 'non-error quoting the full error',
      results: [toolResult(errorCallId, 'Read succeeded: ' + errorText)],
    },
    {
      name: 'different error',
      results: [toolResult(errorCallId, 'Error: unavailable: ' + errorMarker)],
    },
    {
      name: 'error without its Error prefix',
      results: [toolResult(errorCallId, 'unknown work input item: ' + errorMarker)],
    },
    { name: 'trailing newline', results: [toolResult(errorCallId, errorText + '\n')] },
    { name: 'missing content', results: [{ role: 'tool', tool_call_id: errorCallId }] },
    { name: 'empty content', results: [toolResult(errorCallId, '')] },
    {
      name: 'unrelated tool result plus assistant error',
      results: [
        toolResult('unrelated', 'Success.'),
        { role: 'assistant', tool_call_id: errorCallId, content: errorText },
      ],
    },
  ]

  it.each(invalidResults)(
    'rejects $name instead of reporting a tool-error fact',
    async ({ results }) => {
      const session = await pendingError()
      const response = await session.send([...session.messages, ...results])
      expect(response.status).toBe(400)
      expect(response.body).toBe('fixture rejected the request')
      expect(session.replay.toolErrors).toEqual([])
      expect(session.replay.privateDraftDigest).toBeUndefined()
      expect(() => session.replay.assertHealthy()).toThrow()
    },
  )

  it('does not record the same error twice on an immediate replay of its request', async () => {
    const session = await pendingError()
    session.messages.push(toolResult(errorCallId, errorText))
    const first = streamedReply(await session.send(session.messages))
    expect(first).toMatchObject({ id: 'private-write', name: 'write' })
    expect(session.replay.toolErrors).toEqual([errorFact()])
    expect((await session.send(session.messages)).status).toBe(400)
    expect(session.replay.toolErrors).toEqual([errorFact()])
    expect(() => session.replay.assertHealthy()).toThrow()
  })

  it.each(['remove', 'duplicate id', 'change id', 'change role', 'change content'] as const)(
    'revalidates the cumulative error after write: %s',
    async (mutation) => {
      const session = await pendingError()
      const error = toolResult(errorCallId, errorText)
      session.messages.push(error)
      const reply = streamedReply(await session.send(session.messages))
      expect(reply).toMatchObject({ id: 'private-write' })
      if (!('id' in reply)) throw new Error('write tool call missing')
      session.messages.push(assistant(reply), toolResult(reply.id, 'Written.'))
      if (mutation === 'remove') {
        session.messages.splice(session.messages.indexOf(error), 1)
      } else if (mutation === 'duplicate id') {
        // Keep the tool-result count unchanged so the id-uniqueness guard is exercised.
        session.messages[session.messages.length - 1] = toolResult(errorCallId, errorText)
      } else if (mutation === 'change id') error.tool_call_id = 'wrong-call'
      else if (mutation === 'change role') error.role = 'assistant'
      else error.content = 'Success: ' + errorMarker
      expect((await session.send(session.messages)).status).toBe(400)
      expect(session.replay.toolErrors).toEqual([errorFact()])
      expect(() => session.replay.assertHealthy()).toThrow()
    },
  )
})
