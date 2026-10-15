export interface AttentionVerdict {
  component: 'web.attention.verify'
  verdict: 'PASS' | 'FAIL'
  problems: string[]
}
const EXPECTED: Record<string, readonly [string, string]> = {
  accept_assignment: ['pending', 'accepted'],
  reassign_task: ['rejected', 'pending'],
  decide_approval: ['pending', 'allowed_once'],
  inspect_candidate: ['candidate', 'published'],
  complete_task: ['in_review', 'done'],
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
/** Only explicit facts pass. No missing, partial or mocked run can become green. */
export function verifyAttentionEvidence(input: unknown): AttentionVerdict {
  const data = record(input)
  const problems: string[] = []
  if (data['component'] !== 'web.attention' || data['source'] !== 'production-http-ws-node-runtime')
    problems.push('production source missing')
  for (const key of [
    'privateCandidateIdentityHidden',
    'observerHasNoApprovalAction',
    'recentTasksUpdatedWithoutReload',
  ]) {
    if (data[key] !== true) problems.push(`${key} missing or false`)
  }
  if (data['runtimeRunStatus'] !== 'completed') problems.push('runtime not completed')
  if (data['actionItemsAfterDone'] !== 0) problems.push('settled actions remain or missing')
  if (data['humanUsability'] !== 'not_measured')
    problems.push('machine evidence cannot establish human usability')
  const actions = Array.isArray(data['actions']) ? data['actions'] : []
  if (actions.length !== 5) problems.push('five actions required')
  const seen = new Set<string>()
  for (const value of actions) {
    const action = record(value)
    const kind = typeof action['kind'] === 'string' ? action['kind'] : ''
    const states = EXPECTED[kind]
    if (!Object.hasOwn(EXPECTED, kind) || !states || seen.has(kind)) {
      problems.push('unknown or duplicate action')
      continue
    }
    seen.add(kind)
    const taskId = action['taskId'],
      objectId = action['objectId']
    if (
      typeof taskId !== 'string' ||
      !uuid.test(taskId) ||
      typeof objectId !== 'string' ||
      !uuid.test(objectId)
    )
      problems.push(`${kind}: identities missing`)
    if (kind !== 'decide_approval' && kind !== 'inspect_candidate' && objectId !== taskId)
      problems.push(`${kind}: task identity mismatch`)
    const target =
      kind === 'decide_approval'
        ? `approval-${String(objectId)}`
        : kind === 'inspect_candidate'
          ? `artifact-${String(objectId)}`
          : kind === 'complete_task'
            ? 'task-actions'
            : 'task-assignment'
    if (action['targetId'] !== target || action['focusedTargetId'] !== target)
      problems.push(`${kind}: focus mismatch`)
    if (action['before'] !== states[0] || action['after'] !== states[1])
      problems.push(`${kind}: transition missing`)
    const before = action['commandsBeforeNavigation'],
      after = action['commandsAfterNavigation']
    if (
      typeof before !== 'number' ||
      !Number.isSafeInteger(before) ||
      before < 0 ||
      before !== after
    )
      problems.push(`${kind}: navigation issued command or counts missing`)
  }
  if (seen.size !== 5) problems.push('action coverage incomplete')
  return {
    component: 'web.attention.verify',
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
  }
}
