import { describe, expect, it } from 'vitest'
import { ArtifactDeliveryBasisSchema } from '../src/delivery-basis.js'

const ID = '00000000-0000-4000-8000-000000000001'
const empty = {
  artifactId: ID,
  taskId: ID,
  sourceRun: null,
  agreement: { status: 'unavailable', revision: null },
  taskInputs: { status: 'unknown', complete: false, artifacts: [] },
  handoffInputs: { status: 'not_selected', complete: true, artifacts: [] },
  handoffs: [],
}

describe('delivery basis protocol (#440)', () => {
  it('keeps unknown history separate from a confirmed empty input set', () => {
    expect(ArtifactDeliveryBasisSchema.parse(empty).taskInputs.status).toBe('unknown')
    const recorded = ArtifactDeliveryBasisSchema.parse({
      ...empty,
      taskInputs: { status: 'recorded', complete: true, artifacts: [] },
    })
    expect(recorded.taskInputs.status).toBe('recorded')
  })
  it('does not accept complete or populated unknown inputs', () => {
    expect(
      ArtifactDeliveryBasisSchema.safeParse({
        ...empty,
        taskInputs: { status: 'unknown', complete: true, artifacts: [] },
      }).success,
    ).toBe(false)
  })
  it('rejects accidental private source fields', () => {
    expect(
      ArtifactDeliveryBasisSchema.safeParse({ ...empty, sourceRelativePath: 'private.txt' })
        .success,
    ).toBe(false)
  })
})
