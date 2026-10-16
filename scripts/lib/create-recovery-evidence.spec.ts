/**
 * 创建到恢复证据判定器的自证（#345）。
 *
 * 判定器若只会说 PASS，它就是装饰。这里用**正控 + 逐条负控**证明它有牙：
 * 每一类「缺证据 / 说了谎 / 静默改投」都必须判 FAIL，且失败原因指名道姓。
 */
import { describe, expect, it } from 'vitest'
import { verifyCreateRecoveryEvidence } from './create-recovery-evidence.js'

/** 一份完整、自洽的证据（正控）。各负控从这里改一处。 */
function goodEvidence(): Record<string, unknown> {
  return {
    component: 'web.create-recovery',
    source: 'production-http-ws-node-runtime',
    paths: {
      createOnly: {
        taskId: 't1',
        assigneeUserId: 'bob',
        assignmentStatus: 'pending',
        runs: 0,
        executionToastCount: 0,
        doubleClickPosts: 1,
      },
      retryIdempotent: {
        attempts: 2,
        sameKey: true,
        firstAttemptReachedHub: true,
        replayedSameTask: true,
        tasksCreated: 1,
        taskId: 't2',
      },
      stateChangeNoReroute: {
        blockedWhileStale: true,
        requestsWhileStale: 0,
        tasksCreatedWhileStale: 0,
        recoveredWithAssigneeUserId: 'alice',
        recoveredAssigneeUserId: 'alice',
      },
      failedThenRecover: {
        taskId: 't3',
        driveCode: 'DEVICE_OFFLINE',
        driveOutcome: 'failed',
        runsAfterFailure: 0,
        recoveredInSameTask: true,
        recoveredRunId: 'r1',
        recoveredRunOwnerUserId: 'alice',
        expectedRunOwnerUserId: 'alice',
        recoveredRunDeviceId: 'd1',
        expectedRunDeviceId: 'd1',
      },
      selfAgentExecute: {
        taskId: 't4',
        driveOutcome: 'started_run',
        runId: 'r2',
        runOwnerUserId: 'alice',
        expectedRunOwnerUserId: 'alice',
        runDeviceId: 'd1',
        expectedRunDeviceId: 'd1',
        taskAssignmentStatus: 'accepted',
        tasksCreated: 1,
      },
      assignToOther: {
        taskId: 't1',
        acceptedByUserId: 'bob',
        expectedAssigneeUserId: 'bob',
        assignmentStatus: 'accepted',
        runId: 'r3',
        runOwnerUserId: 'bob',
        expectedRunOwnerUserId: 'bob',
        runDeviceId: 'd2',
        deviceBelongsToOwner: true,
        otherUserHasDevice: false,
        workspaceBelongsToOwner: true,
        otherUserHasWorkspace: false,
        tasksCreated: 0,
      },
    },
  }
}

function mutate(change: (evidence: Record<string, unknown>) => void): unknown {
  const evidence = goodEvidence()
  change(evidence)
  return evidence
}

describe('#345 创建到恢复证据判定器', () => {
  it('正控：五条路径齐、事实自洽 → PASS（且判据条数不为零）', () => {
    const verdict = verifyCreateRecoveryEvidence(goodEvidence())
    expect(verdict.verdict).toBe('PASS')
    expect(verdict.failures).toEqual([])
    expect(verdict.checks).toBeGreaterThanOrEqual(20)
  })

  it('负控：空文件 / 坏 JSON（undefined）/ 拿错证据包 → FAIL', () => {
    expect(verifyCreateRecoveryEvidence(undefined).verdict).toBe('FAIL')
    expect(verifyCreateRecoveryEvidence([]).verdict).toBe('FAIL')
    expect(verifyCreateRecoveryEvidence({ component: 'web.run-micro' }).verdict).toBe('FAIL')
    expect(
      verifyCreateRecoveryEvidence({ component: 'web.create-recovery', source: 'unit-test' })
        .verdict,
    ).toBe('FAIL')
  })

  it('负控：少一条路径 → FAIL 且指名那条路径', () => {
    const verdict = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        const paths = evidence['paths'] as Record<string, unknown>
        delete paths['assignToOther']
      }),
    )
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.failures.join('\n')).toContain('paths.assignToOther')
  })

  it('负控：只创建却留下 Run、或弹了执行 toast → FAIL', () => {
    const withRun = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['createOnly']!['runs'] = 1
      }),
    )
    expect(withRun.verdict).toBe('FAIL')
    expect(withRun.failures.join('\n')).toContain('没有执行就不该有 Run')
    const withToast = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['createOnly']![
          'executionToastCount'
        ] = 1
      }),
    )
    expect(withToast.verdict).toBe('FAIL')
    expect(withToast.failures.join('\n')).toContain('弹了执行 toast')
  })

  it('负控：连点发出两次创建 / 重试换键 / 重试建出两个任务 → FAIL', () => {
    const twice = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['createOnly']![
          'doubleClickPosts'
        ] = 2
      }),
    )
    expect(twice.verdict).toBe('FAIL')
    const newKey = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['retryIdempotent']![
          'sameKey'
        ] = false
      }),
    )
    expect(newKey.verdict).toBe('FAIL')
    const duplicated = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['retryIdempotent']![
          'tasksCreated'
        ] = 2
      }),
    )
    expect(duplicated.verdict).toBe('FAIL')
  })

  it('负控：失效期间照发请求 / 没阻塞 / 建出任务 / 重选对不上 → FAIL', () => {
    const sent = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['stateChangeNoReroute']![
          'requestsWhileStale'
        ] = 1
      }),
    )
    expect(sent.verdict).toBe('FAIL')
    expect(sent.failures.join('\n')).toContain('静默改投')
    const unblocked = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['stateChangeNoReroute']![
          'blockedWhileStale'
        ] = false
      }),
    )
    expect(unblocked.verdict).toBe('FAIL')
    const created = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['stateChangeNoReroute']![
          'tasksCreatedWhileStale'
        ] = 1
      }),
    )
    expect(created.verdict).toBe('FAIL')
    const wrongPerson = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['stateChangeNoReroute']![
          'recoveredWithAssigneeUserId'
        ] = 'bob'
      }),
    )
    expect(wrongPerson.verdict).toBe('FAIL')
  })

  it('负控：失败却留下 Run / 恢复重开任务 / 换了设备 → FAIL', () => {
    const runsAfter = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['failedThenRecover']![
          'runsAfterFailure'
        ] = 1
      }),
    )
    expect(runsAfter.verdict).toBe('FAIL')
    const reopened = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['failedThenRecover']![
          'recoveredInSameTask'
        ] = false
      }),
    )
    expect(reopened.verdict).toBe('FAIL')
    const wrongDevice = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['failedThenRecover']![
          'recoveredRunDeviceId'
        ] = 'd-other'
      }),
    )
    expect(wrongDevice.verdict).toBe('FAIL')
  })

  it('负控：自动执行归错人 / 用错设备 / 任务不是 accepted → FAIL', () => {
    const wrongOwner = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['selfAgentExecute']![
          'runOwnerUserId'
        ] = 'bob'
      }),
    )
    expect(wrongOwner.verdict).toBe('FAIL')
    const wrongDevice = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['selfAgentExecute']![
          'runDeviceId'
        ] = 'd-bob'
      }),
    )
    expect(wrongDevice.verdict).toBe('FAIL')
    const notAccepted = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['selfAgentExecute']![
          'taskAssignmentStatus'
        ] = 'pending'
      }),
    )
    expect(notAccepted.verdict).toBe('FAIL')
  })

  it('负控：对方的执行用了别人的工作目录 → FAIL', () => {
    const wsOther = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['assignToOther']![
          'otherUserHasWorkspace'
        ] = true
      }),
    )
    expect(wsOther.verdict).toBe('FAIL')
    expect(wsOther.failures.join('\n')).toContain('工作目录')
  })

  it('负控：对方的执行用了别人的设备 / 执行新建了任务 → FAIL', () => {
    const otherDevice = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['assignToOther']![
          'otherUserHasDevice'
        ] = true
      }),
    )
    expect(otherDevice.verdict).toBe('FAIL')
    const created = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['assignToOther']![
          'tasksCreated'
        ] = 1
      }),
    )
    expect(created.verdict).toBe('FAIL')
  })

  it('负控：重试没到过 Hub（重放路径没被验到）/ 回放的不是同一个任务 → FAIL', () => {
    const notReached = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['retryIdempotent']![
          'firstAttemptReachedHub'
        ] = false
      }),
    )
    expect(notReached.verdict).toBe('FAIL')
    expect(notReached.failures.join('\n')).toContain('没到 Hub')
    const notReplayed = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['retryIdempotent']![
          'replayedSameTask'
        ] = false
      }),
    )
    expect(notReplayed.verdict).toBe('FAIL')
    expect(notReplayed.failures.join('\n')).toContain('回放')
  })

  it('负控：类型不对（数字写成字符串）也 FAIL，不静默略过', () => {
    const verdict = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['createOnly']!['runs'] = '0'
      }),
    )
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.failures.join('\n')).toContain('不是数字')
  })
})
