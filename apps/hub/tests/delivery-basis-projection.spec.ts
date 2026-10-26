/** Legacy/missing read facts are supplied at the repository seam, never written into runtime tables. */
import { asUserId } from '@whalepod/domain'
import { emptyHandoffNarrative } from '@whalepod/protocol'
import type { DbHandle } from '@whalepod/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getArtifactDeliveryBasis } from '../src/modules/review/delivery-basis.js'

const reads = vi.hoisted(() => ({
  artifact: vi.fn(),
  run: vi.fn(),
  revision: vi.fn(),
  handoffs: vi.fn(),
  readable: vi.fn(),
}))
vi.mock('@whalepod/db', () => ({
  getArtifact: reads.artifact,
  getRun: reads.run,
  getSpecRevision: reads.revision,
  listHandoffRevisionsByTask: reads.handoffs,
}))
vi.mock('../src/modules/review/review.js', () => ({ requireReadableArtifact: reads.readable }))
const ID = '00000000-0000-4000-8000-000000000001'
const TASK = '00000000-0000-4000-8000-000000000002'
const RUN = '00000000-0000-4000-8000-000000000003'
const INPUT = '00000000-0000-4000-8000-000000000004'
const HIDDEN = '00000000-0000-4000-8000-000000000005'
const REVISION = '00000000-0000-4000-8000-000000000006'
const actor = { userId: asUserId(ID), role: 'member' as const }
const handle = {} as DbHandle
const input = {
  artifactId: INPUT,
  runId: RUN,
  title: 'fixed title',
  mediaType: 'text/plain',
  byteSize: 8,
  sha256: 'a'.repeat(64),
  publishedAt: '2026-10-26T01:00:00.000Z',
}
const run = {
  id: RUN,
  taskId: TASK,
  createdAt: new Date('2026-10-26T01:00:00.000Z'),
  status: 'completed',
  specRevisionId: null as string | null,
  artifactInputManifest: null as unknown,
  handoffInput: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  reads.readable.mockResolvedValue({ id: ID, taskId: TASK, runId: RUN, sha256: 'b'.repeat(64) })
  reads.run.mockResolvedValue(run)
  reads.handoffs.mockResolvedValue([])
})

describe('delivery basis missing-history projection (#440)', () => {
  it('keeps historical NULL inputs unknown and never consults a current agreement', async () => {
    const view = await getArtifactDeliveryBasis(handle, actor, ID)
    expect(view.taskInputs).toEqual({ status: 'unknown', complete: false, artifacts: [] })
    expect(view.agreement).toEqual({ status: 'unbound', revision: null })
    expect(reads.revision).not.toHaveBeenCalled()
    expect(reads.artifact).not.toHaveBeenCalled()
  })
  it('filters currently unreadable material without replacing fixed metadata or hiding incompleteness', async () => {
    reads.run.mockResolvedValue({
      ...run,
      artifactInputManifest: { taskId: TASK, artifacts: [input, { ...input, artifactId: HIDDEN }] },
    })
    reads.artifact.mockImplementation(async (_db, id) => ({
      id,
      taskId: TASK,
      runId: RUN,
      title: id === INPUT ? 'renamed later' : 'owner private title',
      status: id === INPUT ? 'published' : 'candidate',
      sha256: input.sha256,
      byteSize: input.byteSize,
    }))
    const view = await getArtifactDeliveryBasis(handle, actor, ID)
    expect(view.taskInputs).toEqual({ status: 'recorded', complete: false, artifacts: [input] })
    expect(JSON.stringify(view)).not.toContain(HIDDEN)
    expect(JSON.stringify(view)).not.toContain('owner private title')
    expect(JSON.stringify(view)).not.toContain('renamed later')
  })
  it('removes private and cross-task published narrative references without exposing their identities', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000007'
    const narrative = emptyHandoffNarrative()
    narrative.evidence = [
      {
        text: '已公开但仍待核实的说明',
        verified: false,
        refs: [
          { kind: 'artifact', artifactId: INPUT },
          { kind: 'artifact', artifactId: HIDDEN },
          { kind: 'artifact', artifactId: OTHER },
          { kind: 'run', runId: HIDDEN },
        ],
      },
    ]
    reads.handoffs.mockResolvedValue([
      {
        id: REVISION,
        taskId: TASK,
        sourceRunId: RUN,
        revisionNumber: 1,
        publishedBy: ID,
        publishedAt: new Date('2026-10-26T01:00:00.000Z'),
        content: {
          system: {
            sourceRunId: RUN,
            artifacts: [{ artifactId: ID, sha256: 'b'.repeat(64), status: 'published' }],
          },
          narrative,
        },
      },
    ])
    reads.artifact.mockImplementation(async (_db, id) => ({
      id,
      taskId: id === OTHER ? OTHER : TASK,
      status: id === HIDDEN ? 'candidate' : 'published',
      title: 'private reference title',
    }))
    reads.run.mockImplementation(async (_db, id) => (id === RUN ? run : { ...run, taskId: OTHER }))
    const view = await getArtifactDeliveryBasis(handle, actor, ID)
    expect(view.handoffs[0]?.referencesComplete).toBe(false)
    expect(view.handoffs[0]?.narrative.evidence[0]?.refs).toEqual([
      { kind: 'artifact', artifactId: INPUT },
    ])
    expect(view.handoffs[0]?.narrative.evidence[0]?.verified).toBe(false)
    expect(JSON.stringify(view)).not.toContain(HIDDEN)
    expect(JSON.stringify(view)).not.toContain(OTHER)
    expect(JSON.stringify(view)).not.toContain('private reference title')
  })
  it('reports an unavailable bound revision and missing source instead of guessing from another task', async () => {
    reads.run.mockResolvedValue({ ...run, specRevisionId: REVISION })
    reads.revision.mockResolvedValue({ taskId: HIDDEN, status: 'confirmed', revisionNumber: 7 })
    const unavailable = await getArtifactDeliveryBasis(handle, actor, ID)
    expect(unavailable.agreement).toEqual({ status: 'unavailable', revision: null })
    expect(reads.revision).toHaveBeenCalledWith(handle, REVISION)
    reads.run.mockResolvedValue({ ...run, taskId: HIDDEN })
    const missing = await getArtifactDeliveryBasis(handle, actor, ID)
    expect(missing.sourceRun).toBeNull()
    expect(missing.taskInputs.status).toBe('unknown')
    expect(missing.handoffInputs.status).toBe('unknown')
  })
})
