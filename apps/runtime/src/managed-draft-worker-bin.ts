#!/usr/bin/env node
/** Internal worker entry; invoked only by a trusted host under the OS file/socket policy. */
import { writeSync } from 'node:fs'
import { runManagedDraftWorker } from '@whalepod/runtime-dsh/managed-draft'

try {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3) throw new Error('managed_draft_worker_rejected')
  await runManagedDraftWorker(process.stdin, path, (value) => {
    writeSync(1, `${JSON.stringify(value)}\n`)
  })
} catch {
  writeSync(2, '{"component":"runtime.managed_draft","reason":"worker_rejected"}\n')
  process.exitCode = 1
}
