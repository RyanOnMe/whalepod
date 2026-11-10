#!/usr/bin/env node
import { writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnManagedDraftProcess } from '@whalepod/runtime-dsh/managed-draft'

const require = createRequire(import.meta.url)

/** Trusted pipe relay. The worker beneath it runs under the OS file/socket policy. */
async function relay(sourceFile: string, outputDir: string): Promise<void> {
  const workerEntry = require.resolve('@whalepod/runtime/managed-draft-worker')
  const worker = spawnManagedDraftProcess({ sourceFile, outputDir, workerEntry }, [
    workerEntry,
    sourceFile,
    '--isolated-host-ready',
  ])
  const exited = new Promise<number | null>((resolve) => worker.once('close', resolve))
  const stop = () => {
    worker.kill('SIGKILL')
  }
  worker.on('error', stop)
  worker.stdin.on('error', stop)
  process.stdin.on('error', stop)
  process.stdout.on('error', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  worker.stderr.resume()
  worker.stdout.pipe(process.stdout, { end: false })
  process.stdin.pipe(worker.stdin)
  try {
    if ((await exited) !== 0) throw new Error('managed_draft_host_rejected')
  } finally {
    process.stdin.unpipe(worker.stdin)
    process.stdin.destroy()
  }
}

try {
  const [, , sourceFile, outputDir] = process.argv
  if (!sourceFile || !outputDir || process.argv.length !== 4)
    throw new Error('managed_draft_host_rejected')
  await relay(sourceFile, outputDir)
} catch {
  writeSync(2, '{"component":"runtime.managed_draft","reason":"host_rejected"}\n')
  process.exitCode = 1
}
