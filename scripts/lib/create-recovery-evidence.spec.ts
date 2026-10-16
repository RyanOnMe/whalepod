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
        executionToast: false,
        doubleClickPosts: 1,
      },
      retryIdempotent: { attempts: 2, sameKey: true, tasksCreated: 1, taskId: 't2' },
      stateChangeNoReroute: {
        sentAssigneeUserId: 'carol',
        expectedAssigneeUserId: 'carol',
        hubStatus: 400,
        silentlySubstituted: false,
        recoveredWithAssigneeUserId: 'alice',
        recoveredAssigneeUserId: 'alice',
      },
      failedThenRecover: {
        taskId: 't3',
        driveCode: 'DEVICE_OFFLINE',
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
          'executionToast'
        ] = true
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

  it('负控：静默改投（请求里换了人 / 标记为 true）→ FAIL', () => {
    const substituted = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        const stale = (evidence['paths'] as Record<string, Record<string, unknown>>)[
          'stateChangeNoReroute'
        ]!
        stale['sentAssigneeUserId'] = 'alice'
        stale['silentlySubstituted'] = true
      }),
    )
    expect(substituted.verdict).toBe('FAIL')
    const text = substituted.failures.join('\n')
    expect(text).toContain('静默改投')
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

  it('负控：状态变化后的拒绝是 5xx（不是「选择失效」而是系统故障）→ FAIL', () => {
    const verdict = verifyCreateRecoveryEvidence(
      mutate((evidence) => {
        ;(evidence['paths'] as Record<string, Record<string, unknown>>)['stateChangeNoReroute']![
          'hubStatus'
        ] = 500
      }),
    )
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.failures.join('\n')).toContain('4xx')
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
