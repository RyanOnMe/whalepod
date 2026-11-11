import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedDraftStartSchema, parseNodeFrame, type NodeUpstream } from '@whalepod/protocol'
import { canonicalJson } from '@whalepod/protocol/plugin-pack-digest'
import { expect, it, vi } from 'vitest'
import { nodeConnections } from '../src/modules/device/connection-registry.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  waitForValue,
} from './helpers.js'

const nodeBin = createRequire(new URL('../../node/package.json', import.meta.url)).resolve(
  '@whalepod/node/bin',
)

it('the packaged managed Node proves its deployment to the real Hub and ACKs only a safe manifest', async () => {
  const database = await createTestDatabase()
  const home = await mkdtemp(join(tmpdir(), 'wp-managed-node-bin-'))
  const children: ChildProcess[] = []
  const attached = vi.spyOn(nodeConnections, 'attach')
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined
  try {
    await resetDatabase(database)
    app = await createTestApp(database)
    const owner = await driveSetup(app)
    const code = await apiInject(app, owner, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    expect(code.statusCode).toBe(201)
    const claimed = await app.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: code.json().data.code as string,
        name: 'managed-control-node',
        platform: process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        nodeVersion: process.version,
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claimed.statusCode).toBe(201)
    const { deviceId, deviceToken } = claimed.json().data as {
      deviceId: string
      deviceToken: string
    }
    const managedHostToken = randomBytes(32).toString('hex')
    const placement = {
      deviceId,
      ownerUserId: owner.userId,
      workspaceId: randomUUID(),
      profileRevisionId: randomUUID(),
      managedHostGeneration: 1,
    }
    const host = {
      ...placement,
      proofSha256: createHash('sha256').update(managedHostToken).digest('hex'),
    }
    await app.close()
    app = undefined
    app = await createTestApp(database, { managedDraftHost: host })
    const hubUrl = await app.app.listen({ host: '127.0.0.1', port: 0 })
    async function launch(filename: string, proof: string): Promise<ChildProcess> {
      const path = join(home, filename)
      await writeFile(
        path,
        JSON.stringify({ hubUrl, ...placement, deviceToken, managedHostToken: proof }),
        { mode: 0o600 },
      )
      const child = spawn(process.execPath, [nodeBin, 'start', '--managed-draft-config', path], {
        env: { ...process.env, HOME: home },
        stdio: 'ignore',
      })
      children.push(child)
      return child
    }

    const unverified = await launch('bad-proof.json', randomBytes(32).toString('hex'))
    const [unverifiedExit] = await once(unverified, 'close')
    expect(unverifiedExit).toBe(1)
    expect(nodeConnections.isManagedDraftOnline(host)).toBe(false)
    expect(attached).not.toHaveBeenCalled()

    const child = await launch('managed-host.json', managedHostToken)
    const socket = await waitForValue(
      async () =>
        nodeConnections.isManagedDraftOnline(host)
          ? attached.mock.calls.find(([connection]) => connection.deviceId === deviceId)?.[0].socket
          : undefined,
      'verified managed Node socket',
      { timeoutMs: 6000 },
    )
    expect(nodeConnections.isOnline(deviceId)).toBe(false)

    // Socket transport check only; the frozen-source HTTP admission is tested separately.
    const manifest = {
      kind: 'managed_draft_source.v1',
      instruction: 'draft_registered_agreement.v1',
      runId: randomUUID(),
      projectId: randomUUID(),
      taskId: randomUUID(),
      workKey: randomUUID(),
      mandateId: randomUUID(),
      mandateVersion: 1,
      ...placement,
      source: {
        policyId: randomUUID(),
        revisionId: randomUUID(),
        sha256: 'a'.repeat(64),
        byteSize: 16,
      },
      modelBindingDigest: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const commandId = randomUUID()
    const command = ManagedDraftStartSchema.parse({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'managed_draft.start',
      payload: {
        commandId,
        manifest,
        manifestDigest: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
      },
    })
    const frames: NodeUpstream[] = []
    socket.on('message', (raw) => frames.push(parseNodeFrame(JSON.parse(String(raw)), 'upstream')))
    nodeConnections.send(deviceId, command)
    const ack = await waitForValue(
      async () =>
        frames.find(
          (frame) => frame.type === 'command.ack' && frame.payload.commandId === commandId,
        ),
      'managed metadata acknowledgement from packaged Node',
      { timeoutMs: 6000 },
    )
    expect(ack.payload).toEqual({ commandId, accepted: true })
    expect(child.exitCode).toBeNull()
    expect((await readdir(home)).sort()).toEqual(['bad-proof.json', 'managed-host.json'])
  } finally {
    attached.mockRestore()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await app?.close()
    await database.close()
    await rm(home, { recursive: true, force: true })
  }
}, 15_000)
