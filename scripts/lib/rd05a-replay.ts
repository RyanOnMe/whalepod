/** Loopback-only provider replies for the combined RD05a production acceptance. */
import assert from 'node:assert/strict'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { sha256 } from './acceptance-provenance.js'
import {
  Rd04c2Replay,
  privateMarker,
  toolErrorCallId,
  toolErrorMarker,
  toolErrorText,
  type FrozenInput,
} from './rd04c2-replay.js'

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
  finalDelivered: boolean
}
export interface ActualPrivateRead {
  inboxItemId: string
  callId: string
  sourceId: string
  sourceType: string
  sourceVersion: string
  title: string
  byteSize: number
  bodyDigest: string
}
interface PrivateTurn {
  manifest: string
  calls: ToolCall[]
  results: string[]
  completed: boolean
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
  fastRunIds = { first: '', second: '' }
  resolveFastRuns?: () => Promise<{ first: string; second: string }>
  handoffCalls: { runId: string; phase: number; inputTokens: number; outputTokens: number }[] = []
  firstFinal?: ServerResponse
  routerCalls: { decision: string; sources: number; evidence: number }[] = []
  executorCalls: { phase: number; name: string; inboxItemId?: string; bodyDigest?: string }[] = []
  slow = new Rd04c2Replay(publicBody, sourceBody, true)
  failures: string[] = []
  private readonly fastTurns = new Map<number, FastTurn>()
  actualPrivateReads: ActualPrivateRead[] = []
  private readonly privateTurns = new WeakMap<Rd04c2Replay, PrivateTurn>()

  assertHealthy() {
    assert.equal(this.failures.length, 0, this.failures.join('; '))
    this.slow.assertHealthy()
  }

  releaseFirstFinal() {
    assert(this.firstFinal && !this.firstFinal.writableEnded, 'publication barrier is not pending')
    const turn = this.fastTurns.get(1)
    assert(turn?.stopped, 'first Executor has not reached its final response')
    this.firstFinal.once('finish', () => {
      turn.finalDelivered = true
    })
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

  private async handoff(request: CompletionRequest, response: ServerResponse) {
    assert.equal(request.stream, true, 'handoff must stream')
    assert.equal(request.tools?.length ?? 0, 0, 'handoff cannot use tools')
    assert.deepEqual(
      request.messages.map((message) => message.role),
      ['system', 'user'],
    )
    assert(
      request.messages.every((message) => !message.tool_calls && !message.tool_call_id),
      'handoff received tool history',
    )
    const [system, user] = request.messages
    assert(system?.content?.startsWith('你是交接整理助手。'), 'wrong handoff system prompt')
    const prompt = user?.content
    assert(typeof prompt === 'string', 'missing handoff material')
    const headings = [...prompt.matchAll(/^# .+$/gm)].map((match) => match[0])
    assert.deepEqual(
      headings,
      [
        '# 任务约定（本次执行的依据）',
        '# 本次执行登记过的 Artifact',
        '# 执行对话（user=指令，assistant=产出）',
        '# 来源 Run',
      ],
      'handoff sections differ',
    )
    const sections = prompt.split(/\n\n(?=# )/)
    assert.equal(sections.length, 4, 'handoff section boundaries differ')
    assert.equal(
      sections[0],
      [
        '# 任务约定（本次执行的依据）',
        '版本 v1',
        '目标：Maintain venue seating and signage',
        '约束：Venue plan only; draft outputs',
        '验收条件：Traceable accessible seating',
        '待确认问题：（未填写）',
      ].join('\n'),
      'handoff material differs from confirmed agreement',
    )
    const runId = sections[3]!.match(/^# 来源 Run\nrunId=([a-f0-9-]{36})$/)?.[1]
    assert(runId, 'handoff source Run missing')
    if (this.resolveFastRuns) this.fastRunIds = await this.resolveFastRuns()
    const phase = runId === this.fastRunIds.first ? 1 : runId === this.fastRunIds.second ? 2 : 0
    assert(phase > 0, 'handoff belongs to another Run')
    assert(this.fastTurns.get(phase)?.finalDelivered, 'handoff preceded Executor completion')
    assert(!this.handoffCalls.some((call) => call.runId === runId), 'duplicate handoff request')
    const final =
      phase === 1 ? 'Site survey prepared.' : 'Updated venue draft is available for owner review.'
    assert.equal(
      sections[1],
      '# 本次执行登记过的 Artifact\n- Acceptance draft ' + phase,
      'handoff lost actual candidate',
    )
    const transcript = sections[2]!.slice('# 执行对话（user=指令，assistant=产出）\n'.length)
    const assistantReplies = transcript.split('\n').filter((line) => line.startsWith('[assistant]'))
    assert.deepEqual(
      assistantReplies,
      ['[assistant] ' + final],
      'handoff lost actual final response',
    )
    assert.equal(transcript.split('\n').at(-1), '[assistant] ' + final, 'handoff final is not last')
    this.handoffCalls.push({ runId, phase, inputTokens: 200, outputTokens: 50 })
    replyStream(response, {
      text: JSON.stringify({
        completed: [{ text: final, verified: false, refs: [{ kind: 'run', runId }] }],
        interfaces: [],
        unfinished: [],
        decisions: [],
        evidence: [],
        downstream: [],
        commits: [],
        prs: [],
      }),
    })
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
    const turn = this.fastTurns.get(phase) ?? {
      calls: [],
      results: [],
      stopped: false,
      finalDelivered: false,
    }
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
    response.once('finish', () => {
      turn.finalDelivered = true
    })
    replyStream(response, { text: 'Updated venue draft is available for owner review.' })
  }

  private validatePrivate(request: CompletionRequest) {
    assert.equal(request.stream, true, 'private Executor must stream')
    assert.deepEqual(
      request.tools?.map((tool) => tool.function.name).sort(),
      ['publish_artifact', 'read_work_input', 'write'],
      'private Executor must retain the c2 tool surface',
    )
    const prompt = request.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content ?? '')
      .join('\n')
    const entries = [...prompt.matchAll(/\{"inboxItemId":"[a-f0-9-]{36}"[^{}]+\}/g)].map(
      (match) => JSON.parse(match[0]) as FrozenInput,
    )
    assert(this.slow.allowedSources.length > 0, 'private authorized sources missing')
    assert.equal(entries.length, this.slow.allowedSources.length, 'private manifest size differs')
    assert.equal(
      new Set(entries.map((entry) => entry.inboxItemId)).size,
      entries.length,
      'duplicate private inbox ids',
    )
    assert.equal(
      new Set(entries.map((entry) => entry.title)).size,
      entries.length,
      'duplicate private source titles',
    )
    const frozen = this.slow.allowedSources.map((source) => {
      assert(
        'sourceId' in source && typeof source.sourceId === 'string',
        'authorized source id missing',
      )
      const entry = entries.find((item) => item.title === source.title)
      assert(
        entry &&
          entry.sourceType === 'discovery_source' &&
          entry.sourceVersion === source.sourceVersion &&
          entry.byteSize === Buffer.byteLength(source.body),
        'private manifest differs from authorized source',
      )
      return { ...entry, sourceId: source.sourceId, body: source.body }
    })
    const path = prompt.match(/\.whalepod\/drafts\/[a-f0-9-]{36}\.md/)?.[0]
    assert(path, 'private draft path missing')
    const manifest = JSON.stringify({ frozen, path })
    const prior = this.privateTurns.get(this.slow)
    if (prior) {
      assert(!prior.completed, 'private execution repeated after stop')
      assert.equal(manifest, prior.manifest, 'private manifest changed during execution')
    }
    const calls: ToolCall[] = frozen.map((entry, index) => ({
      id: 'private-read-' + index,
      name: 'read_work_input',
      args: { inboxItemId: entry.inboxItemId },
    }))
    if (this.slow.toolErrorFollowup)
      calls.push({
        id: toolErrorCallId,
        name: 'read_work_input',
        args: { inboxItemId: toolErrorMarker },
      })
    calls.push(
      {
        id: 'private-write',
        name: 'write',
        args: {
          file_path: path,
          content: '# ' + privateMarker + '\n\n' + frozen.map((entry) => entry.body).join('\n'),
        },
      },
      {
        id: 'private-upload',
        name: 'publish_artifact',
        args: { relativePath: path, title: privateMarker, mediaType: 'text/markdown' },
      },
    )
    const step = prior?.calls.length ?? 0
    assert(step <= calls.length, 'private execution has extra history')
    const history = request.messages.filter(
      (message) =>
        message.role === 'assistant' ||
        message.role === 'tool' ||
        message.tool_calls !== undefined ||
        message.tool_call_id !== undefined,
    )
    assert.equal(history.length, step * 2, 'private call/result history is missing or duplicated')
    const reads: ActualPrivateRead[] = []
    const results = calls.slice(0, step).map((expected, index) => {
      const assistant = history[index * 2]!
      const tool = history[index * 2 + 1]!
      assert.equal(assistant.role, 'assistant', 'private function call has wrong role')
      assert.equal(assistant.tool_call_id, undefined, 'private assistant contains a result id')
      assert.equal(assistant.tool_calls?.length, 1, 'private assistant call missing or duplicated')
      const call = assistant.tool_calls[0]!
      assert.equal(call.id, expected.id, 'private assistant call id differs')
      assert.equal(call.type, 'function')
      assert.equal(call.function.name, expected.name, 'private assistant tool differs')
      assert.deepEqual(
        JSON.parse(call.function.arguments),
        expected.args,
        'private assistant arguments differ',
      )
      assert.equal(tool.role, 'tool', 'private result has wrong role')
      assert.equal(tool.tool_call_id, call.id, 'private result does not match actual call id')
      assert.equal(tool.tool_calls, undefined, 'private result contains function calls')
      assert(
        typeof tool.content === 'string' && tool.content.length > 0,
        'private result content missing',
      )
      if (index < (prior?.results.length ?? 0))
        assert.equal(tool.content, prior!.results[index], 'private cumulative result changed')
      const entry = frozen[index]
      if (entry) {
        const separator = tool.content.indexOf('\n\n')
        assert(separator >= 0, 'private work input header delimiter missing')
        const header = tool.content.slice(0, separator).split('\n')
        assert.equal(header.length, 7, 'private work input header shape differs')
        const inbox = /^work input: ([a-f0-9-]{36})$/.exec(header[0]!)
        const source = /^source: ([^/]+)\/([a-f0-9-]{36})$/.exec(header[1]!)
        const version = /^version: (.+)$/.exec(header[2]!)
        const title = /^title: (.+)$/.exec(header[3]!)
        const digest = /^digest: ([a-f0-9]{64})$/.exec(header[4]!)
        const bytes = /^byteSize: (0|[1-9]\d*)$/.exec(header[5]!)
        assert(
          inbox && source && version && title && digest && bytes,
          'private work input header fields missing',
        )
        assert.equal(header[6], 'truncated: false', 'private source was truncated')
        const body = tool.content.slice(separator + 2)
        const actual: ActualPrivateRead = {
          inboxItemId: inbox[1]!,
          callId: call.id,
          sourceType: source[1]!,
          sourceId: source[2]!,
          sourceVersion: version[1]!,
          title: title[1]!,
          byteSize: Number(bytes[1]),
          bodyDigest: sha256(body),
        }
        assert.equal(actual.inboxItemId, entry.inboxItemId, 'actual private inbox id differs')
        assert.equal(actual.sourceId, entry.sourceId, 'actual private source id differs')
        assert.equal(actual.sourceType, entry.sourceType, 'actual private source type differs')
        assert.equal(
          actual.sourceVersion,
          entry.sourceVersion,
          'actual private source version differs',
        )
        assert.equal(actual.title, entry.title, 'actual private source title differs')
        assert.equal(actual.byteSize, entry.byteSize, 'actual private byte size differs')
        assert.equal(Buffer.byteLength(body), actual.byteSize, 'actual private body size differs')
        assert.equal(digest[1], actual.bodyDigest, 'actual private digest header differs')
        assert.equal(body, entry.body, 'actual private source body differs')
        reads.push(actual)
      } else if (expected.id === toolErrorCallId) {
        assert.equal(tool.content, toolErrorText, 'private actual work-input error differs')
      } else assert(!tool.content.startsWith('Error:'), 'private draft tool failed')
      return tool.content
    })
    return { manifest, calls, results, reads, step }
  }

  async respond(incoming: IncomingMessage, response: ServerResponse) {
    try {
      if (this.stage === 'discovery') {
        this.slow.phase = this.stage
        return await this.slow.respond(incoming, response)
      }
      assert.equal(incoming.method, 'POST')
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const request = JSON.parse(bytes.toString()) as CompletionRequest
      if (this.stage === 'private') {
        assert.equal(incoming.url, '/chat/completions', 'private execution used the wrong route')
        const checked = this.validatePrivate(request)
        // c2 still owns every reply and its authorization callback. Give it the
        // untouched provider bytes on a fresh IncomingMessage readable stream.
        // An independent socket prevents IncomingMessage auto-destroy from
        // closing the live response connection when c2 finishes iteration.
        const delegated = new IncomingMessage(new Socket())
        delegated.method = incoming.method
        delegated.url = incoming.url
        delegated.headers = incoming.headers
        delegated.push(bytes)
        delegated.push(null)
        this.slow.phase = 'private'
        try {
          await this.slow.respond(delegated, response)
        } finally {
          delegated.destroy()
        }
        if (response.statusCode === 200 && this.slow.failures.length === 0) {
          this.actualPrivateReads = checked.reads
          this.privateTurns.set(this.slow, {
            manifest: checked.manifest,
            calls: checked.calls.slice(0, checked.step + 1),
            results: checked.results,
            completed: checked.step === checked.calls.length,
          })
        }
        return
      }
      if (incoming.url === '/discovery/chat/completions') this.router(request, response)
      else {
        assert.equal(incoming.url, '/chat/completions', 'unrecognized replay route')
        if (request.messages.some((message) => message.content?.startsWith('你是交接整理助手。')))
          await this.handoff(request, response)
        else this.executor(request, response)
      }
    } catch (error) {
      this.failures.push(error instanceof Error ? error.message : String(error))
      response.writeHead(400).end('fixture rejected the request')
    }
  }
}
