/**
 * #345 创建到恢复证据的**独立判定**（判定侧与产出侧分开）。
 *
 * 产出侧是 `apps/web/tests/e2e/create-to-recovery.spec.ts`（真 Hub/Node/Runtime + 浏览器），
 * 本模块只**重判那份事实**：缺证据、自相矛盾、把「没发生」写成「发生过」一律 FAIL。
 * 判据原则与 `preparation-return-evidence.ts` 同款：不猜意思，只认离散事实；
 * 任何一段缺失都不是「跳过」，是 FAIL。
 */
export interface Verdict {
  verdict: 'PASS' | 'FAIL'
  failures: string[]
  checks: number
}

type Record0 = Record<string, unknown>

function isRecord(value: unknown): value is Record0 {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(record: Record0, key: string, where: string, failures: string[]): string | null {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    failures.push(`${where}.${key} 缺失或不是非空字符串`)
    return null
  }
  return value
}

function num(record: Record0, key: string, where: string, failures: string[]): number | null {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failures.push(`${where}.${key} 缺失或不是数字`)
    return null
  }
  return value
}

function flag(record: Record0, key: string, where: string, failures: string[]): boolean | null {
  const value = record[key]
  if (typeof value !== 'boolean') {
    failures.push(`${where}.${key} 缺失或不是布尔`)
    return null
  }
  return value
}

function path(record: Record0, name: string, failures: string[]): Record0 | null {
  const paths = record['paths']
  if (!isRecord(paths) || !isRecord(paths[name])) {
    failures.push(`paths.${name} 缺失（五条路径一条都不能少）`)
    return null
  }
  return paths[name] as Record0
}

/**
 * 判定五条路径的证据。`input` 是 result.json 解析后的值（可能是任何形状——
 * 缺字段、类型不对、空文件都必须 FAIL 而不是抛异常）。
 */
export function verifyCreateRecoveryEvidence(input: unknown): Verdict {
  const failures: string[] = []
  let checks = 0
  if (!isRecord(input)) {
    return { verdict: 'FAIL', failures: ['证据不是对象（空文件/坏 JSON 都算缺证据）'], checks: 1 }
  }
  if (input['component'] !== 'web.create-recovery') {
    failures.push('component 不是 web.create-recovery（拿错证据包）')
  }
  if (typeof input['source'] !== 'string' || !String(input['source']).includes('production')) {
    failures.push('source 未声明生产装配（真 Hub/Node/Runtime）')
  }
  checks += 2

  // 路径 1：只创建不执行。
  const createOnly = path(input, 'createOnly', failures)
  if (createOnly !== null) {
    checks += 4
    const runs = num(createOnly, 'runs', 'paths.createOnly', failures)
    if (runs !== null && runs !== 0) failures.push('路径 1：没有执行就不该有 Run')
    const toastCount = num(createOnly, 'executionToastCount', 'paths.createOnly', failures)
    if (toastCount !== null && toastCount !== 0) {
      failures.push(`路径 1：只创建任务却弹了执行 toast（实测 ${toastCount} 条）`)
    }
    // 责任人是谁由产出侧记（非空即可）；身份本身由路径 2 的「接受者=责任人」对账。
    if (str(createOnly, 'assigneeUserId', 'paths.createOnly', failures) !== null) checks += 1
    const status = str(createOnly, 'assignmentStatus', 'paths.createOnly', failures)
    if (status !== null && status !== 'pending') {
      failures.push(`路径 1：分给真人的任务必须是待接受，实测 ${status}`)
    }
    const doubleClick = num(createOnly, 'doubleClickPosts', 'paths.createOnly', failures)
    if (doubleClick !== null && doubleClick !== 1) {
      failures.push(`路径 1：连点只许发出一个创建 POST，实测 ${doubleClick}`)
    }
  }

  // 路径 5a：重试同义键。
  const retry = path(input, 'retryIdempotent', failures)
  if (retry !== null) {
    checks += 5
    const attempts = num(retry, 'attempts', 'paths.retryIdempotent', failures)
    if (attempts !== null && attempts < 2) failures.push('路径 5a：重试证据不足两次尝试')
    const sameKey = flag(retry, 'sameKey', 'paths.retryIdempotent', failures)
    if (sameKey === false) failures.push('路径 5a：重试换了新键——Hub 会当成第二笔创建')
    // 「第一次真的到过 Hub」是这条判据的牙齿：请求没落库时，「只建出一个任务」为空真。
    const reached = flag(retry, 'firstAttemptReachedHub', 'paths.retryIdempotent', failures)
    if (reached === false) {
      failures.push('路径 5a：第一次尝试没到 Hub——重放回执这条路根本没被验到')
    }
    const replayed = flag(retry, 'replayedSameTask', 'paths.retryIdempotent', failures)
    if (replayed === false) failures.push('路径 5a：重试拿到的不是同一个任务（Hub 没回放回执）')
    const created = num(retry, 'tasksCreated', 'paths.retryIdempotent', failures)
    if (created !== null && created !== 1) {
      failures.push(`路径 5a：两次尝试只许建出一个任务，实测 ${created}`)
    }
  }

  // 路径 5b：状态变化不静默改投（客户端在提交前显式阻塞，恢复靠重选）。
  const stale = path(input, 'stateChangeNoReroute', failures)
  if (stale !== null) {
    checks += 4
    const blocked = flag(stale, 'blockedWhileStale', 'paths.stateChangeNoReroute', failures)
    if (blocked === false) failures.push('路径 5b：责任人失效后没有显式阻塞（提交前无提示）')
    const requests = num(stale, 'requestsWhileStale', 'paths.stateChangeNoReroute', failures)
    if (requests !== null && requests !== 0) {
      failures.push(`路径 5b：责任人失效期间仍发出了 ${requests} 个创建请求（可能静默改投）`)
    }
    const created = num(stale, 'tasksCreatedWhileStale', 'paths.stateChangeNoReroute', failures)
    if (created !== null && created !== 0) {
      failures.push(`路径 5b：失效期间建出了 ${created} 个任务`)
    }
    const recovered = str(
      stale,
      'recoveredWithAssigneeUserId',
      'paths.stateChangeNoReroute',
      failures,
    )
    const recoveredExpected = str(
      stale,
      'recoveredAssigneeUserId',
      'paths.stateChangeNoReroute',
      failures,
    )
    if (recovered !== null && recoveredExpected !== null && recovered !== recoveredExpected) {
      failures.push('路径 5b：重选后建出的任务不是重选的那个责任人')
    }
  }

  // 路径 4：失败后原任务继续。
  const recover = path(input, 'failedThenRecover', failures)
  if (recover !== null) {
    checks += 6
    const code = str(recover, 'driveCode', 'paths.failedThenRecover', failures)
    if (code !== null && code !== 'DEVICE_OFFLINE') {
      failures.push(`路径 4：设备离线的错误码应是 DEVICE_OFFLINE，实测 ${code}`)
    }
    const outcome = str(recover, 'driveOutcome', 'paths.failedThenRecover', failures)
    if (outcome !== null && outcome !== 'failed') {
      failures.push(`路径 4：启动失败应记成 failed，实测 ${outcome}`)
    }
    const runsAfter = num(recover, 'runsAfterFailure', 'paths.failedThenRecover', failures)
    if (runsAfter !== null && runsAfter !== 0) {
      failures.push('路径 4：启动失败却留下了 Run')
    }
    const sameTask = flag(recover, 'recoveredInSameTask', 'paths.failedThenRecover', failures)
    if (sameTask === false) failures.push('路径 4：恢复没有落在原任务上（重开了任务）')
    if (str(recover, 'recoveredRunId', 'paths.failedThenRecover', failures) === null) {
      failures.push('路径 4：恢复后没有 Run 证据')
    }
    const owner = str(recover, 'recoveredRunOwnerUserId', 'paths.failedThenRecover', failures)
    const ownerExpected = str(
      recover,
      'expectedRunOwnerUserId',
      'paths.failedThenRecover',
      failures,
    )
    if (owner !== null && ownerExpected !== null && owner !== ownerExpected) {
      failures.push('路径 4：恢复后的 Run 不属于责任人')
    }
    const device = str(recover, 'recoveredRunDeviceId', 'paths.failedThenRecover', failures)
    const deviceExpected = str(recover, 'expectedRunDeviceId', 'paths.failedThenRecover', failures)
    if (device !== null && deviceExpected !== null && device !== deviceExpected) {
      failures.push('路径 4：恢复后的 Run 没用责任人的设备')
    }
  }

  // 路径 3：自己开启执行。
  const selfAgent = path(input, 'selfAgentExecute', failures)
  if (selfAgent !== null) {
    checks += 5
    const outcome = str(selfAgent, 'driveOutcome', 'paths.selfAgentExecute', failures)
    if (outcome !== null && outcome !== 'started_run') {
      failures.push(`路径 3：自动执行应是 started_run，实测 ${outcome}`)
    }
    const owner = str(selfAgent, 'runOwnerUserId', 'paths.selfAgentExecute', failures)
    const ownerExpected = str(
      selfAgent,
      'expectedRunOwnerUserId',
      'paths.selfAgentExecute',
      failures,
    )
    if (owner !== null && ownerExpected !== null && owner !== ownerExpected) {
      failures.push('路径 3：自动执行的 Run 不属于创建者')
    }
    const device = str(selfAgent, 'runDeviceId', 'paths.selfAgentExecute', failures)
    const deviceExpected = str(selfAgent, 'expectedRunDeviceId', 'paths.selfAgentExecute', failures)
    if (device !== null && deviceExpected !== null && device !== deviceExpected) {
      failures.push('路径 3：自动执行没用创建者自己的设备')
    }
    const status = str(selfAgent, 'taskAssignmentStatus', 'paths.selfAgentExecute', failures)
    if (status !== null && status !== 'accepted') {
      failures.push(`路径 3：Agent 指派的任务出生即 accepted，实测 ${status}`)
    }
    const created = num(selfAgent, 'tasksCreated', 'paths.selfAgentExecute', failures)
    if (created !== null && created !== 1) {
      failures.push(`路径 3：一次「创建并执行」只许一个任务，实测 ${created}`)
    }
  }

  // 路径 2：分给别人、对方在自己现场执行。
  const assignOther = path(input, 'assignToOther', failures)
  if (assignOther !== null) {
    checks += 6
    const accepted = str(assignOther, 'acceptedByUserId', 'paths.assignToOther', failures)
    const expected = str(assignOther, 'expectedAssigneeUserId', 'paths.assignToOther', failures)
    if (accepted !== null && expected !== null && accepted !== expected) {
      failures.push('路径 2：接受任务的人不是责任人')
    }
    const status = str(assignOther, 'assignmentStatus', 'paths.assignToOther', failures)
    if (status !== null && status !== 'accepted') {
      failures.push(`路径 2：对方接受后应是 accepted，实测 ${status}`)
    }
    const owner = str(assignOther, 'runOwnerUserId', 'paths.assignToOther', failures)
    const ownerExpected = str(
      assignOther,
      'expectedRunOwnerUserId',
      'paths.assignToOther',
      failures,
    )
    if (owner !== null && ownerExpected !== null && owner !== ownerExpected) {
      failures.push('路径 2：执行的人不是任务责任人')
    }
    const belongs = flag(assignOther, 'deviceBelongsToOwner', 'paths.assignToOther', failures)
    if (belongs === false) failures.push('路径 2：Run 的设备不属于执行者')
    const otherHas = flag(assignOther, 'otherUserHasDevice', 'paths.assignToOther', failures)
    if (otherHas === true) failures.push('路径 2：Run 用了另一个人的设备')
    const wsOwned = flag(assignOther, 'workspaceBelongsToOwner', 'paths.assignToOther', failures)
    if (wsOwned === false) failures.push('路径 2：Run 的工作目录不属于执行者')
    const wsOther = flag(assignOther, 'otherUserHasWorkspace', 'paths.assignToOther', failures)
    if (wsOther === true) failures.push('路径 2：Run 用了另一个人的工作目录')
    const created = num(assignOther, 'tasksCreated', 'paths.assignToOther', failures)
    if (created !== null && created !== 0) failures.push('路径 2：执行不该新建任务')
  }

  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', failures, checks }
}
