/** Shared disposable Hub/Node assembly for acceptance drivers. State changes go through HTTP/WS or CLI. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, schema, type Database } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import { startEphemeralPostgres, type EphemeralPostgres } from './ephemeral-postgres.mts'
import { resolveHubServerEntry } from './phase1/hub-assembly.js'
import { redactText } from './phase1/events.js'

export const repoRoot = join(import.meta.dirname, '..', '..')

export interface AcceptanceActor {
  userId: string
  cookie: string
}

interface ApiOptions {
  actor?: AcceptanceActor | null
  method?: string
  idempotencyKey?: string
  expected?: number
}

export async function until<T>(
  label: string,
  observe: () => Promise<T | undefined>,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await observe()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timeout: ${label}`)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      assert(address && typeof address === 'object')
      resolve(address.port)
    })
  })
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
    timer.unref()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

export class ProductionAcceptance {
  root!: string
  configDir!: string
  stateDir!: string
  workspaceDir!: string
  database!: Database
  owner!: AcceptanceActor
  deviceId!: string
  deviceToken!: string
  origin!: string
  providerOrigin?: string
  private postgres?: EphemeralPostgres
  private readonly provider?: Server
  private readonly nodeEntry = createRequire(
    new URL('../../apps/node/package.json', import.meta.url),
  ).resolve('@whalepod/node/bin')
  readonly runtimeEntry = createRequire(
    new URL('../../apps/node/package.json', import.meta.url),
  ).resolve('@whalepod/runtime/bin')
  readonly children: ChildProcess[] = []
  readonly events: Record<string, unknown>[] = []
  private readonly tails = new Map<ChildProcess, string>()
  private readonly secrets = new Set<string>()

  constructor(listener?: RequestListener) {
    if (listener) this.provider = createServer(listener)
  }

  redact(value: string): string {
    for (const secret of this.secrets) value = value.replaceAll(secret, '[REDACTED]')
    return redactText(value)
  }

  protect(value: string): void {
    if (value) this.secrets.add(value)
  }

  diagnostics(): string {
    return this.events
      .map((event) =>
        this.redact(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(event).filter(([key]) =>
                [
                  'component',
                  'level',
                  'action',
                  'code',
                  'failureCode',
                  'status',
                  'runId',
                  'evaluationId',
                  'workKey',
                ].includes(key),
              ),
            ),
          ),
        ),
      )
      .join('\n')
  }

  launch(
    entry: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv = {},
    nodeOptions: readonly string[] = [],
  ): ChildProcess {
    const child = spawn(process.execPath, [...nodeOptions, entry, ...args], {
      cwd: repoRoot,
      // Parent may hold the real Router test credential. Child processes receive only their
      // explicit deployment configuration; coordination secret setup passes its value via stdin.
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
        ...environment,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.children.push(child)
    this.tails.set(child, '')
    for (const stream of [child.stdout, child.stderr]) {
      let partial = ''
      stream.on('data', (chunk: Buffer) => {
        this.tails.set(child, ((this.tails.get(child) ?? '') + chunk.toString()).slice(-80_000))
        partial += chunk.toString()
        const lines = partial.split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as Record<string, unknown>
            if (typeof value.component === 'string') this.events.push(value)
          } catch {
            // Operational diagnostics can contain unstructured lines; evidence never depends on them.
          }
        }
      })
    }
    return child
  }

  async cli(args: readonly string[], input?: string): Promise<string> {
    const child = this.launch(this.nodeEntry, args)
    if (input !== undefined) this.protect(input.trim())
    child.stdin!.end(input)
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
    const output = this.redact(this.tails.get(child) ?? '')
    assert.equal(exitCode, 0, `Node CLI failed: ${output}`)
    return output
  }

  request(path: string, body?: unknown, options: ApiOptions = {}): Promise<Response> {
    const actor = options.actor === undefined ? this.owner : options.actor
    const method = options.method ?? (body === undefined ? 'GET' : 'POST')
    return fetch(`${this.origin}/api/v1${path}`, {
      method,
      headers: {
        origin: this.origin,
        ...(actor?.cookie ? { cookie: actor.cookie } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': options.idempotencyKey ?? randomUUID() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
  }

  async api<T>(path: string, body?: unknown, options: ApiOptions = {}): Promise<T> {
    const response = await this.request(path, body, options)
    const envelope = (await response.json()) as { ok: boolean; data: T; error?: unknown }
    assert.ok(
      response.ok &&
        envelope.ok &&
        (options.expected === undefined || response.status === options.expected),
      this.redact(`${path}: ${response.status} ${JSON.stringify(envelope.error)}`),
    )
    return envelope.data
  }

  private async createActor(path: string, body: object): Promise<AcceptanceActor> {
    const response = await this.request(path, body, { actor: null })
    const payload = (await response.json()) as { data?: { userId: string }; error?: unknown }
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert(response.ok && payload.data && cookie, `${path} failed: ${response.status}`)
    this.protect(cookie)
    this.protect(cookie.split('=').slice(1).join('='))
    return { ...payload.data, cookie }
  }

  async inviteMember(username: string): Promise<AcceptanceActor> {
    const invite = await this.api<{ token: string }>('/invites', { role: 'member' })
    const password = randomBytes(24).toString('base64url')
    this.protect(invite.token)
    this.protect(password)
    return this.createActor('/invites/accept', {
      token: invite.token,
      username,
      displayName: username,
      password,
    })
  }

  async start(): Promise<void> {
    this.root = await mkdtemp(join(tmpdir(), 'whalepod-production-acceptance-'))
    this.protect(this.root)
    this.configDir = join(this.root, 'node-config')
    this.stateDir = join(this.root, 'node-state')
    this.workspaceDir = join(this.root, 'workspace')
    await mkdir(this.workspaceDir)
    const setupPath = join(this.root, 'setup-token')
    if (this.provider) this.providerOrigin = `http://127.0.0.1:${await listen(this.provider)}`
    const portProbe = createServer()
    const port = await listen(portProbe)
    await close(portProbe)
    this.origin = `http://127.0.0.1:${port}`
    this.postgres = await startEphemeralPostgres()
    this.protect(this.postgres.databaseUrl)
    this.database = createDatabase({ connectionString: this.postgres.databaseUrl })
    this.launch(
      resolveHubServerEntry(new URL('../../apps/hub/package.json', import.meta.url)),
      [],
      {
        DATABASE_URL: this.postgres.databaseUrl,
        WHALEPOD_PUBLIC_ORIGIN: this.origin,
        WHALEPOD_SETUP_TOKEN_PATH: setupPath,
        WHALEPOD_ARTIFACT_STORE_DIR: join(this.root, 'hub-artifacts'),
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'info',
      },
    )
    await until('Hub ready', async () => {
      try {
        return (await this.request('/setup/status', undefined, { actor: null })).ok
          ? true
          : undefined
      } catch {
        return undefined
      }
    })
    const setupToken = (await readFile(setupPath, 'utf8')).trim()
    const password = randomBytes(24).toString('base64url')
    this.protect(setupToken)
    this.protect(password)
    this.owner = await this.createActor('/setup', {
      setupToken,
      teamName: 'Production acceptance',
      username: 'acceptance-owner',
      displayName: 'Acceptance Owner',
      password,
    })
    const pairing = await this.api<{ code: string }>('/devices/pairing-codes', {})
    this.protect(pairing.code)
    await this.cli([
      'pair',
      '--hub',
      this.origin,
      '--code',
      pairing.code,
      '--config-dir',
      this.configDir,
    ])
    const identity = JSON.parse(await readFile(join(this.configDir, 'config.json'), 'utf8')) as {
      deviceId: string
      deviceToken: string
    }
    this.deviceId = identity.deviceId
    this.deviceToken = identity.deviceToken
    this.protect(identity.deviceToken)
  }

  startNode(deepSeekBaseUrl?: string): ChildProcess {
    if (deepSeekBaseUrl === undefined)
      return this.launch(this.nodeEntry, [
        'start',
        '--config-dir',
        this.configDir,
        '--state-dir',
        this.stateDir,
      ])
    // Import the packaged CLI composition. It allows only the built-in provider endpoint to
    // point at the disposable loopback fixture; all Node and Runtime production services remain.
    return this.launch(
      'whalepod-replay-assembly',
      [this.nodeEntry, this.stateDir, this.configDir, deepSeekBaseUrl],
      {},
      [
        '--input-type=module',
        '--eval',
        'import { pathToFileURL } from "node:url"; const { runStart } = await import(pathToFileURL(process.argv[2]).href); await runStart(undefined, process.argv[3], process.argv[4], { deepSeekBaseUrl: process.argv[5] })',
      ],
    )
  }

  async waitCoordinationInventory(): Promise<void> {
    await until('Node coordination inventory', async () => {
      const [device] = await this.database.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, this.deviceId))
      const capabilities = device?.capabilities as
        | {
            coordinationCapabilities?: string[]
            coordinationCredentialSlots?: unknown[]
          }
        | undefined
      return capabilities?.coordinationCapabilities?.includes('coordination.v1') &&
        capabilities.coordinationCredentialSlots?.length
        ? true
        : undefined
    })
  }

  async stop(): Promise<void> {
    if (this.provider) await close(this.provider)
    for (const child of this.children.slice().reverse()) await stop(child)
    await this.database?.close()
    await this.postgres?.stop()
    if (this.root) await rm(this.root, { recursive: true, force: true })
  }
}
