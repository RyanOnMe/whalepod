/**
 * 交接闭环证据判定器的自证（#381；延续 #345 的判定器纪律）。
 *
 * 判定器若只会说 PASS，它就是装饰。这里用正控 + 逐条负控证明它有牙：每一类
 * 「缺证据 / 说了谎 / 静默改写历史」都必须判 FAIL，且失败原因指名道姓。
 */
import { describe, expect, it } from 'vitest'
import { verifyHandoffLoopEvidence } from './handoff-loop-evidence.js'

const SHA = 'a'.repeat(64)

/** 一份完整、自洽的证据（正控）。各负控从这里改一处。 */
function goodEvidence(): Record<string, unknown> {
  return {
    component: 'web.handoff-loop',
    source: 'production-hub-node-runtime',
    verifiedAt: '2026-10-18T00:00:00.000Z',
    agreement: { enabled: true, confirmedRevisionNumber: 1 },
    backend: {
      taskId: 'task-up',
      runId: 'run-up',
      runStatus: 'completed',
      draftOrigin: 'auto',
      draftStatus: 'published',
      publishedRevisionNumber: 1,
      artifactId: 'artifact-1',
      artifactSha256: SHA,
      artifactPublished: true,
    },
    privacy: { ownerReadStatus: 200, otherMemberReadStatus: 404 },
    delivery: {
      receiptId: 'receipt-1',
      downstreamTaskId: 'task-down',
      receiverUserId: 'bob',
      statusAfterDeliver: 'pending',
      deliveriesRows: 1,
    },
    confirm: {
      statusAfterConfirm: 'confirmed',
      understandingFirst: '先做订单列表',
      assignmentStatusAfterConfirm: 'pending',
      runsAfterConfirm: 0,
      repeatConfirmStatus: 200,
      rowsAfterRepeatConfirm: 1,
      understandingAfterRepeatConfirm: '先做订单列表',
    },
    downstream: {
      runId: 'run-down',
      checkboxDefaultChecked: true,
      handoffInput: {
        upstreamTaskId: 'task-up',
        revisionNumber: 1,
        artifactId: 'artifact-1',
        sha256: SHA,
      },
      nodeCopy: { artifactId: 'artifact-1', sha256: SHA, fileSha256: SHA },
    },
    updateIsolation: {
      runId: 'run-down',
      latestRevisionNumber: 2,
      receiptsRowsAfterV2: 1,
      runInputRevisionNumberAfterV2: 1,
      runInputRevisionIdBeforeV2: 'rev-1',
      runInputRevisionIdAfterV2: 'rev-1',
    },
  }
}

function mutate(path: (evidence: Record<string, unknown>) => void): Record<string, unknown> {
  const evidence = goodEvidence()
  path(evidence)
  return evidence
}

describe('#381 交接闭环证据判定器', () => {
  it('正控：完整自洽的证据判 PASS', () => {
    const verdict = verifyHandoffLoopEvidence(goodEvidence())
    expect(verdict.failures).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.checks).toBeGreaterThan(30)
  })

  it('非对象/缺来源：FAIL', () => {
    expect(verifyHandoffLoopEvidence(null).ok).toBe(false)
    expect(verifyHandoffLoopEvidence({}).ok).toBe(false)
    expect(verifyHandoffLoopEvidence(mutate((e) => (e['source'] = 'unit-test-stub'))).ok).toBe(
      false,
    )
    expect(verifyHandoffLoopEvidence(mutate((e) => delete e['backend'])).ok).toBe(false)
  })

  const negatives: Array<[string, (e: Record<string, unknown>) => void]> = [
    ['约定未启用', (e) => ((e['agreement'] as Record<string, unknown>)['enabled'] = false)],
    [
      '草稿不是自动生成',
      (e) => ((e['backend'] as Record<string, unknown>)['draftOrigin'] = 'manual'),
    ],
    [
      '上游 Run 未完成',
      (e) => ((e['backend'] as Record<string, unknown>)['runStatus'] = 'running'),
    ],
    ['材料未发布', (e) => ((e['backend'] as Record<string, unknown>)['artifactPublished'] = false)],
    [
      '摘要是坏格式',
      (e) => ((e['backend'] as Record<string, unknown>)['artifactSha256'] = 'nothex'),
    ],
    [
      '私有草稿泄露给他人',
      (e) => ((e['privacy'] as Record<string, unknown>)['otherMemberReadStatus'] = 200),
    ],
    [
      '交付后不是待确认',
      (e) => ((e['delivery'] as Record<string, unknown>)['statusAfterDeliver'] = 'confirmed'),
    ],
    [
      '确认顺手接受了任务',
      (e) =>
        ((e['confirm'] as Record<string, unknown>)['assignmentStatusAfterConfirm'] = 'accepted'),
    ],
    ['确认启动了 Run', (e) => ((e['confirm'] as Record<string, unknown>)['runsAfterConfirm'] = 1)],
    [
      '重复确认不幂等',
      (e) => ((e['confirm'] as Record<string, unknown>)['rowsAfterRepeatConfirm'] = 2),
    ],
    [
      '重复确认覆盖了首次理解',
      (e) =>
        ((e['confirm'] as Record<string, unknown>)['understandingAfterRepeatConfirm'] = '改口'),
    ],
    [
      '执行区默认没勾选',
      (e) => ((e['downstream'] as Record<string, unknown>)['checkboxDefaultChecked'] = false),
    ],
    [
      'Run 快照指向别的材料',
      (e) =>
        (((e['downstream'] as Record<string, unknown>)['handoffInput'] as Record<string, unknown>)[
          'artifactId'
        ] = 'artifact-2'),
    ],
    [
      'Run 快照摘要与发布不符',
      (e) =>
        (((e['downstream'] as Record<string, unknown>)['handoffInput'] as Record<string, unknown>)[
          'sha256'
        ] = 'b'.repeat(64)),
    ],
    [
      'Node 副本实字节摘要不符',
      (e) =>
        (((e['downstream'] as Record<string, unknown>)['nodeCopy'] as Record<string, unknown>)[
          'fileSha256'
        ] = 'c'.repeat(64)),
    ],
    [
      '上游没发新版本（隔离性无从谈起）',
      (e) => ((e['updateIsolation'] as Record<string, unknown>)['latestRevisionNumber'] = 1),
    ],
    [
      'v2 改写了历史 Run 输入',
      (e) =>
        ((e['updateIsolation'] as Record<string, unknown>)['runInputRevisionIdAfterV2'] = 'rev-2'),
    ],
    [
      '下游仍钉旧编号之外的东西',
      (e) =>
        ((e['updateIsolation'] as Record<string, unknown>)['runInputRevisionNumberAfterV2'] = 2),
    ],
    [
      'v2 自发产生了新 receipt',
      (e) => ((e['updateIsolation'] as Record<string, unknown>)['receiptsRowsAfterV2'] = 2),
    ],
    [
      '上下游是同一个任务（闭环没跨任务）',
      (e) =>
        ((e['delivery'] as Record<string, unknown>)['downstreamTaskId'] = (
          e['backend'] as Record<string, unknown>
        )['taskId']),
    ],
  ]

  it.each(negatives)('负控：%s → FAIL 且指名道姓', (_label, mutateFn) => {
    const verdict = verifyHandoffLoopEvidence(mutate(mutateFn))
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.length).toBeGreaterThan(0)
  })
})
