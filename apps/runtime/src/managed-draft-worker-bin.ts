#!/usr/bin/env node
/** Internal worker entry; invoked only by a trusted host under the OS file/socket policy. */
import { writeSync } from 'node:fs'
import { runManagedDraftWorker } from '@whalepod/runtime-dsh/managed-draft'

try {
  const path = process.argv[2]
  const ready = process.argv.length === 4 && process.argv[3] === '--isolated-host-ready'
  if (!path || (!ready && process.argv.length !== 3))
    throw new Error('managed_draft_worker_rejected')
  const write = (value: unknown): void => {
    writeSync(1, `${JSON.stringify(value)}\n`)
  }
  await runManagedDraftWorker(
    process.stdin,
    path,
    write,
    ready ? () => write({ kind: 'isolation.ready' }) : undefined,
  )
} catch {
  writeSync(2, '{"component":"runtime.managed_draft","reason":"worker_rejected"}\n')
  process.exitCode = 1
}
