#!/usr/bin/env node
import { writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { MANAGED_DRAFT_MAX_CONTENT_BYTES } from '@whalepod/protocol'
import {
  prepareManagedDraftCollector,
  spawnManagedDraftProcess,
} from '@whalepod/runtime-dsh/managed-draft'

const require = createRequire(import.meta.url)
const rejected = () => new Error('managed_draft_host_rejected')

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw rejected()
  return value as Record<string, unknown>
}

async function* workerFrames(stdout: AsyncIterable<Buffer>) {
  const frame = Buffer.alloc(8 * MANAGED_DRAFT_MAX_CONTENT_BYTES)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  try {
    for await (const chunk of stdout) {
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        if (size + end - offset > frame.length) throw rejected()
        chunk.copy(frame, size, offset, end)
        size += end - offset
        offset = end + 1
        if (newline < 0) continue
        const value: unknown = JSON.parse(decoder.decode(frame.subarray(0, size)))
        frame.fill(0, 0, size)
        size = 0
        yield record(value)
      }
    }
    if (size !== 0) throw rejected()
  } finally {
    frame.fill(0)
  }
}

function send(frame: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`, (error) =>
      error ? reject(rejected()) : resolve(),
    )
  })
}

/** The trusted Runtime supervises one isolated worker and verifies its fresh write. */
async function run(
  sourceFile: string,
  outputDir: string,
  runId: string,
  manifestDigest: string,
): Promise<void> {
  const collect = prepareManagedDraftCollector({ outputDir, runId, manifestDigest })
  const workerEntry = require.resolve('@whalepod/runtime/managed-draft-worker')
  const worker = spawnManagedDraftProcess({ sourceFile, outputDir, workerEntry }, [
    workerEntry,
    sourceFile,
    '--isolated-host-ready',
  ])
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    worker.once('close', (code, signal) => resolve({ code, signal })),
  )
  const stop = () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
  }
  worker.on('error', stop)
  worker.stdin.on('error', stop)
  process.stdin.on('error', stop)
  process.stdout.on('error', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  worker.stderr.resume()
  process.stdin.pipe(worker.stdin)
  const frames = workerFrames(worker.stdout)
  try {
    const ready = record((await frames.next()).value)
    if (ready['kind'] !== 'isolation.ready' || Object.keys(ready).length !== 1) throw rejected()
    await send(ready)
    const model = record((await frames.next()).value)
    if (model['kind'] !== 'model.request' || model['runId'] !== runId) throw rejected()
    const attemptId = record(model['request'])['attemptId']
    if (typeof attemptId !== 'string') throw rejected()
    await send(model)
    const receipt = (await frames.next()).value
    if (!(await frames.next()).done) throw rejected()
    // The packaged worker emits its receipt only after accepting the matching broker reply.
    // Node independently binds this attempt to the successful Hub model call.
    const candidate = await collect.collect(receipt, await exited, attemptId)
    try {
      await send({
        kind: 'candidate.verified',
        runId: candidate.runId,
        manifestDigest: candidate.manifestDigest,
        modelAttemptId: candidate.modelAttemptId,
        fileWriteReceiptId: candidate.fileWriteReceiptId,
        sha256: candidate.sha256,
        byteSize: candidate.byteSize,
        bodyBase64url: candidate.body.toString('base64url'),
      })
    } finally {
      candidate.body.fill(0)
    }
  } finally {
    process.stdin.unpipe(worker.stdin)
    process.stdin.destroy()
    stop()
    await frames.return(undefined)
    await exited
  }
}

try {
  const [, , sourceFile, outputDir, runId, manifestDigest] = process.argv
  if (!sourceFile || !outputDir || !runId || !manifestDigest || process.argv.length !== 6)
    throw rejected()
  await run(sourceFile, outputDir, runId, manifestDigest)
} catch {
  writeSync(2, '{"component":"runtime.managed_draft","reason":"host_rejected"}\n')
  process.exitCode = 1
}
