import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  coordinationInputTokenEstimate,
  type CoordinationRequest,
  type NodeDownstream,
  type RouterRuntimeInput,
  type RouterRuntimeOutput,
} from '@whalepod/protocol'
import { CoordinationManager } from '../src/coordination/manager.js'
import { CoordinationStore } from '../src/coordination/store.js'
import { coordinationSecrets, saveCoordinationConfig } from '../src/coordination/config.js'
import type { CoordinationHandle, CoordinationProcessDriver } from '../src/coordination/driver.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness(
  options: { capable?: boolean; failCleanup?: boolean; blockDownload?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'wp-coordination-manager-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const principal = randomUUID()
  const body = 'A new requirement'
  const entry = {
    id: randomUUID(),
    kind: 'source' as const,
    sourceId: randomUUID(),
    version: '1',
    digest: createHash('sha256').update(body).digest('hex'),
    byteSize: Buffer.byteLength(body),
    authorizationGeneration: 'internal',
  }
  const request: CoordinationRequest = {
    evaluationId: randomUUID(),
    attempt: 1,
    leaseToken: 'lease-'.repeat(8),
    evaluationDigest: 'a'.repeat(64),
    projectId: randomUUID(),
    workKey: randomUUID(),
    taskId: randomUUID(),
    principalUserId: principal,
    billingUserId: principal,
    provider: 'deepseek-official',
    model: 'model',
    credentialSlot: 'coordination',
    credentialConfigRevision: 'cfg1',
    configVersion: 1,
    manifest: [entry],
    inputTokensEstimate: coordinationInputTokenEstimate([entry]),
    maxInputTokens: 100_000,
    maxOutputTokens: 1024,
    maxCostMicros: 100_000,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }
  await saveCoordinationConfig(dir, {
    enabled: true,
    ownerUserId: principal,
    billingUserId: principal,
    provider: request.provider,
    model: request.model,
    credentialSlot: request.credentialSlot,
    configRevision: 'cfg1',
    endpoint: 'https://provider.test/chat/completions',
  })
  await coordinationSecrets(dir).set(request.provider, request.credentialSlot, 'coordination-only')
  const messages: Array<{ type: string; payload: Record<string, unknown> }> = []
  const local: RouterRuntimeInput[] = []
  let output: ((frame: RouterRuntimeOutput) => void) | undefined
  let connected = true
  let spawns = 0
  let fetches = 0
  let removeAttempts = 0
  let finishProcess: (() => void) | undefined
  const driver: CoordinationProcessDriver = {
    async spawn(input, onOutput, onExit) {
      expect(input.secret).toBe('coordination-only')
      spawns++
      output = onOutput
      let done = false
      const exitPromise = new Promise<void>((resolve) => {
        finishProcess = () => {
          if (done) return
          done = true
          onExit()
          resolve()
        }
      })
      return { pid: process.pid, exitPromise, send: (frame) => local.push(frame) }
    },
    async terminate(_handle: CoordinationHandle) {
      finishProcess?.()
    },
  }
  const store = new CoordinationStore(join(dir, 'coordination.sqlite'))
  const manager = new CoordinationManager({
    stateDir: dir,
    hubUrl: 'http://hub.test',
    deviceToken: 'device-local',
    runtimeEntry: 'unused-for-fake-driver',
    capable: options.capable ?? true,
    driver,
    store,
    readProcessStartTime: async () => 'fake-driver-start',
    send: (line) => {
      if (!connected) return false
      messages.push(JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      return true
    },
    fetchImpl: async (url, init) => {
      fetches++
      if (options.blockDownload) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error('download aborted'))
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      expect(String(url)).toContain(
        `/coordination/evaluations/${request.evaluationId}/inputs/${entry.id}`,
      )
      expect(new Headers(init?.headers).get('x-coordination-lease')).toBe(request.leaseToken)
      return new Response(
        JSON.stringify({
          ok: true,
          data: { ...entry, bodyBase64: Buffer.from(body).toString('base64') },
        }),
      )
    },
    removeHome: async (path) => {
      removeAttempts++
      if (options.failCleanup && removeAttempts === 1) throw new Error('busy')
      await rm(path, { recursive: true, force: true })
    },
  })
  cleanup.push(async () => {
    await manager.stop()
    store.close()
  })
  const frame = (type: string, payload: unknown) =>
    ({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type,
      payload,
    }) as NodeDownstream
  const identity = {
    evaluationId: request.evaluationId,
    attempt: request.attempt,
    leaseToken: request.leaseToken,
  }
  return {
    dir,
    request,
    entry,
    store,
    manager,
    messages,
    local,
    frame,
    identity,
    output: (value: RouterRuntimeOutput) => output?.(value),
    disconnect: () => {
      connected = false
    },
    reconnect: () => {
      connected = true
      manager.onReconnect()
    },
    spawns: () => spawns,
    fetches: () => fetches,
    removeAttempts: () => removeAttempts,
  }
}

describe('Node restricted evaluation lifecycle', () => {
  it('waits for preparation cancellation to journal a result and clean private copies on stop', async () => {
    const h = await harness({ blockDownload: true })
    const starting = h.manager.handleFrame(h.frame('coordination.request', h.request))
    await vi.waitFor(() => expect(h.fetches()).toBe(1))
    await h.manager.stop()
    await starting
    expect(h.spawns()).toBe(0)
    expect(h.store.active()).toHaveLength(0)
    expect(h.store.pendingResults()[0]?.resultJson).toContain('cancelled')
    expect(h.store.cleanupTasks()).toHaveLength(0)
    expect(existsSync(join(h.dir, 'coordination-home', h.request.evaluationId, '1'))).toBe(false)
  })
  it('deduplicates requests, journals reads before acknowledging model start and reliably replays results', async () => {
    const h = await harness()
    await h.manager.handleFrame(h.frame('coordination.request', h.request))
    await h.manager.handleFrame(h.frame('coordination.request', h.request))
    expect(h.spawns()).toBe(1)
    expect(h.local[0]?.type).toBe('coordination.initialize')
    h.disconnect()
    h.output({
      type: 'coordination.heartbeat',
      payload: {
        ...h.identity,
        readEntryIds: [h.entry.id],
        modelStartedAt: new Date().toISOString(),
      },
    })
    await vi.waitFor(() =>
      expect(h.store.get(h.request.evaluationId, 1)?.readEntryIds).toEqual([h.entry.id]),
    )
    expect(h.local.filter((f) => f.type === 'coordination.model_start_ack')).toHaveLength(0)
    h.reconnect()
    expect(h.local.filter((f) => f.type === 'coordination.model_start_ack')).toHaveLength(1)
    const heartbeat = h.messages.findLast((f) => f.type === 'coordination.heartbeat')
    expect(heartbeat?.payload['modelStartedAt']).toBeDefined()
    h.output({
      type: 'coordination.result',
      payload: {
        ...h.identity,
        evaluationDigest: h.request.evaluationDigest,
        status: 'completed',
        resultDigest: 'b'.repeat(64),
        proposal: {
          decision: 'ignore',
          reason: 'not_actionable',
          summary: 'No work is needed',
          citations: [h.entry.id],
          coverage: [{ inputId: h.entry.id, status: 'uncovered', evidenceIds: [] }],
        },
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          costMicros: 1,
          provider: h.request.provider,
          model: h.request.model,
        },
        readEntryIds: [h.entry.id],
      },
    })
    await vi.waitFor(() => expect(h.store.pendingResults()).toHaveLength(1))
    h.reconnect()
    expect(
      h.messages.filter((f) => f.type === 'coordination.result').length,
    ).toBeGreaterThanOrEqual(2)
    await h.manager.handleFrame(
      h.frame('coordination.result_ack', { ...h.identity, status: 'accepted' }),
    )
    expect(h.store.pendingResults()).toHaveLength(0)
    await h.manager.handleFrame(h.frame('coordination.request', h.request))
    expect(h.spawns()).toBe(1)
  })
  it('does not start a process or download input without isolation capability', async () => {
    const h = await harness({ capable: false })
    await h.manager.handleFrame(h.frame('coordination.request', h.request))
    expect(h.spawns()).toBe(0)
    expect(h.fetches()).toBe(0)
    expect(h.store.pendingResults()[0]?.resultJson).toContain('isolation_unavailable')
  })
  it('refuses a mismatching billing principal and a tampered token estimate before downloading', async () => {
    const h = await harness()
    await h.manager.handleFrame(
      h.frame('coordination.request', { ...h.request, billingUserId: randomUUID() }),
    )
    expect(h.spawns()).toBe(0)
    expect(h.fetches()).toBe(0)
    expect(h.store.pendingResults()[0]?.resultJson).toContain('credential_unavailable')
    const changed = {
      ...h.request,
      evaluationId: randomUUID(),
      inputTokensEstimate: h.request.inputTokensEstimate - 1,
    }
    await h.manager.handleFrame(h.frame('coordination.request', changed))
    expect(h.store.get(changed.evaluationId, 1)?.resultJson).toContain('input_too_large')
  })
  it('fails closed on a broker read receipt outside the fixed manifest', async () => {
    const h = await harness()
    await h.manager.handleFrame(h.frame('coordination.request', h.request))
    h.output({
      type: 'coordination.heartbeat',
      payload: { ...h.identity, readEntryIds: [randomUUID()] },
    })
    await vi.waitFor(() =>
      expect(h.store.pendingResults()[0]?.resultJson).toContain('runtime_protocol_failed'),
    )
  })
  it('persists failed cleanup and completes it on retry after the result is acknowledged', async () => {
    const h = await harness({ capable: false, failCleanup: true })
    await h.manager.handleFrame(h.frame('coordination.request', h.request))
    await h.manager.handleFrame(
      h.frame('coordination.result_ack', { ...h.identity, status: 'rejected' }),
    )
    expect(h.store.cleanupTasks()).toHaveLength(1)
    await h.manager.retryCleanup()
    expect(h.removeAttempts()).toBe(2)
    expect(h.store.cleanupTasks()).toHaveLength(0)
  })
  it('reconciles a crashed attempt as node_lost without replaying the model and cleans its private copies', async () => {
    const h = await harness()
    const home = join(h.dir, 'coordination-home', h.request.evaluationId, '1')
    h.store.begin({
      ...h.identity,
      nonce: randomUUID(),
      requestJson: JSON.stringify(h.request),
      homePath: home,
    })
    h.store.markHeartbeat(h.request.evaluationId, 1, [h.entry.id], new Date().toISOString())
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'private-copy'), 'private')
    await h.manager.recover()
    expect(h.spawns()).toBe(0)
    expect(h.store.pendingResults()[0]?.resultJson).toContain('node_lost')
    expect(
      h.messages.find((m) => m.type === 'coordination.heartbeat')?.payload['modelStartedAt'],
    ).toBeDefined()
    expect(existsSync(home)).toBe(false)
  })
})
