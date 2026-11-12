import { createHash, randomUUID } from 'node:crypto'
import type { Database, Tx } from '@whalepod/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerArtifactRoutes } from '../src/modules/artifact/routes.js'
import type { ArtifactStore } from '../src/modules/artifact/store.js'
import type { RequireActor } from '../src/modules/auth/session.js'
import type { DiscoveryLivePolicy } from '../src/modules/discovery/replay-binding.js'
import { registerWorkRoutes } from '../src/modules/work/routes.js'

const stubs = vi.hoisted(() => ({
  authenticateDevice: vi.fn(),
  getRun: vi.fn(),
  insertArtifact: vi.fn(),
  listAttempts: vi.fn(),
  materialize: vi.fn(),
  saveUpload: vi.fn(),
  verify: vi.fn(),
}))

vi.mock('@whalepod/db', async (original) => ({
  ...(await original<typeof import('@whalepod/db')>()),
  getOrdinaryRun: stubs.getRun,
  getRun: stubs.getRun,
  insertArtifact: stubs.insertArtifact,
  listDiscoveryExecutorAttempts: stubs.listAttempts,
  transactCommand: <T>(database: Database, _key: string, execute: (tx: Tx) => Promise<T>) =>
    database.transaction(execute),
}))
vi.mock('../src/modules/plugin/pack-resolver.js', async (original) => ({
  ...(await original<typeof import('../src/modules/plugin/pack-resolver.js')>()),
  authenticateDevice: stubs.authenticateDevice,
}))
vi.mock('../src/modules/discovery/replay-binding.js', async (original) => ({
  ...(await original<typeof import('../src/modules/discovery/replay-binding.js')>()),
  discoveryReplayBundle: stubs.materialize,
  verifyDiscoveryReplayRun: stubs.verify,
}))

const route: DiscoveryLivePolicy = {
  route: {
    provider: 'command-code',
    model: 'deepseek/deepseek-v4.1-flash',
    endpoint: 'https://example.invalid/model',
    account: 'test',
    policyGeneration: 1,
  },
  maxInputTokens: 128,
  maxOutputTokens: 16,
  inputPriceMicrosPerMillion: 1,
  outputPriceMicrosPerMillion: 1,
}

describe('RD-04c3 HTTP authority fences', () => {
  let app: FastifyInstance
  let online: boolean
  const runId = randomUUID()
  const deviceId = randomUUID()
  const root = `/node/runs/${runId}`
  const bytes = Buffer.from('private draft')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const query = new URLSearchParams({
    title: 'Private draft',
    mediaType: 'text/markdown',
    byteSize: String(bytes.length),
    sha256,
    sourceRelativePath: `.whalepod/drafts/${runId}.md`,
  })

  beforeEach(() => {
    vi.resetAllMocks()
    online = true
    app = Fastify()
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Tx
    const database = {
      transaction: <T>(execute: (tx: Tx) => Promise<T>) => execute(tx),
    } as unknown as Database
    const store = { saveUpload: stubs.saveUpload } as unknown as ArtifactStore
    const requireActor: RequireActor = async () => {
      throw new Error('device routes must not require a user session')
    }
    stubs.authenticateDevice.mockResolvedValue({ deviceId })
    stubs.getRun.mockResolvedValue({
      id: runId,
      deviceId,
      discoveryExecutionId: randomUUID(),
      mandateInvalidatedAt: null,
      status: 'running',
    })
    stubs.verify.mockResolvedValue({ ok: true })
    stubs.listAttempts.mockResolvedValue([{ state: 'actual', overage: false, outputTokens: 4 }])
    const deps = {
      database,
      requireActor,
      discoveryExecutionReplay: route,
      discoveryDeviceOnline: () => online,
    }
    registerWorkRoutes(app, { ...deps, discoveryStore: store })
    registerArtifactRoutes(app, { ...deps, store })
  })

  afterEach(async () => app.close())

  function upload() {
    return app.inject({
      method: 'POST',
      url: `${root}/artifacts?${query}`,
      headers: { 'content-type': 'application/octet-stream', 'idempotency-key': randomUUID() },
      payload: bytes,
    })
  }

  it('withholds work-input authorization if the device drops during the authority check', async () => {
    stubs.verify.mockImplementationOnce(async () => {
      online = false
      return { ok: true }
    })
    expect((await app.inject(`${root}/work-input/authorize`)).statusCode).toBe(404)
  })

  it('does not disclose a materialized bundle when the device drops during the read', async () => {
    stubs.materialize.mockImplementationOnce(async () => {
      online = false
      return { entries: [{ bodyBase64: 'private-marker' }] }
    })
    const response = await app.inject(`${root}/work-input/bundle`)
    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('private-marker')
  })

  it('does not register a candidate if the device drops during content storage', async () => {
    stubs.saveUpload.mockImplementationOnce(async () => {
      online = false
      return { byteSize: bytes.length, sha256, storageKey: 'test' }
    })
    expect((await upload()).statusCode).toBe(404)
    expect(stubs.saveUpload).toHaveBeenCalledOnce()
    expect(stubs.insertArtifact).not.toHaveBeenCalled()
  })

  it('does not accept a candidate based on an actual zero-output attempt', async () => {
    stubs.listAttempts.mockResolvedValueOnce([{ state: 'actual', overage: false, outputTokens: 0 }])
    expect((await upload()).statusCode).toBe(404)
    expect(stubs.saveUpload).not.toHaveBeenCalled()
    expect(stubs.insertArtifact).not.toHaveBeenCalled()
  })
})
