export interface R8WindowFacts {
  fault: { held: boolean; offline: boolean; faultId: string | null; liveSockets: number }
  expectedFaultId: string
  runStatus: string
  startCommands: Array<{ acked: boolean; attempts: number }>
}

/** 独立判定崩溃前是否命中 R8；未命中窗口不能充当恢复成功证据。 */
export function r8WindowFailures(facts: R8WindowFacts): string[] {
  const failures: string[] = []
  if (
    facts.fault.held !== true ||
    facts.fault.offline !== true ||
    typeof facts.expectedFaultId !== 'string' ||
    facts.expectedFaultId.length === 0 ||
    facts.fault.faultId !== facts.expectedFaultId
  )
    failures.push('node.gateway: expected disconnect must still be held')
  if (facts.fault.liveSockets !== 0) failures.push('node.gateway: live connection remains')
  if (!['queued', 'dispatching'].includes(facts.runStatus))
    failures.push('hub.outbox: run already left dispatch window')
  if (!Array.isArray(facts.startCommands) || facts.startCommands.length !== 1)
    failures.push('hub.outbox: exactly one run.start is required')
  else {
    if (facts.startCommands[0]!.acked !== false)
      failures.push('hub.outbox: run.start already acknowledged')
    if (
      !Number.isSafeInteger(facts.startCommands[0]!.attempts) ||
      facts.startCommands[0]!.attempts < 1
    )
      failures.push('hub.outbox: no failed dispatch attempt observed')
  }
  return failures
}

/** 对保存的窄投影独立重判；坏 JSON/缺环/字段类型错误必须失败。 */
export function r8EvidenceFailures(input: unknown): string[] {
  try {
    const evidence = input as {
      component: string
      scenario: string
      runId: string
      before: R8WindowFacts
      after: { startAttempts: number; startAcked: boolean; status: string }
    }
    const failures = r8WindowFailures(evidence.before)
    if (
      evidence.component !== 'hub.outbox' ||
      evidence.scenario !== 'R8' ||
      typeof evidence.runId !== 'string' ||
      !evidence.runId
    )
      failures.push('missing R8 identity')
    if (
      !Number.isSafeInteger(evidence.after.startAttempts) ||
      evidence.after.startAttempts < 2 ||
      evidence.after.startAttempts <= evidence.before.startCommands[0]!.attempts
    )
      failures.push('hub.outbox: no dispatch after restart')
    if (evidence.after.startAcked !== true || evidence.after.status !== 'completed')
      failures.push('R8 must finish acknowledged and completed')
    return failures
  } catch {
    return ['missing or invalid R8 evidence']
  }
}
