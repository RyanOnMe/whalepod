import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { CoordinationCredentialSlot } from '@whalepod/protocol'
import { SecretStore } from '../secret/store.js'

export const CoordinationConfigSchema = z.strictObject({
  enabled: z.boolean(),
  ownerUserId: z.uuid(),
  billingUserId: z.uuid(),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  credentialSlot: z.string().min(1).max(80),
  configRevision: z.string().min(1).max(128),
  endpoint: z.url().refine((value) => {
    const url = new URL(value)
    return (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    )
  }, 'provider endpoint must use HTTPS or explicit loopback without credentials/query'),
})
export type CoordinationLocalConfig = z.infer<typeof CoordinationConfigSchema>

/** Coordination configuration and credentials never inherit the business-run secret namespace. */
export function coordinationSecrets(stateDir: string): SecretStore {
  return new SecretStore(join(stateDir, 'coordination-secrets.json'), {})
}

export async function loadCoordinationConfig(
  stateDir: string,
): Promise<CoordinationLocalConfig | undefined> {
  const path = join(stateDir, 'coordination.json')
  try {
    if (((await stat(path)).mode & 0o077) !== 0) return undefined
    const parsed = CoordinationConfigSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export async function saveCoordinationConfig(
  stateDir: string,
  input: CoordinationLocalConfig,
): Promise<void> {
  const config = CoordinationConfigSchema.parse(input)
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, 'coordination.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

export async function coordinationCredentialFacts(
  stateDir: string,
): Promise<CoordinationCredentialSlot[]> {
  const config = await loadCoordinationConfig(stateDir)
  if (config === undefined || !config.enabled) return []
  try {
    if (coordinationSecrets(stateDir).resolve(config.provider, config.credentialSlot) === undefined)
      return []
    return [
      {
        provider: config.provider,
        model: config.model,
        scope: 'coordination',
        configRevision: config.configRevision,
        slot: config.credentialSlot,
        ownerUserId: config.ownerUserId,
        billingUserId: config.billingUserId,
      },
    ]
  } catch {
    return []
  }
}
