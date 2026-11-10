import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANAGED_DRAFT_MAX_CONTENT_BYTES,
  MANAGED_DRAFT_MODEL_MAX_TOKENS,
  MANAGED_DRAFT_SOURCE_INSTRUCTION,
  buildManagedDraftModelBody,
  type NodeDownstream,
} from '@whalepod/protocol'
import { z } from 'zod'
import {
  callManagedDraftModel,
  fetchManagedDraftSource,
  type ManagedDraftHubIdentity,
} from './hub-client.js'

type Offer = Extract<NodeDownstream, { type: 'managed_draft.execute' }>['payload']
const require = createRequire(import.meta.url)
const maxWorkerFrame = 8 * MANAGED_DRAFT_MAX_CONTENT_BYTES
const executionTimeoutMs = 60_000
const unavailable = () => new Error('managed_draft_execution_unavailable')
const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex')

const WorkerReadySchema = z.strictObject({ kind: z.literal('isolation.ready') })
const WorkerModelSchema = z.strictObject({
  kind: z.literal('model.request'),
  runId: z.uuid(),
  request: z.strictObject({
    attemptId: z.uuid(),
    sessionId: z.string(),
    model: z.string(),
    maxTokens: z.literal(MANAGED_DRAFT_MODEL_MAX_TOKENS),
    system: z.literal(MANAGED_DRAFT_SOURCE_INSTRUCTION),
    messages: z.tuple([
      z.object({
        role: z.literal('user'),
        content: z.tuple([z.strictObject({ type: z.literal('text'), text: z.string() })]),
      }),
    ]),
    tools: z.tuple([]),
  }),
})
const WorkerReceiptSchema = z.strictObject({
  kind: z.literal('candidate'),
  runId: z.uuid(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelAttemptId: z.uuid(),
  fileWriteReceiptId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.int().min(1).max(MANAGED_DRAFT_MAX_CONTENT_BYTES),
  fileIdentity: z.string().regex(/^[0-9:]{7,160}$/),
})

async function* workerFrames(stdout: AsyncIterable<Buffer>): AsyncGenerator<unknown> {
  const frame = Buffer.alloc(maxWorkerFrame)
  let size = 0
  try {
    for await (const chunk of stdout) {
      let offset = 0
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(10, offset)
        const end = newline === -1 ? chunk.byteLength : newline
        const count = end - offset
        if (size + count > frame.byteLength) throw unavailable()
        chunk.copy(frame, size, offset, end)
        size += count
        offset = end + 1
        if (newline === -1) continue
        const parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(0, size)),
        )
        frame.fill(0, 0, size)
        size = 0
        yield parsed
      }
    }
    if (size !== 0) throw unavailable()
  } finally {
    frame.fill(0)
  }
}

export async function executeManagedDraft(
  hub: ManagedDraftHubIdentity,
  offer: Offer,
  cancellation: AbortSignal,
): Promise<string> {
  if (process.platform !== 'darwin' || process.getuid === undefined) throw unavailable()
  const remaining = Date.parse(offer.manifest.expiresAt) - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw unavailable()
  const signal = AbortSignal.any([
    cancellation,
    AbortSignal.timeout(Math.min(remaining, executionTimeoutMs)),
  ])
  signal.throwIfAborted()
  const parent = await realpath(tmpdir())
  const parentFacts = await lstat(parent)
  if (
    !parentFacts.isDirectory() ||
    (parentFacts.uid !== process.getuid() && parentFacts.uid !== 0) ||
    ((parentFacts.mode & 0o022) !== 0 && (parentFacts.mode & 0o1000) === 0)
  )
    throw unavailable()
  const root = await mkdtemp(join(parent, 'whalepod-managed-draft-'))
  try {
    const rootFacts = await lstat(root)
    if (
      !rootFacts.isDirectory() ||
      rootFacts.uid !== process.getuid() ||
      (rootFacts.mode & 0o077) !== 0
    )
      throw unavailable()
    const sourceFile = join(root, 'source')
    const outputDir = join(root, 'output')
    await mkdir(outputDir, { mode: 0o700 })
    const source = await open(
      sourceFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      signal.throwIfAborted()
      const host = require.resolve('@whalepod/runtime/managed-draft-host')
      const child = spawn(process.execPath, [host, sourceFile, outputDir], {
        env: {},
        cwd: root,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      )
      const stop = () => {
        if (child.pid === undefined || child.exitCode === 0) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // The private group may already have exited.
        }
      }
      child.on('error', () => {})
      child.stdin.on('error', stop)
      child.stderr.resume()
      signal.addEventListener('abort', stop, { once: true })
      const frames = workerFrames(child.stdout)
      try {
        signal.throwIfAborted()
        WorkerReadySchema.parse((await frames.next()).value)
        signal.throwIfAborted()
        const { commandId, manifest, manifestDigest, model } = offer
        const bytes = await fetchManagedDraftSource(
          hub,
          manifest.runId,
          { commandId, manifestDigest, requestId: randomUUID() },
          manifest.source.byteSize,
          signal,
        )
        try {
          signal.throwIfAborted()
          if (
            bytes.byteLength !== manifest.source.byteSize ||
            sha256(bytes) !== manifest.source.sha256
          )
            throw unavailable()
          await source.writeFile(bytes)
        } finally {
          bytes.fill(0)
        }
        signal.throwIfAborted()
        child.stdin.write(
          `${JSON.stringify({
            kind: 'initialize',
            runId: manifest.runId,
            manifestDigest,
            model,
            sha256: manifest.source.sha256,
            byteSize: manifest.source.byteSize,
          })}\n`,
        )
        const message = WorkerModelSchema.parse((await frames.next()).value)
        const { attemptId, sessionId, model: requestedModel, messages } = message.request
        const text = messages[0].content[0].text
        if (
          message.runId !== manifest.runId ||
          sessionId !== `whalepod-managed-draft-${manifest.runId}` ||
          requestedModel !== model ||
          Buffer.byteLength(text) !== manifest.source.byteSize ||
          sha256(text) !== manifest.source.sha256
        )
          throw unavailable()
        const modelBody = buildManagedDraftModelBody(model, text)
        signal.throwIfAborted()
        const response = await callManagedDraftModel(
          hub,
          manifest.runId,
          {
            commandId,
            manifestDigest,
            modelBindingDigest: manifest.modelBindingDigest,
            attemptId,
            requestDigest: sha256(modelBody),
            byteSize: Buffer.byteLength(modelBody),
          },
          signal,
        )
        signal.throwIfAborted()
        child.stdin.end(
          `${JSON.stringify({ kind: 'model.response', attemptId, text: response })}\n`,
        )
        const receipt = WorkerReceiptSchema.parse((await frames.next()).value)
        if (
          receipt.runId !== manifest.runId ||
          receipt.manifestDigest !== manifestDigest ||
          receipt.modelAttemptId !== attemptId ||
          !(await frames.next()).done
        )
          throw unavailable()
        const exit = await exited
        if (exit.code !== 0 || exit.signal !== null) throw unavailable()
        signal.throwIfAborted()
        // The worker output stays in this private root and never becomes an Artifact.
        return attemptId
      } finally {
        signal.removeEventListener('abort', stop)
        stop()
        await frames.return(undefined)
        await exited
      }
    } finally {
      await source.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
