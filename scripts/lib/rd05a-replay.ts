/** Loopback-only provider replies for the combined RD05a production acceptance. */
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sha256 } from './acceptance-provenance.js'
import { Rd04c2Replay } from './rd04c2-replay.js'

export const firstSource = 'RD05A_INITIAL: The venue plan needs accessible signage.'
export const secondSource =
  'RD05A_SUPPLEMENT: The venue plan must include confirmed wheelchair seating.'
export const publicBody =
  'RD05A_CONTROL: The separate shuttle stop has no permanent boarding ramp.\n'
export const sourceBody =
  'RD05A_SOURCE: The confirmed shuttle stop needs a separate boarding plan using the site survey.'
export const firstDraft = publicBody
export const secondDraft = '# Updated venue plan\n' + secondSource + '\n'

interface ToolCall {
  id: string
  name: string
  args: Record<string, string>
}
interface Message {
  role: string
  content?: string
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: string
    function: { name: string; arguments: string }
  }[]
}
interface CompletionRequest {
  stream?: boolean
  tools?: { function: { name: string } }[]
  messages: Message[]
}
interface FastTurn {
  calls: ToolCall[]
  results: string[]
  stopped: boolean
}

function replyStream(response: ServerResponse, reply: ToolCall | { text: string }) {
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

export class Rd05aReplay {
  stage: 'fast' | 'discovery' | 'private' = 'fast'
  itemIds = { first: '', second: '' }
  firstFinal?: ServerResponse
  routerCalls: { decision: string; sources: number; evidence: number }[] = []
  executorCalls: { phase: number; name: string; inboxItemId?: string; bodyDigest?: string }[] = []
  slow = new Rd04c2Replay(publicBody, sourceBody, true)
  failures: string[] = []
  private readonly fastTurns = new Map<number, FastTurn>()

  assertHealthy() {
    assert.equal(this.failures.length, 0, this.failures.join('; '))
    this.slow.assertHealthy()
  }

  releaseFirstFinal() {
    assert(this.firstFinal && !this.firstFinal.writableEnded, 'publication barrier is not pending')
    replyStream(this.firstFinal, { text: 'Site survey prepared.' })
  }

  private router(request: CompletionRequest, response: ServerResponse) {
    assert.equal(request.stream, false, 'Router must be bounded')
    assert.equal(request.tools?.length ?? 0, 0, 'Router cannot request tools')
    assert(
      request.messages.every((message) => !message.tool_calls && !message.tool_call_id),
      'Router received unexpected tool history',
    )
    const user = request.messages.find((message) => message.role === 'user')?.content
    assert(user, 'missing Router input')
    const prompt = JSON.parse(user) as {
      entries: { id: string; kind: string; body: string }[]
    }
    assert.deepEqual(Object.keys(prompt), ['entries'])
    const sources = prompt.entries.filter((entry) => entry.kind === 'source')
    const evidence = prompt.entries.filter((entry) => entry.kind === 'evidence')
    assert(
      sources.every((entry) => /^S[1-9]\d*$/.test(entry.id)),
      'invalid source labels',
    )
    assert(
      evidence.every((entry) => /^E[1-9]\d*$/.test(entry.id)),
      'invalid evidence labels',
    )
    assert.equal(new Set(prompt.entries.map((entry) => entry.id)).size, prompt.entries.length)
    const index = this.routerCalls.length
    assert(index < 2, 'unexpected Router invocation')
    assert.equal(sources.length, index === 0 ? 2 : 1)
    if (index === 0) {
      assert(
        sources.some((entry) => entry.body === firstSource) &&
          sources.some((entry) => entry.body === secondSource),
        'first boundary must include both observed source revisions',
      )
    } else {
      assert.equal(sources[0]!.body, secondSource, 'second boundary lost the supplemental source')
    }
    assert.equal(evidence.length, 1)
    const original = evidence[0]!
    assert.equal(original.body, firstDraft, 'Router evidence differs from the published control')
    const decision = index === 0 ? 'dispatch' : 'wait'
    const proposal = {
      decision,
      summary: index === 0 ? 'Draft venue plan' : 'No published outcome covers the supplement',
      citations: sources.map((entry) => entry.id),
      coverage: sources.map((entry) => {
        const covered = index === 0 && entry.body === firstSource
        return {
          source: entry.id,
          status: index === 1 ? 'unknown' : covered ? 'covered' : 'uncovered',
          evidence: covered ? [original.id] : [],
        }
      }),
      ...(decision === 'dispatch' ? { actionClass: 'draft' } : { reason: 'upstream_pending' }),
    }
    this.routerCalls.push({ decision, sources: sources.length, evidence: evidence.length })
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(proposal) },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
    )
  }

  private executor(request: CompletionRequest, response: ServerResponse) {
    assert.equal(request.stream, true, 'Executor must stream')
    const tools = request.tools?.map((tool) => tool.function.name) ?? []
    assert.equal(new Set(tools).size, tools.length, 'duplicate Executor tool names')
    // Ordinary fast Runs retain the standard Runtime tools, as in M1R-A.
    // Only discovery Runs use c2's exact three-tool surface.
    for (const name of ['read_work_input', 'write', 'publish_artifact'])
      assert(tools.includes(name), 'required fast Executor tool unavailable: ' + name)
    const user = request.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content ?? '')
      .join('\n')
    assert(
      !user.includes(firstSource) && !user.includes(secondSource),
      'source bodies must arrive through read_work_input',
    )
    const manifests = [...user.matchAll(/"inboxItemId":"([0-9a-f-]{36})"/g)]
    assert.equal(manifests.length, 1, 'Executor must receive exactly one frozen input')
    const inboxItemId = manifests[0]![1]!
    assert.notEqual(this.itemIds.first, this.itemIds.second, 'observed input ids must differ')
    const phase =
      inboxItemId === this.itemIds.first ? 1 : inboxItemId === this.itemIds.second ? 2 : 0
    assert(phase > 0, 'Executor manifest must identify an observed inbox item')
    const turn = this.fastTurns.get(phase) ?? { calls: [], results: [], stopped: false }
    assert(!turn.stopped, 'Executor repeated after stop')
    const history = request.messages.filter(
      (message) =>
        message.role === 'assistant' ||
        message.role === 'tool' ||
        message.tool_calls !== undefined ||
        message.tool_call_id !== undefined,
    )
    assert.equal(history.length, turn.calls.length * 2, 'unexpected or missing tool history')
    const results = turn.calls.map((call, index) => {
      const assistant = history[index * 2]!
      const tool = history[index * 2 + 1]!
      assert.equal(assistant.role, 'assistant', 'missing assistant tool call')
      assert.equal(assistant.tool_calls?.length, 1, 'unexpected assistant tool calls')
      const actual = assistant.tool_calls[0]!
      assert.equal(actual.id, call.id, 'assistant tool call id differs')
      assert.equal(actual.type, 'function')
      assert.equal(actual.function.name, call.name, 'assistant tool name differs')
      assert.deepEqual(JSON.parse(actual.function.arguments), call.args, 'tool arguments differ')
      assert.equal(tool.role, 'tool', 'missing actual tool result')
      assert.equal(tool.tool_call_id, call.id, 'tool result id differs')
      assert(
        typeof tool.content === 'string' && tool.content.length > 0,
        'missing actual tool result content',
      )
      assert(!tool.content.startsWith('Error:'), 'fast tool returned an error')
      if (index < turn.results.length)
        assert.equal(tool.content, turn.results[index], 'cumulative tool result changed')
      return tool.content
    })
    const step = turn.calls.length
    assert(step <= 3, 'unexpected Executor turn')
    let bodyDigest: string | undefined
    if (step > 0) {
      const content = results[0]!
      assert.equal(content.split('\n')[0], 'work input: ' + inboxItemId, 'work input id differs')
      const separator = content.indexOf('\n\n')
      assert(separator >= 0, 'work input result lacks its header/body delimiter')
      bodyDigest = sha256(content.slice(separator + 2))
      assert.equal(
        bodyDigest,
        sha256(phase === 1 ? firstSource : secondSource),
        'actual work input body differs from the observed source bytes',
      )
    }
    const path = `.whalepod/drafts/rd05a-${phase}.md`
    const calls: ToolCall[] = [
      { id: `read-${phase}`, name: 'read_work_input', args: { inboxItemId } },
      {
        id: `write-${phase}`,
        name: 'write',
        args: { file_path: path, content: phase === 1 ? firstDraft : secondDraft },
      },
      {
        id: `candidate-${phase}`,
        name: 'publish_artifact',
        args: {
          relativePath: path,
          title: `Acceptance draft ${phase}`,
          mediaType: 'text/markdown',
        },
      },
    ]
    if (step === 3 && phase === 1)
      assert.equal(this.firstFinal, undefined, 'first publication barrier already exists')
    // Only validated requests become observations. In particular, write.bodyDigest
    // identifies the actual tool-read bytes, not the generated draft body.
    turn.results = results
    this.fastTurns.set(phase, turn)
    const call = calls[step]
    if (call) {
      this.executorCalls.push({
        phase,
        name: call.name,
        ...(step === 0 ? { inboxItemId } : {}),
        ...(step === 1 && bodyDigest !== undefined ? { bodyDigest } : {}),
      })
      turn.calls.push(call)
      return replyStream(response, call)
    }
    this.executorCalls.push({ phase, name: 'stop' })
    turn.stopped = true
    if (phase === 1) {
      // The driver publishes the real first candidate before releasing this response.
      this.firstFinal = response
      return
    }
    replyStream(response, { text: 'Updated venue draft is available for owner review.' })
  }

  async respond(incoming: IncomingMessage, response: ServerResponse) {
    try {
      // Delegate before reading: c2 owns the original IncomingMessage stream and
      // all discovery/private behavior, including its authorization callback.
      if (this.stage !== 'fast') {
        this.slow.phase = this.stage
        return await this.slow.respond(incoming, response)
      }
      assert.equal(incoming.method, 'POST')
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString()) as CompletionRequest
      if (incoming.url === '/discovery/chat/completions') this.router(request, response)
      else {
        assert.equal(incoming.url, '/chat/completions', 'unrecognized replay route')
        this.executor(request, response)
      }
    } catch (error) {
      this.failures.push(error instanceof Error ? error.message : String(error))
      response.writeHead(400).end('fixture rejected the request')
    }
  }
}
