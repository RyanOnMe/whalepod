import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bindM1RAProvenance,
  fingerprintAssemblyFiles,
  reserveHoldoutAttempt,
  sha256,
  verifyM1RAProvenance,
} from './acceptance-provenance.js'

const scratch: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wp-acceptance-provenance-'))
  scratch.push(root)
  async function put(path: string, bytes: string) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  return { root, put }
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('acceptance provenance and one-shot holdout', () => {
  it('binds built transitive code and lock/config bytes, not maps or absolute locations', async () => {
    const first = await fixture()
    const second = await fixture()
    for (const sample of [first, second]) {
      await sample.put('apps/hub/dist/server.js', 'main()')
      await sample.put('packages/runtime-dsh/dist/adapter.js', 'adapter()')
      await sample.put('pnpm-lock.yaml', 'locked')
      await sample.put('packages/runtime-dsh/config/base.yml', 'enabled: true')
    }
    const fingerprint = (root: string) =>
      fingerprintAssemblyFiles(
        root,
        ['pnpm-lock.yaml'],
        ['apps/hub/dist', 'packages/runtime-dsh/dist', 'packages/runtime-dsh/config'],
      )
    const initial = await fingerprint(first.root)
    await second.put('packages/runtime-dsh/dist/adapter.js.map', 'source path')
    expect(await fingerprint(second.root)).toBe(initial)
    await second.put('packages/runtime-dsh/dist/adapter.js', 'different()')
    expect(await fingerprint(second.root)).not.toBe(initial)
    await second.put('packages/runtime-dsh/dist/adapter.js', 'adapter()')
    await second.put('pnpm-lock.yaml', 'different lock')
    expect(await fingerprint(second.root)).not.toBe(initial)
    await rm(join(second.root, 'packages/runtime-dsh/dist'), { recursive: true })
    await expect(fingerprint(second.root)).rejects.toThrow()
  })

  it('allows legacy inspection but refuses legacy, mismatched assembly, and substituted events for real calls', () => {
    const current = sha256('current build')
    const events = '{"component":"hub.router"}\n'
    const legacy = { schemaVersion: 1 }
    expect(() => verifyM1RAProvenance(legacy, events)).not.toThrow()
    expect(() => verifyM1RAProvenance(legacy, events, current)).toThrow('legacy M1R-A')
    const bound = { schemaVersion: 2, ...bindM1RAProvenance(current, events) }
    expect(() => verifyM1RAProvenance(bound, events, current)).not.toThrow()
    expect(() => verifyM1RAProvenance(bound, events + '\n', current)).toThrow('event digest')
    expect(() => verifyM1RAProvenance(bound, events, sha256('different build'))).toThrow(
      'assembly changed',
    )
  })

  it('refuses existing canonical holdout result or partial evidence, without rewriting it', async () => {
    for (const name of [
      'result.json',
      'partial.json',
      'failure.json',
      'events.jsonl',
      'score.json',
    ]) {
      const { root, put } = await fixture()
      await put(name, 'original evidence')
      await expect(
        reserveHoldoutAttempt(root, sha256('freeze'), '2026-11-09T00:00:00Z'),
      ).rejects.toThrow('already has evidence')
      expect(await readFile(join(root, name), 'utf8')).toBe('original evidence')
    }
  })

  it('reserves exactly one persistent attempt under concurrent starts and refuses a freeze in the future', async () => {
    const { root } = await fixture()
    const freezeDigest = sha256('freeze')
    await expect(
      reserveHoldoutAttempt(
        root,
        freezeDigest,
        '2026-11-09T00:00:00Z',
        new Date('2026-11-08T23:59:59Z'),
      ),
    ).rejects.toThrow('freeze must precede')
    const start = new Date('2026-11-09T00:00:01Z')
    const two = await Promise.allSettled([
      reserveHoldoutAttempt(root, freezeDigest, '2026-11-09T00:00:00Z', start),
      reserveHoldoutAttempt(root, freezeDigest, '2026-11-09T00:00:00Z', start),
    ])
    expect(two.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const marker = await readFile(join(root, 'attempt.json'), 'utf8')
    await expect(
      reserveHoldoutAttempt(root, freezeDigest, '2026-11-09T00:00:00Z', start),
    ).rejects.toThrow('already has evidence')
    expect(await readFile(join(root, 'attempt.json'), 'utf8')).toBe(marker)
  })
})
