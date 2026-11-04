#!/usr/bin/env node
/** Only loaded inside the OS no-network sandbox. No business Runtime imports. */
import { writeSync } from 'node:fs'
import { runCoordinationWorkerMode } from '@whalepod/runtime-dsh/coordination'

await runCoordinationWorkerMode(process.stdin, (value) => {
  writeSync(1, `${JSON.stringify(value)}\n`)
})
