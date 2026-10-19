export interface R8WindowFacts {
  fault: { held: boolean; offline: boolean; faultId: string | null; liveSockets: number }
  expectedFaultId: string
  runStatus: string
  startCommands: Array<{ acked: boolean; attempts: number }>
}

/** 独立判定崩溃前是否命中 R8；未命中窗口不能充当恢复成功证据。 */
export function r8WindowFailures(facts: R8WindowFacts): string[] {
  const failures: string[] = []
  if (!facts.fault.held || !facts.fault.offline || facts.fault.faultId !== facts.expectedFaultId)
    failures.push('node.gateway: expected disconnect must still be held')
  if (facts.fault.liveSockets !== 0) failures.push('node.gateway: live connection remains')
  if (!['queued', 'dispatching'].includes(facts.runStatus))
    failures.push('hub.outbox: run already left dispatch window')
  if (facts.startCommands.length !== 1)
    failures.push('hub.outbox: exactly one run.start is required')
  else {
    if (facts.startCommands[0]!.acked !== false)
      failures.push('hub.outbox: run.start already acknowledged')
    if (facts.startCommands[0]!.attempts < 1)
      failures.push('hub.outbox: no failed dispatch attempt observed')
  }
  return failures
}
