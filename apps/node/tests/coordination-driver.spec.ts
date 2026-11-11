import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeCoordinationRuntime } from '../src/coordination/driver.js'

describe('discovery Runtime capability probe', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wp-discovery-probe-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  async function fixture(discoveryPromptVersion?: string) {
    const entry = join(root, 'runtime.mjs')
    await writeFile(
      entry,
      `console.log(${JSON.stringify(JSON.stringify({ supported: true, discovery: true, discoveryPromptVersion }))})\n`,
    )
    return entry
  }

  it('keeps legacy coordination but does not advertise an unspecified discovery prompt', async () => {
    const entry = await fixture()
    await expect(probeCoordinationRuntime(entry)).resolves.toBe(true)
    await expect(probeCoordinationRuntime(entry, 'discovery')).resolves.toBe(false)
  })

  it('requires the exact worker prompt version before advertising discovery', async () => {
    await expect(
      probeCoordinationRuntime(await fixture('discovery.v1'), 'discovery'),
    ).resolves.toBe(false)
    await expect(
      probeCoordinationRuntime(await fixture('discovery.v2'), 'discovery'),
    ).resolves.toBe(true)
  })
})
