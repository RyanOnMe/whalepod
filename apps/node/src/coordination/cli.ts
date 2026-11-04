import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR } from '../config.js'
import { readHiddenLine } from '../workspace/cli-commands.js'
import {
  CoordinationConfigSchema,
  coordinationSecrets,
  loadCoordinationConfig,
  saveCoordinationConfig,
} from './config.js'

/** An explicit local opt-in; ordinary `secret set` never provisions coordination credentials. */
export async function runCoordinationCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'state-dir': { type: 'string' },
      'owner-user-id': { type: 'string' },
      'billing-user-id': { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      slot: { type: 'string' },
      endpoint: { type: 'string' },
      disabled: { type: 'boolean', default: false },
    },
  })
  const stateDir = values['state-dir'] ?? join(DEFAULT_CONFIG_DIR, 'state')
  await mkdir(stateDir, { recursive: true })
  if (positionals[0] === 'configure') {
    const config = CoordinationConfigSchema.parse({
      enabled: !values.disabled,
      ownerUserId: values['owner-user-id'],
      billingUserId: values['billing-user-id'],
      provider: values.provider,
      model: values.model,
      credentialSlot: values.slot,
      endpoint: values.endpoint,
      configRevision: randomUUID(),
    })
    await saveCoordinationConfig(stateDir, config)
    process.stdout.write(
      `coordination configured: revision=${config.configRevision}; restart Node to refresh capabilities\n`,
    )
    return
  }
  if (positionals[0] === 'secret' && positionals[1] === 'set') {
    const provider = positionals[2]
    const slot = positionals[3]
    const config = await loadCoordinationConfig(stateDir)
    if (config === undefined || provider !== config.provider || slot !== config.credentialSlot)
      throw new Error('configure the exact coordination provider/slot first')
    const secret = await readHiddenLine('Coordination API key: ')
    if (!secret) throw new Error('coordination credential cannot be empty')
    await coordinationSecrets(stateDir).set(provider, slot, secret)
    const revision = randomUUID()
    await saveCoordinationConfig(stateDir, { ...config, configRevision: revision })
    process.stdout.write(
      `coordination credential saved: revision=${revision}; restart Node to refresh inventory\n`,
    )
    return
  }
  throw new Error(
    'usage: whalepod-node coordination configure --owner-user-id <id> --billing-user-id <id> --provider <provider> --model <model> --slot <slot> --endpoint <url>; coordination secret set <provider> <slot>',
  )
}
