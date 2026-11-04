/** Crash recovery uses real owned process groups and the production journal/probes. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coordinationInputTokenEstimate, type CoordinationRequest } from '@whalepod/protocol'
import { CoordinationManager } from '../src/coordination/manager.js'
import { CoordinationStore } from '../src/coordination/store.js'
import { killProcessGroup, processAlive, processStartTime } from '../src/supervisor/process.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function crashedAttempt(
  state: 'active' | 'result' | 'acked',
  options: { unknownStart?: boolean; reusedPid?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'wp-coordination-recovery-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const entry = {
    id: randomUUID(),
    kind: 'source' as const,
    sourceId: randomUUID(),
    version: '1',
    digest: createHash('sha256').update('private').digest('hex'),
    byteSize: 7,
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
    principalUserId: randomUUID(),
    billingUserId: randomUUID(),
    provider: 'fixture',
    model: 'fixture',
    credentialSlot: 'coordination',
    credentialConfigRevision: '1',
    configVersion: 1,
    manifest: [entry],
    inputTokensEstimate: coordinationInputTokenEstimate([entry]),
    maxInputTokens: 100_000,
    maxOutputTokens: 1000,
    maxCostMicros: 1000,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const nonce = randomUUID()
  const home = join(dir, 'coordination-home', request.evaluationId, '1')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'private-copy'), 'private')
  // Real process markers match the broker launched by CoordinationRuntimeDriver.
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(()=>{},1000);process.stdout.write("ready\\n")',
      '--',
      '--coordination',
      '--evaluation-id',
      request.evaluationId,
      '--nonce',
      nonce,
    ],
    {
      cwd: home,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  cleanup.push(async () => {
    if (child.pid !== undefined) await killProcessGroup(child.pid, 'SIGKILL')
    await exited
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout?.once('data', () => resolve())
    child.once('exit', () => reject(new Error('fixture child exited before ready')))
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('fixture process has no pid')
  const start = await processStartTime(pid)
  expect(start).toBeDefined()
  const store = new CoordinationStore(join(dir, 'coordination.sqlite'))
  store.begin({
    evaluationId: request.evaluationId,
    attempt: 1,
    leaseToken: request.leaseToken,
    nonce,
    requestJson: JSON.stringify(request),
    homePath: home,
  })
  store.setProcess(
    request.evaluationId,
    1,
    pid,
    options.reusedPid ? 'a different prior process start' : start!,
  )
  const terminal = JSON.stringify({
    evaluationId: request.evaluationId,
    attempt: 1,
    leaseToken: request.leaseToken,
    evaluationDigest: request.evaluationDigest,
    status: 'failed',
    failureCode: 'timeout',
    readEntryIds: [],
  })
  if (state !== 'active') store.saveResult(request.evaluationId, 1, terminal)
  if (state === 'acked') store.ackResult(request.evaluationId, 1, request.leaseToken)
  let spawns = 0
  const manager = new CoordinationManager({
    stateDir: dir,
    hubUrl: 'http://hub.test',
    deviceToken: 'fixture',
    runtimeEntry: 'unused-on-recovery',
    capable: false,
    store,
    send: () => true,
    readProcessStartTime: options.unknownStart ? async () => undefined : processStartTime,
    driver: {
      async spawn() {
        spawns++
        throw new Error('recovery must not replay a model')
      },
      async terminate() {
        throw new Error('recovery must probe the recorded process')
      },
    },
    removeHome: async (path) => {
      // For confirmed PID reuse the live process is unrelated; otherwise deletion requires exit.
      if (!options.reusedPid) expect(await processAlive(pid)).toBe(false)
      await rm(path, { recursive: true, force: true })
    },
  })
  cleanup.push(async () => {
    await manager.stop()
    store.close()
  })
  return { manager, store, home, pid, terminal, request, spawns: () => spawns }
}

describe('coordination recovery after terminal result persistence', () => {
  it.each(['active', 'result', 'acked'] as const)(
    'stops the owned %s orphan before removing inputs and preserves terminal records',
    async (state) => {
      const h = await crashedAttempt(state)
      await h.manager.recover()
      expect(await processAlive(h.pid)).toBe(false)
      expect(existsSync(h.home)).toBe(false)
      expect(h.store.cleanupTasks()).toHaveLength(0)
      const row = h.store.get(h.request.evaluationId, 1)
      if (state === 'active') expect(row?.resultJson).toContain('node_lost')
      else {
        expect(row?.state).toBe(state)
        expect(row?.resultJson).toBe(state === 'acked' ? null : h.terminal)
      }
      expect(h.spawns()).toBe(0)
    },
  )

  it('does not signal a reused PID and may clean the old input home', async () => {
    const h = await crashedAttempt('result', { reusedPid: true })
    await h.manager.recover()
    expect(await processAlive(h.pid)).toBe(true)
    expect(existsSync(h.home)).toBe(false)
    expect(h.store.get(h.request.evaluationId, 1)?.resultJson).toBe(h.terminal)
  })

  it('keeps cleanup pending when the live process identity cannot be confirmed', async () => {
    const h = await crashedAttempt('acked', { unknownStart: true })
    await h.manager.recover()
    expect(await processAlive(h.pid)).toBe(true)
    expect(existsSync(h.home)).toBe(true)
    expect(h.store.cleanupTasks()).toHaveLength(1)
    expect(h.store.get(h.request.evaluationId, 1)?.state).toBe('acked')
  })

  it('does not treat EPERM from kill(0) as proof that the broker exited', async () => {
    const h = await crashedAttempt('result')
    const kill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === h.pid && signal === 0)
        throw Object.assign(new Error('not visible'), { code: 'EPERM' })
      return kill(pid, signal)
    })
    try {
      await h.manager.recover()
      expect(existsSync(h.home)).toBe(true)
      expect(h.store.cleanupTasks()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
    expect(await processAlive(h.pid)).toBe(true)
    expect(h.store.get(h.request.evaluationId, 1)?.resultJson).toBe(h.terminal)
  })
})
