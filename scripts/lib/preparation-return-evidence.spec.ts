import { describe, expect, it } from 'vitest'
import { verifyPreparationReturnEvidence } from './preparation-return-evidence.js'
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
function valid(): Record<string, unknown> {
  const selection = { agentId: id, profileRevisionId: id, deviceId: id, workspaceId: id }
  return {
    component: 'web.preparation.return',
    source: 'production-http-ws-node-runtime',
    verifiedAt: '2026-10-15T12:00:00.000Z',
    taskId: id,
    acceptedRunId: other,
    selectionBefore: { ...selection },
    selectionAfter: { ...selection },
    submittedSelection: { ...selection },
    actualSelection: { ...selection },
    targetId: 'task-execution',
    focusedTargetId: 'task-execution',
    draftPreserved: true,
    modeBefore: 'new',
    modeAfter: 'new',
    submittedDraftMatches: true,
    preparationBefore: 'confirmed',
    preparationAfter: 'unconfirmed',
    instructionPostsBeforeNavigation: 0,
    instructionPostsAfterNavigation: 0,
    preparationPostsBeforeNavigation: 2,
    preparationPostsAfterNavigation: 2,
    explicitInstructionPosts: 1,
    runtimeRunStatus: 'completed',
    humanUsability: 'not_measured',
    provider: 'replay',
  }
}
describe('production preparation return evidence', () => {
  it('rejects missing evidence', () => {
    for (const value of [null, undefined, {}, [], { component: 'web.preparation.return' }])
      expect(verifyPreparationReturnEvidence(value).verdict).toBe('FAIL')
  })
  it('accepts complete observations', () => {
    expect(verifyPreparationReturnEvidence(valid())).toEqual({
      component: 'web.preparation.return.verify',
      verdict: 'PASS',
      problems: [],
    })
  })
  it('fails for every missing required field', () => {
    for (const key of Object.keys(valid())) {
      const data = valid()
      delete data[key]
      expect(verifyPreparationReturnEvidence(data).verdict, key).toBe('FAIL')
    }
  })
  it('rejects changed selections, incomplete fields and invalid identities', () => {
    for (const field of [
      'selectionBefore',
      'selectionAfter',
      'submittedSelection',
      'actualSelection',
    ]) {
      for (const key of ['agentId', 'profileRevisionId', 'deviceId', 'workspaceId']) {
        const changed = valid()
        changed[field] = { ...(changed[field] as object), [key]: other }
        expect(verifyPreparationReturnEvidence(changed).verdict).toBe('FAIL')
        const missing = valid()
        delete (missing[field] as Record<string, unknown>)[key]
        expect(verifyPreparationReturnEvidence(missing).verdict).toBe('FAIL')
        const invalid = valid()
        invalid[field] = { ...(invalid[field] as object), [key]: 'invalid' }
        expect(verifyPreparationReturnEvidence(invalid).verdict).toBe('FAIL')
      }
    }
    for (const key of ['taskId', 'acceptedRunId'])
      expect(verifyPreparationReturnEvidence({ ...valid(), [key]: 'not-uuid' }).verdict).toBe(
        'FAIL',
      )
  })
  it('rejects hidden commands, automatic probes, non-integer counters and duplicate sends', () => {
    for (const patch of [
      { instructionPostsAfterNavigation: 1 },
      { instructionPostsBeforeNavigation: -1 },
      { instructionPostsBeforeNavigation: NaN, instructionPostsAfterNavigation: NaN },
      { instructionPostsBeforeNavigation: 0.5, instructionPostsAfterNavigation: 0.5 },
      { preparationPostsBeforeNavigation: 0, preparationPostsAfterNavigation: 0 },
      { preparationPostsAfterNavigation: 3 },
      { explicitInstructionPosts: 0 },
      { explicitInstructionPosts: 2 },
    ])
      expect(verifyPreparationReturnEvidence({ ...valid(), ...patch }).verdict).toBe('FAIL')
  })
  it('rejects unfocused, changed draft/mode, reused checks, mock runtimes and human claims', () => {
    for (const patch of [
      { targetId: 'other' },
      { focusedTargetId: 'other' },
      { draftPreserved: false },
      { modeBefore: 'resume' },
      { modeAfter: 'followup' },
      { submittedDraftMatches: false },
      { preparationBefore: 'unconfirmed' },
      { preparationAfter: 'confirmed' },
      { runtimeRunStatus: 'failed' },
      { source: 'mock' },
      { provider: 'real' },
      { component: 'other' },
      { humanUsability: 'passed' },
      { verifiedAt: 'invalid' },
    ])
      expect(verifyPreparationReturnEvidence({ ...valid(), ...patch }).verdict).toBe('FAIL')
  })
})
