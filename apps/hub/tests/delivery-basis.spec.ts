import { describe, expect, it } from 'vitest'
import { matchesDeliveryArtifact } from '../src/modules/review/delivery-basis.js'

const artifact = { id: 'artifact-a', taskId: 'task-a', runId: 'run-a', sha256: 'a'.repeat(64) }
function handoff() {
  return { taskId: 'task-a', sourceRunId: 'run-a', content: {
    system: { sourceRunId: 'run-a', artifacts: [{ artifactId: 'artifact-a', sha256: 'a'.repeat(64), status: 'published' }] },
  } }
}

describe('delivery basis matching (#440)', () => {
  it('requires the exact published identity and both authoritative source identities', () => {
    expect(matchesDeliveryArtifact(artifact, handoff())).toBe(true)
    const row = handoff()
    row.content.system.artifacts[0]!.sha256 = 'b'.repeat(64)
    expect(matchesDeliveryArtifact(artifact, row)).toBe(false)
  })
  it('does not attach another run, task, private candidate or unrelated artifact', () => {
    const source = handoff()
    expect(matchesDeliveryArtifact(artifact, { ...source, sourceRunId: 'other' })).toBe(false)
    expect(matchesDeliveryArtifact(artifact, { ...source, taskId: 'other' })).toBe(false)
    source.content.system.sourceRunId = 'other'
    expect(matchesDeliveryArtifact(artifact, source)).toBe(false)
    source.content.system.sourceRunId = 'run-a'
    source.content.system.artifacts[0]!.status = 'candidate'
    expect(matchesDeliveryArtifact(artifact, source)).toBe(false)
    source.content.system.artifacts[0]!.status = 'published'
    source.content.system.artifacts[0]!.artifactId = 'other'
    expect(matchesDeliveryArtifact(artifact, source)).toBe(false)
  })
})
