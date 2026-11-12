/** Loopback-only responses for the RD-04c2 packaged assembly acceptance. */
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sha256 } from './acceptance-provenance.js'

export const publicBody = 'RD04C2_CONTROL: The shuttle stop has no permanent boarding ramp.\n'
export const sourceBody =
  'RD04C2_SOURCE: Prepare a separate shuttle boarding plan using the site survey.'
export const privateMarker = 'RD04C2_PRIVATE_DRAFT_ONLY'
export const publicPrompt = 'Create the site survey for the acceptance comparison.'

export interface FrozenInput {
  inboxItemId: string
  title: string
  sourceType: string
  sourceVersion: string
  byteSize: number
}

interface Message {
  role: string
  content?: string
  tool_call_id?: string
}

interface CompletionRequest {
  stream?: boolean
  tools?: { function: { name: string } }[]
  messages: Message[]
}

type Reply = { text: string } | { id: string; name: string; args: object }

function replyStream(response: ServerResponse, reply: Reply) {
  const done = 'text' in reply
  const delta = done
    ? { role: 'assistant', content: reply.text }
    : {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: reply.id,
            type: 'function',
            function: { name: reply.name, arguments: JSON.stringify(reply.args) },
          },
        ],
      }
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } },
  ]
  response
    .writeHead(200, { 'content-type': 'text/event-stream' })
    .end(
      chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') +
        'data: [DONE]\n\n',
    )
}

export class Rd04c2Replay {
  phase: 'public' | 'discovery' | 'private' = 'public'
  discoveryRequests = 0
  publicRequests = 0
  privateRequests = 0
  privateReads: { inboxItemId: string; bodyDigest: string }[] = []
  privateDraftDigest: string | undefined
  beforePrivateRead?: () => Promise<void>
  failures: string[] = []
  allowedSources: { title: string; sourceVersion: string; body: string }[] = []

  assertHealthy() {
    assert.equal(this.failures.length, 0, this.failures.join('; '))
  }

  private discovery(request: CompletionRequest, response: ServerResponse) {
    assert.equal(this.phase, 'discovery', 'discovery occurred in the wrong phase')
    assert.equal(++this.discoveryRequests, 1, 'unexpected repeat discovery')
    assert(request.stream === false && !request.tools?.length, 'discovery must be bounded')
    const user = request.messages.find((message) => message.role === 'user')?.content
    assert(user, 'missing discovery input')
    const prompt = JSON.parse(user) as {
      coverageComplete: boolean
      entries: { id: string; kind: string; body: string }[]
    }
    const source = prompt.entries.find((entry) => entry.kind === 'source')
    const slot = prompt.entries.find((entry) => entry.kind === 'slot')
    const evidence = prompt.entries.find((entry) => entry.kind === 'evidence')
    assert(
      prompt.coverageComplete &&
        source?.body === sourceBody &&
        slot &&
        evidence?.body === publicBody,
      'discovery did not see the ordinary comment and published control',
    )
    const proposal = {
      classification: 'independent_gap',
      source: source.id,
      slot: slot.id,
      citations: prompt.entries
        .filter((entry) => ['agreement', 'evidence', 'work'].includes(entry.kind))
        .map((entry) => entry.id),
      reason: 'The existing seating plan leaves shuttle boarding unassigned.',
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }],
        usage: { prompt_tokens: 300, completion_tokens: 70 },
      }),
    )
  }

  private async executor(request: CompletionRequest, response: ServerResponse) {
    assert.equal(request.stream, true)
    const messages = request.messages.filter((message) => message.role === 'user')
    const prompt = messages.map((message) => message.content ?? '').join('\n')
    const toolResults = request.messages.filter((message) => message.role === 'tool')
    const step = toolResults.length
    const tools = new Set(request.tools?.map((tool) => tool.function.name))
    assert(tools.has('write') && tools.has('publish_artifact'), 'draft tools unavailable')
    if (this.phase === 'public') {
      assert(prompt.includes(publicPrompt), 'only the public control can run before authorization')
      assert.equal(++this.publicRequests, step + 1, 'public control repeated')
      const path = 'rd04c2-site-survey.md'
      if (step === 0)
        return replyStream(response, {
          id: 'public-write',
          name: 'write',
          args: { file_path: path, content: publicBody },
        })
      if (step === 1)
        return replyStream(response, {
          id: 'public-upload',
          name: 'publish_artifact',
          args: { relativePath: path, title: 'Site survey', mediaType: 'text/markdown' },
        })
      assert.equal(step, 2)
      return replyStream(response, { text: 'Public comparison draft is ready.' })
    }
    assert.equal(this.phase, 'private', 'execution occurred before authorization')
    assert.equal(++this.privateRequests, step + 1, 'private execution repeated')
    assert(tools.has('read_work_input'), 'private Executor did not receive the work reader')
    assert(
      !prompt.includes(sourceBody) && !prompt.includes(publicBody),
      'source body was sent before its work input read',
    )
    const items = new Map<string, FrozenInput>()
    for (const match of prompt.matchAll(/\{"inboxItemId":"[a-f0-9-]{36}"[^{}]+\}/g)) {
      const entry = JSON.parse(match[0]) as FrozenInput
      assert(!items.has(entry.title), 'private Executor received duplicate source metadata')
      items.set(entry.title, entry)
    }
    const frozen = this.allowedSources.map((source) => {
      const entry = items.get(source.title)
      assert(
        entry?.sourceVersion === source.sourceVersion &&
          entry.sourceType === 'discovery_source' &&
          entry.byteSize === Buffer.byteLength(source.body),
        'private Executor manifest does not match the authorized source',
      )
      return { ...entry, bodyDigest: sha256(source.body) }
    })
    assert.equal(items.size, frozen.length, 'private Executor got extra sources')
    const bodies = frozen.slice(0, step).map((entry, index) => {
      const tool = toolResults.find((result) => result.tool_call_id === 'private-read-' + index)
      assert(typeof tool?.content === 'string', 'actual source tool result missing')
      const separator = tool.content.indexOf('\n\n')
      assert(separator >= 0, 'source tool result is missing its header delimiter')
      const body = tool.content.slice(separator + 2)
      assert.equal(sha256(body), entry.bodyDigest, 'actual tool body differs from authorized bytes')
      if (step === index + 1)
        this.privateReads.push({ inboxItemId: entry.inboxItemId, bodyDigest: sha256(body) })
      return body
    })
    const current = frozen[step]
    if (step === 0 && this.beforePrivateRead) await this.beforePrivateRead()
    if (current)
      return replyStream(response, {
        id: 'private-read-' + step,
        name: 'read_work_input',
        args: { inboxItemId: current.inboxItemId },
      })
    const path = prompt.match(/\.whalepod\/drafts\/[a-f0-9-]{36}\.md/)?.[0]
    assert(path, 'private Executor did not receive its fixed draft path')
    if (step === frozen.length) {
      const body = '# ' + privateMarker + '\n\n' + bodies.join('\n')
      this.privateDraftDigest = sha256(body)
      return replyStream(response, {
        id: 'private-write',
        name: 'write',
        args: { file_path: path, content: body },
      })
    }
    if (step === frozen.length + 1)
      return replyStream(response, {
        id: 'private-upload',
        name: 'publish_artifact',
        args: { relativePath: path, title: privateMarker, mediaType: 'text/markdown' },
      })
    assert.equal(step, frozen.length + 2)
    return replyStream(response, { text: privateMarker })
  }

  async respond(incoming: IncomingMessage, response: ServerResponse) {
    try {
      assert.equal(incoming.method, 'POST')
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString()) as CompletionRequest
      if (incoming.url === '/discovery/chat/completions') this.discovery(request, response)
      else {
        assert.equal(incoming.url, '/chat/completions', 'unrecognized replay route')
        await this.executor(request, response)
      }
    } catch (error) {
      this.failures.push(error instanceof Error ? error.message : String(error))
      response.writeHead(400).end('fixture rejected the request')
    }
  }
}
