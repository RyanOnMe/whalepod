import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CoordinationConfigSchema,
  loadCoordinationConfig,
  saveCoordinationConfig,
  coordinationCredentialFacts,
} from '../src/coordination/config.js'
import { SecretStore } from '../src/secret/store.js'

const roots: string[] = []
async function root() {
  const p = await mkdtemp(join(tmpdir(), 'wp-coordination-config-'))
  roots.push(p)
  return p
}
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true })
})
const config = () => ({
  enabled: true,
  ownerUserId: randomUUID(),
  billingUserId: randomUUID(),
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  credentialSlot: 'coordination',
  endpoint: 'https://api.deepseek.com/chat/completions',
})

describe('explicit local coordination configuration', () => {
  it('requires a complete purpose/owner/billing/model/endpoint configuration', () => {
    const input = config()
    expect(CoordinationConfigSchema.safeParse(input).success).toBe(true)
    expect(CoordinationConfigSchema.safeParse({ ...input, billingUserId: undefined }).success).toBe(
      false,
    )
    expect(
      CoordinationConfigSchema.safeParse({
        ...input,
        endpoint: 'https://name:secret@api.test/path',
      }).success,
    ).toBe(false)
    expect(
      CoordinationConfigSchema.safeParse({
        ...input,
        endpoint: 'http://remote.test/chat/completions',
      }).success,
    ).toBe(false)
    expect(
      CoordinationConfigSchema.safeParse({
        ...input,
        endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
      }).success,
    ).toBe(true)
  })
  it('writes private configuration and rejects a widened-permission file', async () => {
    const dir = await root()
    const input = config()
    await saveCoordinationConfig(dir, input)
    const p = join(dir, 'coordination.json')
    expect((await stat(p)).mode & 0o777).toBe(0o600)
    expect(await loadCoordinationConfig(dir)).toEqual(input)
    await chmod(p, 0o644)
    expect(await loadCoordinationConfig(dir)).toBeUndefined()
    expect(await readFile(p, 'utf8')).not.toContain('API_KEY')
  })
  it('never advertises a business secret as a coordination credential', async () => {
    const dir = await root()
    const input = config()
    await saveCoordinationConfig(dir, input)
    await writeFile(
      join(dir, 'secrets.json'),
      JSON.stringify({ [input.provider]: { [input.credentialSlot]: 'business-only' } }),
      { mode: 0o600 },
    )
    expect(await coordinationCredentialFacts(dir)).toEqual([])
    const secrets = new SecretStore(join(dir, 'coordination-secrets.json'), {})
    await secrets.set(input.provider, input.credentialSlot, 'coordination-only')
    expect(await coordinationCredentialFacts(dir)).toEqual([
      {
        provider: input.provider,
        slot: input.credentialSlot,
        ownerUserId: input.ownerUserId,
        billingUserId: input.billingUserId,
      },
    ])
  })
})
