import { describe, expect, it } from 'vitest'
import { verifyAttentionEvidence } from './attention-evidence.js'
const taskId = '11111111-1111-4111-8111-111111111111'
const pairs = [
  ['accept_assignment', 'pending', 'accepted', 'task-assignment'],
  ['reassign_task', 'rejected', 'pending', 'task-assignment'],
  ['decide_approval', 'pending', 'allowed_once', `approval-${taskId}`],
  ['inspect_candidate', 'candidate', 'published', `artifact-${taskId}`],
  ['complete_task', 'in_review', 'done', 'task-actions'],
]
function valid() {
  return {
    component: 'web.attention',
    source: 'production-http-ws-node-runtime',
    actions: pairs.map(([kind, before, after, targetId]) => ({
      kind,
      taskId,
      objectId: taskId,
      before,
      after,
      targetId,
      focusedTargetId: targetId,
      commandsBeforeNavigation: 0,
      commandsAfterNavigation: 0,
    })),
    privateCandidateIdentityHidden: true,
    observerHasNoApprovalAction: true,
    recentTasksUpdatedWithoutReload: true,
    runtimeRunStatus: 'completed',
    actionItemsAfterDone: 0,
    humanUsability: 'not_measured',
  }
}
describe('personal attention evidence fails closed', () => {
  it('rejects absent facts', () => {
    for (const missing of [undefined, null, {}, { actions: [] }]) {
      expect(verifyAttentionEvidence(missing).verdict).toBe('FAIL')
    }
  })
  it('accepts all five observed actions', () => {
    expect(verifyAttentionEvidence(valid())).toEqual({
      component: 'web.attention.verify',
      verdict: 'PASS',
      problems: [],
    })
  })
  it('rejects missing or duplicate actions, wrong focus, state and navigation side effects', () => {
    const missing = valid()
    missing.actions.pop()
    const duplicate = valid()
    duplicate.actions[1] = duplicate.actions[0]!
    const focus = valid()
    focus.actions[0]!.focusedTargetId = 'wrong'
    const state = valid()
    state.actions[0]!.after = 'pending'
    const command = valid()
    command.actions[0]!.commandsAfterNavigation = 1
    const identity = valid()
    identity.actions[0]!.taskId = 'invalid'
    for (const bad of [missing, duplicate, focus, state, command, identity]) {
      expect(verifyAttentionEvidence(bad).verdict).toBe('FAIL')
    }
  })
  it('rejects inherited object properties as action kinds', () => {
    const data = valid()
    data.actions = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'].map(
      (kind) => ({
        kind,
        taskId,
        objectId: taskId,
        before: undefined,
        after: undefined,
        targetId: 'task-assignment',
        focusedTargetId: 'task-assignment',
        commandsBeforeNavigation: 0,
        commandsAfterNavigation: 0,
      }),
    )
    expect(verifyAttentionEvidence(data).verdict).toBe('FAIL')
  })
  it('rejects incomplete privacy, runtime, freshness or final-state evidence', () => {
    const checks = [
      { privateCandidateIdentityHidden: false },
      { observerHasNoApprovalAction: false },
      { recentTasksUpdatedWithoutReload: false },
      { runtimeRunStatus: 'failed' },
      { actionItemsAfterDone: 1 },
      { source: 'mock' },
      { humanUsability: 'passed' },
    ]
    for (const bad of checks)
      expect(verifyAttentionEvidence({ ...valid(), ...bad }).verdict).toBe('FAIL')
  })
})
