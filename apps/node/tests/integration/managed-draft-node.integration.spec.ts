import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingHttpHeaders } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { parseNodeFrame, type NodeUpstream } from '@whalepod/protocol'
import { canonicalJson } from '@whalepod/protocol/plugin-pack-digest'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

const entry = createRequire(import.meta.url).resolve('@whalepod/node/bin')
const waitMs = 6000
const sha256 = 'a'.repeat(64)
const manifestHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')

const children: ChildProcess[] = []
const directories: string[] = []
const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = once(child, 'exit')
      child.kill('SIGKILL')
      await closed
    }),
  )
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }),
  )
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

interface Connection {
  socket: WebSocket
  headers: IncomingHttpHeaders
  frames: NodeUpstream[]
}

async function hubSocket() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws/v1/node' })
  servers.push(server)
  await once(server, 'listening')
  const connections: Connection[] = []
  server.on('connection', (socket, request) => {
    const connection: Connection = { socket, headers: request.headers, frames: [] }
    connections.push(connection)
    socket.on('message', (message) => {
      connection.frames.push(parseNodeFrame(JSON.parse(message.toString()), 'upstream'))
    })
  })
  return { hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections }
}

async function poll<T>(read: () => T | undefined, child: ChildProcess): Promise<T> {
  const end = Date.now() + waitMs
  while (Date.now() < end) {
    const value = read()
    if (value !== undefined) return value
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('packaged Node exited before the expected frame')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('packaged Node did not deliver the expected frame')
}

function launch(home: string, args: string[]) {
  const child = spawn(process.execPath, [entry, 'start', ...args], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.resume()
  children.push(child)
  return child
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'whalepod-managed-node-'))
  directories.push(directory)
  return directory
}

function provision(hubUrl: string) {
  return {
    hubUrl,
    deviceId: randomUUID(),
    deviceToken: randomBytes(32).toString('base64url'),
    managedHostToken: randomBytes(32).toString('hex'),
    ownerUserId: randomUUID(),
    workspaceId: randomUUID(),
    profileRevisionId: randomUUID(),
    managedHostGeneration: 2,
  }
}

function manifest(deployment: ReturnType<typeof provision>) {
  return {
    kind: 'managed_draft_source.v1',
    instruction: 'draft_registered_agreement.v1',
    runId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    workKey: randomUUID(),
    ownerUserId: deployment.ownerUserId,
    mandateId: randomUUID(),
    mandateVersion: 1,
    profileRevisionId: deployment.profileRevisionId,
    deviceId: deployment.deviceId,
    workspaceId: deployment.workspaceId,
    managedHostGeneration: deployment.managedHostGeneration,
    source: { policyId: randomUUID(), revisionId: randomUUID(), sha256, byteSize: 16 },
    modelBindingDigest: sha256,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function send(connection: Connection, type: string, payload: Record<string, unknown>) {
  connection.socket.send(
    JSON.stringify({
      protocolVersion: 1,
      type,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      payload,
    }),
  )
}

async function sendManaged(
  connection: Connection,
  child: ChildProcess,
  frozen: ReturnType<typeof manifest>,
  digest = manifestHash(frozen),
) {
  const commandId = randomUUID()
  send(connection, 'managed_draft.start', { commandId, manifest: frozen, manifestDigest: digest })
  return await poll(
    () =>
      connection.frames.find(
        (frame) => frame.type === 'command.ack' && frame.payload.commandId === commandId,
      ),
    child,
  )
}

describe('packaged Node managed draft lane', { timeout: 12_000 }, () => {
  it('only the separately provisioned lane acknowledges valid frozen metadata', async () => {
    const server = await hubSocket()
    const home = await tempDirectory()
    const config = join(home, 'managed-host.json')
    const deployment = provision(server.hubUrl)
    await writeFile(config, JSON.stringify(deployment), { mode: 0o600 })
    const child = launch(home, ['--managed-draft-config', config])
    const connection = await poll(() => server.connections[0], child)
    expect(connection.headers.authorization).toBe(`Device ${deployment.deviceToken}`)
    expect(connection.headers['x-whalepod-managed-host']).toBe(deployment.managedHostToken)
    const hello = await poll(
      () => connection.frames.find((frame) => frame.type === 'node.hello'),
      child,
    )
    expect(hello.payload).toMatchObject({
      deviceId: deployment.deviceId,
      dshDistributionVersion: 'managed-draft-control.v1',
      pluginPackDigests: [],
      contextCapabilities: [],
    })
    const frozen = manifest(deployment)
    expect(await sendManaged(connection, child, frozen)).toMatchObject({
      type: 'command.ack',
      payload: { accepted: true },
    })
    expect(await sendManaged(connection, child, frozen, 'b'.repeat(64))).toMatchObject({
      payload: { accepted: false, error: { code: 'VALIDATION_FAILED' } },
    })
    for (const drift of [
      { managedHostGeneration: deployment.managedHostGeneration + 1 },
      { workspaceId: randomUUID() },
      { ownerUserId: randomUUID() },
      { profileRevisionId: randomUUID() },
      { deviceId: randomUUID() },
    ]) {
      expect(await sendManaged(connection, child, { ...frozen, ...drift })).toMatchObject({
        payload: { accepted: false, error: { code: 'FORBIDDEN' } },
      })
    }
    expect(
      await sendManaged(connection, child, { ...frozen, expiresAt: new Date(0).toISOString() }),
    ).toMatchObject({
      payload: { accepted: false, error: { code: 'CONTEXT_UNAVAILABLE' } },
    })

    const malformedCommandId = randomUUID()
    send(connection, 'managed_draft.start', {
      commandId: malformedCommandId,
      manifest: { ...frozen, body: 'must never be present' },
      manifestDigest: manifestHash(frozen),
    })
    expect(await sendManaged(connection, child, frozen)).toMatchObject({
      payload: { accepted: true },
    })
    expect(
      connection.frames.some(
        (frame) => frame.type === 'command.ack' && frame.payload.commandId === malformedCommandId,
      ),
    ).toBe(false)

    const commandId = randomUUID()
    send(connection, 'run.start', {
      commandId,
      runId: randomUUID(),
      taskId: randomUUID(),
      ownerUserId: deployment.ownerUserId,
      workspaceId: deployment.workspaceId,
      agent: {
        id: randomUUID(),
        profileRevisionId: deployment.profileRevisionId,
        persona: 'ordinary persona',
        provider: 'fixture',
        model: 'fixture',
        credentialSlot: 'fixture',
      },
      expectedProfileDigest: sha256,
      expectedPluginPackDigest: sha256,
      prompt: 'ordinary untracked source',
    })
    const refused = await poll(
      () =>
        connection.frames.find(
          (frame) => frame.type === 'command.ack' && frame.payload.commandId === commandId,
        ),
      child,
    )
    expect(refused).toMatchObject({ payload: { accepted: false, error: { code: 'FORBIDDEN' } } })
    expect(
      connection.frames.every((frame) => {
        if (frame.type === 'node.heartbeat')
          return (
            frame.payload.activeRunIds.length === 0 &&
            Object.keys(frame.payload.lastEventSeqByRun).length === 0
          )
        return frame.type === 'command.ack' || frame.type === 'node.hello'
      }),
    ).toBe(true)
    expect(await readdir(home)).toEqual(['managed-host.json'])
  })

  it('ordinary startup sends no managed proof and rejects even a valid targeted manifest', async () => {
    const server = await hubSocket()
    const home = await tempDirectory()
    const configDir = join(home, 'regular-config')
    const stateDir = join(home, 'ordinary-state')
    const deployment = provision(server.hubUrl)
    await Promise.all([mkdir(configDir, { mode: 0o700 }), mkdir(stateDir, { mode: 0o700 })])
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({
        hubUrl: deployment.hubUrl,
        deviceId: deployment.deviceId,
        deviceToken: deployment.deviceToken,
        managedHostToken: deployment.managedHostToken,
      }),
      { mode: 0o600 },
    )
    const child = launch(home, ['--config-dir', configDir, '--state-dir', stateDir])
    const connection = await poll(() => server.connections[0], child)
    expect(connection.headers.authorization).toBe(`Device ${deployment.deviceToken}`)
    expect(connection.headers['x-whalepod-managed-host']).toBeUndefined()
    expect(await sendManaged(connection, child, manifest(deployment))).toMatchObject({
      payload: { accepted: false, error: { code: 'FORBIDDEN' } },
    })
  })

  it('refuses unsafe credentials and transport before opening a socket', async () => {
    const server = await hubSocket()
    const home = await tempDirectory()
    const body = JSON.stringify(provision(server.hubUrl))
    const publicFile = join(home, 'public-host.json')
    const privateFile = join(home, 'private-host.json')
    const linked = join(home, 'linked-host.json')
    const insecure = join(home, 'insecure-hub.json')
    await writeFile(publicFile, body, { mode: 0o644 })
    await chmod(publicFile, 0o644)
    await writeFile(privateFile, body, { mode: 0o600 })
    await symlink(privateFile, linked)
    await writeFile(insecure, JSON.stringify(provision('http://192.0.2.1:8080')), { mode: 0o600 })
    for (const config of [publicFile, linked, insecure]) {
      const child = launch(home, ['--managed-draft-config', config])
      const stderr: string[] = []
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
      const [code] = await once(child, 'close')
      expect(code).toBe(1)
      expect(stderr.join('')).toContain('managed_draft_provisioning_unavailable')
      expect(stderr.join('')).not.toContain(body)
    }
    expect(server.connections).toHaveLength(0)
  })

  it('does not start ordinary state when the two sets of startup options are mixed', async () => {
    const server = await hubSocket()
    const home = await tempDirectory()
    const config = join(home, 'managed-host.json')
    await writeFile(config, JSON.stringify(provision(server.hubUrl)), { mode: 0o600 })
    const child = launch(home, [
      '--managed-draft-config',
      config,
      '--state-dir',
      join(home, 'ordinary-state'),
    ])
    const stderr: string[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const [code] = await once(child, 'close')
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('managed_draft_start_options_invalid')
    expect(server.connections).toHaveLength(0)
    expect(await readdir(home)).toEqual(['managed-host.json'])
  })
})
