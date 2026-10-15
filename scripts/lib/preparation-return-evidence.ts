export interface PreparationReturnVerdict {
  component: 'web.preparation.return.verify'
  verdict: 'PASS' | 'FAIL'
  problems: string[]
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fields = ['agentId', 'profileRevisionId', 'deviceId', 'workspaceId'] as const
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function identity(value: unknown): boolean {
  return typeof value === 'string' && uuid.test(value)
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
/** Fail closed: navigation, preparation and an accepted production run must all be observed. */
export function verifyPreparationReturnEvidence(input: unknown): PreparationReturnVerdict {
  const data = record(input),
    problems: string[] = []
  const expected: Record<string, unknown> = {
    component: 'web.preparation.return',
    source: 'production-http-ws-node-runtime',
    targetId: 'task-execution',
    focusedTargetId: 'task-execution',
    draftPreserved: true,
    modeBefore: 'new',
    modeAfter: 'new',
    submittedDraftMatches: true,
    preparationBefore: 'confirmed',
    preparationAfter: 'unconfirmed',
    explicitInstructionPosts: 1,
    runtimeRunStatus: 'completed',
    humanUsability: 'not_measured',
    provider: 'replay',
  }
  for (const [key, value] of Object.entries(expected))
    if (!Object.hasOwn(data, key) || data[key] !== value) problems.push(`${key} missing or invalid`)
  for (const key of ['taskId', 'acceptedRunId'])
    if (!identity(data[key])) problems.push(`${key} identity missing`)
  if (typeof data['verifiedAt'] !== 'string' || !Number.isFinite(Date.parse(data['verifiedAt'])))
    problems.push('verification time missing')
  const before = record(data['selectionBefore'])
  for (const key of fields) {
    if (!identity(before[key])) problems.push(`selectionBefore ${key} missing`)
    for (const name of ['selectionAfter', 'submittedSelection']) {
      const selection = record(data[name])
      if (!identity(selection[key]) || selection[key] !== before[key])
        problems.push(`${name} ${key} mismatch`)
    }
  }
  for (const prefix of ['instruction', 'preparation']) {
    const beforeCount = data[`${prefix}PostsBeforeNavigation`],
      afterCount = data[`${prefix}PostsAfterNavigation`]
    if (
      !counter(beforeCount) ||
      !counter(afterCount) ||
      beforeCount !== afterCount ||
      (prefix === 'preparation' && beforeCount === 0) ||
      (prefix === 'instruction' && beforeCount !== 0)
    )
      problems.push(`${prefix} navigation counters missing or unsafe`)
  }
  return {
    component: 'web.preparation.return.verify',
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
  }
}
