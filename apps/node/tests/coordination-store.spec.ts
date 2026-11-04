import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CoordinationStore } from '../src/coordination/store.js'

const roots: string[] = []
async function database() {
  const root = await mkdtemp(join(tmpdir(), 'wp-coordination-store-'))
  roots.push(root)
  return join(root, 'coordination.sqlite')
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const record = () => ({
  evaluationId: randomUUID(),
  attempt: 1,
  leaseToken: randomUUID(),
  nonce: randomUUID(),
  requestJson: '{}',
  homePath: 'managed-home',
})

describe('CoordinationStore persistent evaluation journal', () => {
  it('deduplicates the same lease and refuses replacement of an existing attempt', async () => {
    const store = new CoordinationStore(await database())
    const input = record()
    expect(store.begin(input)).toBe(true)
    expect(store.begin(input)).toBe(false)
    expect(() => store.begin({ ...input, leaseToken: randomUUID() })).toThrow('lease')
    expect(store.active()).toHaveLength(1)
    store.close()
  })
  it('retains process identity and first model-start/read facts across reopen', async () => {
    const path = await database()
    const input = record()
    const first = new CoordinationStore(path)
    first.begin(input)
    first.setProcess(input.evaluationId, 1, 4321, 'start')
    first.markHeartbeat(input.evaluationId, 1, ['entry-1'], '2026-11-04T00:00:00Z')
    first.markHeartbeat(input.evaluationId, 1, ['entry-2'], '2026-11-04T00:01:00Z')
    first.close()
    const second = new CoordinationStore(path)
    expect(second.get(input.evaluationId, 1)).toMatchObject({
      pid: 4321,
      processStartTime: 'start',
      modelStartedAt: '2026-11-04T00:00:00Z',
      readEntryIds: ['entry-1', 'entry-2'],
    })
    second.close()
  })
  it('keeps a terminal result until its exact lease acknowledgement and never reopens it', async () => {
    const path = await database()
    const input = record()
    const store = new CoordinationStore(path)
    store.begin(input)
    store.saveResult(input.evaluationId, 1, '{"status":"failed"}')
    expect(store.active()).toHaveLength(0)
    expect(store.pendingResults()).toHaveLength(1)
    expect(store.ackResult(input.evaluationId, 1, 'wrong')).toBe(false)
    expect(store.pendingResults()).toHaveLength(1)
    expect(store.ackResult(input.evaluationId, 1, input.leaseToken)).toBe(true)
    expect(store.pendingResults()).toHaveLength(0)
    expect(store.begin(input)).toBe(false)
    expect(store.get(input.evaluationId, 1)?.state).toBe('acked')
    store.close()
  })
  it('persists cleanup pending separately from result acknowledgement', async () => {
    const path = await database()
    const input = record()
    const store = new CoordinationStore(path)
    store.begin(input)
    store.saveResult(input.evaluationId, 1, '{}')
    store.ackResult(input.evaluationId, 1, input.leaseToken)
    expect(store.cleanupTasks()).toHaveLength(1)
    store.close()
    const reopened = new CoordinationStore(path)
    expect(reopened.cleanupTasks()).toHaveLength(1)
    reopened.markCleaned(input.evaluationId, 1)
    expect(reopened.cleanupTasks()).toHaveLength(0)
    reopened.close()
  })
})
