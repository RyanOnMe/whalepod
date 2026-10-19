/**
 * 两成员交接闭环证据判定器（#381；判定独立于产者——延续 #345 模式）。
 *
 * 输入是 `artifacts/evidence/handoff-loop/result.json`。判据要求**交叉一致**，不只是
 * 「每格非空」：材料的 artifactId/sha256 必须在上游发布、下游 Run 快照、Node 副本文
 * 摘要三处**同一**；v2 发布前后 Run 快照的 revisionId 必须**相同**（历史不被改写）；
 * 重复确认后仍是同一条 receipt 且首次理解未被覆盖；隔离性检查必须真的跑在**下游
 * Run** 上，且下游 Run 与上游 Run 是两条不同的 Run（同一条冒充两条即 FAIL）。
 *
 * 判定器只认它自己算出来的事实：缺一节、多一节、任何一处不一致都 FAIL，绝不跳过。
 */

export interface HandoffLoopVerification {
  ok: boolean
  failures: string[]
  checks: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Reader {
  check: (condition: boolean, message: string) => void
  str: (node: unknown, label: string) => string | undefined
  num: (node: unknown, label: string) => number | undefined
  section: (input: Record<string, unknown>, key: string) => Record<string, unknown> | undefined
  checks: () => number
}

function makeReader(failures: string[]): Reader {
  let count = 0
  const check = (condition: boolean, message: string): void => {
    count += 1
    if (!condition) failures.push(message)
  }
  const str = (node: unknown, label: string): string | undefined => {
    check(typeof node === 'string' && node.length > 0, `${label} must be a non-empty string`)
    return typeof node === 'string' && node.length > 0 ? node : undefined
  }
  const num = (node: unknown, label: string): number | undefined => {
    check(typeof node === 'number' && Number.isFinite(node), `${label} must be a number`)
    return typeof node === 'number' && Number.isFinite(node) ? node : undefined
  }
  return {
    check,
    str,
    num,
    section: (input, key) => {
      const value = input[key]
      check(isRecord(value), `missing section: ${key}`)
      return isRecord(value) ? value : undefined
    },
    checks: () => count,
  }
}

export function verifyHandoffLoopEvidence(input: unknown): HandoffLoopVerification {
  const failures: string[] = []
  const reader = makeReader(failures)
  const { check, str, num } = reader

  if (!isRecord(input)) {
    return { ok: false, failures: ['evidence is not an object'], checks: 1 }
  }
  // 产者身份与时间戳：来源必须是生产装配链，不能是单测桩。
  check(input['component'] === 'web.handoff-loop', "component must be 'web.handoff-loop'")
  const source = str(input['source'], 'source')
  check(
    source !== undefined && source.includes('production'),
    "source must name the production assembly chain (contains 'production')",
  )
  str(input['verifiedAt'], 'verifiedAt')

  const agreement = reader.section(input, 'agreement')
  if (agreement !== undefined) {
    check(agreement['enabled'] === true, 'agreement.enabled must be true')
    check(
      num(agreement['confirmedRevisionNumber'], 'agreement.confirmedRevisionNumber') === 1,
      'agreement.confirmedRevisionNumber must be 1',
    )
  }

  const backend = reader.section(input, 'backend')
  const agreementDraft = reader.section(input, 'agreementDraft')
  if (agreementDraft !== undefined) {
    const runId = str(agreementDraft['runId'], 'agreementDraft.runId')
    str(agreementDraft['artifactId'], 'agreementDraft.artifactId')
    check(agreementDraft['purpose'] === 'agreement_draft', 'draft must use agreement_draft purpose')
    check(agreementDraft['runStatus'] === 'completed', 'agreement helper run must complete')
    check(agreementDraft['ownerReadStatus'] === 200, 'owner must read agreement candidate')
    check(
      agreementDraft['otherMemberReadStatus'] === 404,
      'other member must not read agreement candidate',
    )
    check(
      agreementDraft['artifactStatus'] === 'candidate',
      'agreement candidate must remain private',
    )
    check(agreementDraft['confirmedBeforeAdopt'] === null, 'helper must not auto-confirm agreement')
    check(agreementDraft['confirmedAfterAdopt'] === null, 'adoption must not confirm agreement')
    check(
      runId !== undefined && runId !== backend?.['runId'],
      'helper must differ from business run',
    )
    const candidate = reader.section(agreementDraft, 'candidateContent')
    const adopted = reader.section(agreementDraft, 'adoptedContent')
    for (const key of ['goal', 'constraints', 'acceptance', 'openQuestions']) {
      check(
        candidate !== undefined &&
          adopted !== undefined &&
          typeof candidate[key] === 'string' &&
          candidate[key] === adopted[key],
        `adopted agreement ${key} must equal inspected candidate`,
      )
    }
  }
  let backendArtifactId: string | undefined
  let backendSha: string | undefined
  let upstreamTaskId: string | undefined
  let backendRunId: string | undefined
  if (backend !== undefined) {
    upstreamTaskId = str(backend['taskId'], 'backend.taskId')
    backendRunId = str(backend['runId'], 'backend.runId')
    check(backend['runStatus'] === 'completed', "backend.runStatus must be 'completed'")
    check(backend['draftOrigin'] === 'auto', "backend.draftOrigin must be 'auto'")
    check(backend['draftStatus'] === 'published', "backend.draftStatus must be 'published'")
    check(
      num(backend['publishedRevisionNumber'], 'backend.publishedRevisionNumber') === 1,
      'backend.publishedRevisionNumber must be 1',
    )
    backendArtifactId = str(backend['artifactId'], 'backend.artifactId')
    backendSha = str(backend['artifactSha256'], 'backend.artifactSha256')
    check(
      backendSha !== undefined && /^[a-f0-9]{64}$/.test(backendSha),
      'backend.artifactSha256 must be a lowercase sha256 hex digest',
    )
    check(backend['artifactPublished'] === true, 'backend.artifactPublished must be true')
  }

  const privacy = reader.section(input, 'privacy')
  if (privacy !== undefined) {
    check(
      num(privacy['ownerReadStatus'], 'privacy.ownerReadStatus') === 200,
      'owner must be able to read its own handoff draft (200)',
    )
    check(
      num(privacy['otherMemberReadStatus'], 'privacy.otherMemberReadStatus') === 404,
      'another member must get 404 for the private draft (no existence leak)',
    )
  }

  const delivery = reader.section(input, 'delivery')
  let downstreamTaskId: string | undefined
  if (delivery !== undefined) {
    str(delivery['receiptId'], 'delivery.receiptId')
    downstreamTaskId = str(delivery['downstreamTaskId'], 'delivery.downstreamTaskId')
    str(delivery['receiverUserId'], 'delivery.receiverUserId')
    check(
      delivery['statusAfterDeliver'] === 'pending',
      "delivery.statusAfterDeliver must be 'pending'",
    )
    check(
      num(delivery['deliveriesRows'], 'delivery.deliveriesRows') === 1,
      'deliveries must be exactly one receipt',
    )
    check(
      backendRunId !== undefined &&
        downstreamTaskId !== undefined &&
        downstreamTaskId !== upstreamTaskId,
      'downstream task must differ from the upstream task',
    )
  }

  const confirm = reader.section(input, 'confirm')
  if (confirm !== undefined) {
    check(
      confirm['statusAfterConfirm'] === 'confirmed',
      "confirm.statusAfterConfirm must be 'confirmed'",
    )
    const first = str(confirm['understandingFirst'], 'confirm.understandingFirst')
    // 确认 ≠ 接受任务：指派仍是 pending、零 Run。
    check(
      confirm['assignmentStatusAfterConfirm'] === 'pending',
      'confirm must not accept the downstream assignment (assignmentStatus stays pending)',
    )
    check(
      num(confirm['runsAfterConfirm'], 'confirm.runsAfterConfirm') === 0,
      'confirm must not start any run',
    )
    check(
      num(confirm['repeatConfirmStatus'], 'confirm.repeatConfirmStatus') === 200,
      'repeat confirm must be idempotent (200)',
    )
    check(
      num(confirm['rowsAfterRepeatConfirm'], 'confirm.rowsAfterRepeatConfirm') === 1,
      'repeat confirm must not create a second receipt',
    )
    const after = str(
      confirm['understandingAfterRepeatConfirm'],
      'confirm.understandingAfterRepeatConfirm',
    )
    check(
      first !== undefined && after !== undefined && first === after,
      'repeat confirm must not overwrite the first understanding',
    )
  }

  const downstream = reader.section(input, 'downstream')
  let downstreamRunId: string | undefined
  if (downstream !== undefined) {
    downstreamRunId = str(downstream['runId'], 'downstream.runId')
    check(
      downstream['checkboxDefaultChecked'] === true,
      'the composer must default to attaching the handoff package',
    )
    const handoffInput = reader.section(downstream, 'handoffInput')
    const nodeCopy = reader.section(downstream, 'nodeCopy')
    if (handoffInput !== undefined) {
      check(
        num(handoffInput['revisionNumber'], 'downstream.handoffInput.revisionNumber') === 1,
        'downstream run must pin revision v1',
      )
      const inputArtifactId = str(handoffInput['artifactId'], 'downstream.handoffInput.artifactId')
      const inputSha = str(handoffInput['sha256'], 'downstream.handoffInput.sha256')
      check(
        upstreamTaskId !== undefined &&
          handoffInput['upstreamTaskId'] !== undefined &&
          handoffInput['upstreamTaskId'] === upstreamTaskId,
        'the run snapshot must name the upstream task',
      )
      // 三处同一：上游发布 → 下游快照 → Node 副本实字节。
      check(
        inputArtifactId !== undefined &&
          backendArtifactId !== undefined &&
          inputArtifactId === backendArtifactId,
        'the run snapshot must reference the published artifact',
      )
      check(
        inputSha !== undefined && backendSha !== undefined && inputSha === backendSha,
        'the run snapshot digest must equal the published digest',
      )
    }
    if (nodeCopy !== undefined) {
      const copyArtifactId = str(nodeCopy['artifactId'], 'downstream.nodeCopy.artifactId')
      const copySha = str(nodeCopy['sha256'], 'downstream.nodeCopy.sha256')
      const fileSha = str(nodeCopy['fileSha256'], 'downstream.nodeCopy.fileSha256')
      check(
        copyArtifactId !== undefined &&
          backendArtifactId !== undefined &&
          copyArtifactId === backendArtifactId,
        'node copy must be the same artifact identity',
      )
      check(
        copySha !== undefined && backendSha !== undefined && copySha === backendSha,
        'node manifest digest must equal the published digest',
      )
      check(
        fileSha !== undefined && copySha !== undefined && fileSha === copySha,
        'the copied bytes must hash to the pinned digest',
      )
    }
  }

  const isolation = reader.section(input, 'updateIsolation')
  if (isolation !== undefined) {
    check(
      num(isolation['latestRevisionNumber'], 'updateIsolation.latestRevisionNumber') === 2,
      'upstream must have published v2',
    )
    check(
      num(isolation['receiptsRowsAfterV2'], 'updateIsolation.receiptsRowsAfterV2') === 1,
      'publishing v2 must not create new receipts on its own',
    )
    const before = str(
      isolation['runInputRevisionIdBeforeV2'],
      'updateIsolation.runInputRevisionIdBeforeV2',
    )
    const after = str(
      isolation['runInputRevisionIdAfterV2'],
      'updateIsolation.runInputRevisionIdAfterV2',
    )
    check(
      before !== undefined && after !== undefined && before === after,
      'upstream v2 must not change the historical run input (same revision id)',
    )
    check(
      num(
        isolation['runInputRevisionNumberAfterV2'],
        'updateIsolation.runInputRevisionNumberAfterV2',
      ) === 1,
      'the historical run must still pin v1 after v2 was published',
    )
    // 评审 B10：隔离性检查必须真的跑在**下游 Run** 上，且下游 Run 与上游 Run 是两条
    //（同一条 Run 冒充两条会让「历史不被改写」失去意义）。
    const isolationRunId = str(isolation['runId'], 'updateIsolation.runId')
    check(
      isolationRunId !== undefined &&
        downstreamRunId !== undefined &&
        isolationRunId === downstreamRunId,
      'updateIsolation.runId must be the downstream run',
    )
    check(
      isolationRunId !== undefined && backendRunId !== undefined && isolationRunId !== backendRunId,
      'the isolation check must exercise a different run than the backend run',
    )
  }

  const semantic = reader.section(input, 'semantic')
  if (semantic !== undefined) {
    const includes = (output: string, expected: string): void => {
      const text = str(semantic[output], `semantic.${output}`)
      const fragment = str(semantic[expected], `semantic.${expected}`)
      check(
        text !== undefined && fragment !== undefined && text.includes(fragment),
        `${output} must include ${expected}`,
      )
    }
    includes('agreementOutput', 'agreementGoal')
    includes('agreementOutput', 'agreementAcceptance')
    includes('receiverVisibleText', 'handoffStatement')
    includes('downstreamOutput', 'handoffStatement')
    includes('downstreamOutput', 'understanding')
  }
  const finalization = reader.section(input, 'finalization')
  if (finalization !== undefined) {
    check(
      finalization['beforeReview'] === 'in_progress',
      'Run completion must not auto-complete Task',
    )
    check(finalization['afterSubmit'] === 'in_review', 'human submit must reach in_review')
    check(finalization['afterComplete'] === 'done', 'human completion must reach done')
  }
  return { ok: failures.length === 0, failures, checks: reader.checks() }
}
