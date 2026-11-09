/** Isolated source worker. The only provider transport is its private stdio. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MANAGED_DRAFT_MAX_CONTENT_BYTES,
  MANAGED_DRAFT_SOURCE_INSTRUCTION,
} from '@whalepod/protocol'
import { writeManagedDraftOutput } from './managed-draft-output.js'
import { bootManagedDraftDshCore } from './managed-draft-model.js'
import { assertManagedDraftProcessIsolation } from './managed-draft-isolation.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/
const MODEL = /^[a-zA-Z0-9_./-]{1,128}$/
const rejected = () => new Error('managed_draft_worker_rejected')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function frame(line: string | undefined, keys: readonly string[]): Record<string, unknown> {
  if (line === undefined || Buffer.byteLength(line) > 8 * MANAGED_DRAFT_MAX_CONTENT_BYTES)
    throw rejected()
  const value: unknown = JSON.parse(line)
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw rejected()
  return value as Record<string, unknown>
}

async function sourceBytes(path: string, size: number): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size !== size || stat.nlink !== 1) throw rejected()
    const bytes = Buffer.alloc(size + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await fd.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total !== size) throw rejected()
    return bytes.subarray(0, size)
  } finally {
    await fd.close()
  }
}

/** The host launches this entry under the OS policy before it can read any source bytes. */
export async function runManagedDraftWorker(
  input: NodeJS.ReadableStream,
  path: string,
  write: (output: unknown) => void,
): Promise<void> {
  await assertManagedDraftProcessIsolation()
  const lines = createInterface({ input, crlfDelay: Infinity })
  const next = lines[Symbol.asyncIterator]()
  try {
    const init = frame((await next.next()).value, [
      'kind',
      'runId',
      'manifestDigest',
      'model',
      'sha256',
      'byteSize',
    ])
    const { runId, manifestDigest, model, sha256, byteSize } = init
    if (
      init['kind'] !== 'initialize' ||
      typeof runId !== 'string' ||
      !UUID.test(runId) ||
      typeof manifestDigest !== 'string' ||
      !SHA.test(manifestDigest) ||
      typeof model !== 'string' ||
      !MODEL.test(model) ||
      typeof sha256 !== 'string' ||
      !SHA.test(sha256) ||
      typeof byteSize !== 'number' ||
      !Number.isSafeInteger(byteSize) ||
      byteSize <= 0 ||
      byteSize > MANAGED_DRAFT_MAX_CONTENT_BYTES
    )
      throw rejected()

    const source = await sourceBytes(path, byteSize)
    if (digest(source) !== sha256) throw rejected()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(source)
    const sessionId = SessionId(`whalepod-managed-draft-${runId}`)
    const provider = 'managed-draft'
    let modelAttemptId: string | undefined
    const ctx = await bootManagedDraftDshCore(
      { sessionId, provider, model, maxTokens: 1024 },
      async function* (request) {
        if (modelAttemptId !== undefined) throw rejected()
        write({ kind: 'model.request', runId, request })
        const result = frame((await next.next()).value, ['kind', 'attemptId', 'text'])
        if (
          result['kind'] !== 'model.response' ||
          result['attemptId'] !== request.attemptId ||
          typeof result['text'] !== 'string' ||
          Buffer.byteLength(result['text']) === 0 ||
          Buffer.byteLength(result['text']) > MANAGED_DRAFT_MAX_CONTENT_BYTES
        )
          throw rejected()
        modelAttemptId = request.attemptId
        yield { type: 'text-delta', index: 0, text: result['text'] }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    )
    try {
      let output = ''
      let success = false
      for await (const chunk of ctx.llm.stream({
        sessionId,
        provider,
        model,
        system: MANAGED_DRAFT_SOURCE_INSTRUCTION,
        messages: [
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        ],
        tools: [],
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish') success = chunk.reason.kind === 'stop'
      }
      if (!success || !output || modelAttemptId === undefined) throw rejected()
      write(
        await writeManagedDraftOutput(
          { runId, manifestDigest, modelAttemptId },
          Buffer.from(output),
        ),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    lines.close()
  }
}

export { spawnManagedDraftProcess } from './managed-draft-isolation.js'
export { prepareManagedDraftCollector } from './managed-draft-output.js'
