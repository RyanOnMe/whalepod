import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { workSourceMatchesItem } from '../src/modules/work/run-dispatch.js'

// ADR-0028（RD-01/RD-02a）：工作与收件箱模块的架构边界。它不是运行时网络抓包，而是把
// 「本切片不得调用模型/Node/Run/Outbox，也不得写业务事实」变成可机器判红的面：
// 新增这类依赖会让本用例直接失败，必须在评审里显式改边界而不是悄悄带进来。
const WORK_MODULE_DIR = fileURLToPath(new URL('../src/modules/work/', import.meta.url))
const DISPATCH_MODULE_DIR = fileURLToPath(new URL('../src/modules/dispatch/', import.meta.url))

const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'DSH vendor import', pattern: /@deepseek-ai\// },
  { name: 'model SDK import', pattern: /from ['"](?:openai|@anthropic-ai\/sdk|ai)['"]/ },
  { name: 'runtime/testkit import', pattern: /@whalepod\/(?:runtime|runtime-dsh|testkit)/ },
  { name: 'Run orchestrator', pattern: /\bRunOrchestrator\b/ },
  { name: 'outbox writer', pattern: /\b(?:dispatchOutbox|Outbox)\b/ },
  { name: 'Run writer', pattern: /\binsertRun\b/ },
  { name: 'TeamEvent writer', pattern: /\bappendTeamEvent\b/ },
  { name: 'context writer', pattern: /\binsertContextEntry\b/ },
  { name: 'artifact writer', pattern: /\binsertArtifact\b/ },
  { name: 'network fetch', pattern: /\bfetch\s*\(/ },
]

describe('ADR-0028 work module boundaries', () => {
  it('does not import model, runtime, Run/outbox or business writers', () => {
    const files = readdirSync(WORK_MODULE_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(join(WORK_MODULE_DIR, file), 'utf8')
      for (const forbidden of FORBIDDEN_PATTERNS) {
        expect(source, `${file} must not contain ${forbidden.name}`).not.toMatch(forbidden.pattern)
      }
    }
  })
})

describe('RD-02a-1 inbox read authorization boundary', () => {
  it('keeps the assignee check inside the private-list transaction', () => {
    const source = readFileSync(join(WORK_MODULE_DIR, 'inbox.ts'), 'utf8')
    const start = source.indexOf('export async function loadWorkInboxForActor')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const fn = source.slice(start, end)
    // 授权、条目读取与水位必须在同一个 transaction 回调内；且只能有一个
    // transaction，授权放事务外/拆成两个事务都会重新打开 TOCTOU。
    expect(fn.match(/database\.transaction\(/g)).toHaveLength(1)
    const transactionAt = fn.indexOf('database.transaction(')
    expect(transactionAt).toBeGreaterThan(-1)
    expect(fn.indexOf('await requireAssignee(tx, task, actorUserId)')).toBeGreaterThan(
      transactionAt,
    )
    expect(fn.indexOf('readInboxView(tx, work, filter)')).toBeGreaterThan(transactionAt)
    expect(fn).not.toContain('database.db')
    // 同一 transaction 还不够：READ COMMITTED 下每条语句各取快照，授权后会读到改派后的列表。
    expect(fn).toContain("isolationLevel: 'repeatable read'")
    expect(fn).toContain("accessMode: 'read only'")

    const routes = readFileSync(join(WORK_MODULE_DIR, 'routes.ts'), 'utf8')
    const routeStart = routes.indexOf("app.get('/works/:workKey/inbox'")
    expect(routeStart).toBeGreaterThan(-1)
    const routeEnd = routes.indexOf('\n  })', routeStart)
    expect(routeEnd).toBeGreaterThan(routeStart)
    const route = routes.slice(routeStart, routeEnd)
    // 生产 GET 必须只走同一事务的 helper，不能再先 loadAuthorizedWork 再列。
    expect(route).toContain('loadWorkInboxForActor(deps.database, session.userId, workKey, query)')
    expect(route).not.toContain('loadAuthorizedWork')
  })
})

describe('RD-02a-2a work input reconcile isolation', () => {
  const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

  it('locks Work before the item and settles each due input in its own transaction', () => {
    const repo = readFileSync(join(REPO_ROOT, 'packages/db/src/repositories/work-input.ts'), 'utf8')
    const start = repo.indexOf('export async function settleUnconfirmedWorkInput')
    expect(start).toBeGreaterThan(-1)
    const end = repo.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const settle = repo.slice(start, end)
    // item → Work 会与撤权（Task→Work→item）形成环；Work 必须先于被锁的 item。
    expect(settle).toMatch(
      /\.from\(works\)[\s\S]*?\.for\('update'\)[\s\S]*?\.from\(workInboxItems\)[\s\S]*?\.for\('update'\)/,
    )
    // 最新版本查询必须在 Work 锁内，否则关联/撤权可以并发改同来源条目。
    const workLockAt = settle.indexOf('.from(works)')
    const latestAt = settle.indexOf('const [latest]')
    expect(workLockAt).toBeGreaterThan(-1)
    expect(latestAt).toBeGreaterThan(workLockAt)
    expect(settle.slice(workLockAt, latestAt)).toContain(".for('update')")

    const workRepo = readFileSync(join(REPO_ROOT, 'packages/db/src/repositories/work.ts'), 'utf8')
    const workStart = workRepo.indexOf('export async function getWorkByIdForUpdate')
    expect(workStart).toBeGreaterThan(-1)
    const workEnd = workRepo.indexOf('\n}\n', workStart)
    expect(workEnd).toBeGreaterThan(workStart)
    // 不能只改名字：这个 helper 必须真的加行锁，否则建 Run 的锁序声明是假的。
    expect(workRepo.slice(workStart, workEnd)).toContain(".for('update')")

    const inputs = readFileSync(join(WORK_MODULE_DIR, 'run-inputs.ts'), 'utf8')
    const snapshotStart = inputs.indexOf('export async function snapshotWorkInputs')
    expect(snapshotStart).toBeGreaterThan(-1)
    const snapshotEnd = inputs.indexOf('\n}\n', snapshotStart)
    expect(snapshotEnd).toBeGreaterThan(snapshotStart)
    const snapshot = inputs.slice(snapshotStart, snapshotEnd)
    // 建 Run 也必须先锁 Work 再锁 item：delivery 的 Work FK 会取 KEY SHARE，
    // 与 settle 的 Work FOR UPDATE 反向持锁会死锁。
    expect(snapshot.indexOf('getWorkByIdForUpdate(tx, firstSnapshot.workId)')).toBeGreaterThan(-1)
    expect(snapshot.indexOf('getWorkByIdForUpdate(tx, firstSnapshot.workId)')).toBeLessThan(
      snapshot.indexOf('listWorkInboxItemsForUpdate(tx, itemIds)'),
    )

    const reconcileStart = inputs.indexOf('export async function reconcileWorkInputs')
    expect(reconcileStart).toBeGreaterThan(-1)
    const reconcileEnd = inputs.indexOf('\n}\n', reconcileStart)
    expect(reconcileEnd).toBeGreaterThan(reconcileStart)
    const reconcile = inputs.slice(reconcileStart, reconcileEnd)
    // 每条到期输入独立事务 + allSettled：一条失败不能拖垮整轮，也不能整轮回滚。
    expect(reconcile.match(/database\.transaction\(/g)).toHaveLength(1)
    expect(reconcile).toMatch(/due\.map\(\(itemId\)\s*=>\s*database\.transaction\(/)
    expect(reconcile).toContain('Promise.allSettled')
    expect(reconcile).not.toContain('returnUnconfirmedWorkInputs')

    const orchestrator = readFileSync(
      join(REPO_ROOT, 'apps/hub/src/modules/run/orchestrator.ts'),
      'utf8',
    )
    // 创建事务内校验一次 + 两条回放路径（普通回执、活跃冲突回读）各复核一次。
    expect(orchestrator).toMatch(/input\.workInputItemIds !== undefined && right !== 'assignee'/)
    expect(orchestrator.match(/await this\.assertReplayAllowed\(/g)).toHaveLength(2)
  })
})

describe('RD-02a-2b work input receipt lock order', () => {
  it('takes the Work lock before inserting the receipt and before touching items', () => {
    const source = readFileSync(join(WORK_MODULE_DIR, 'receipts.ts'), 'utf8')
    const start = source.indexOf('export async function recordRunWorkInputReceipt')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const fn = source.slice(start, end)
    const lockAt = fn.indexOf('getWorkByKeyForUpdate(tx, receipt.workKey)')
    const insertAt = fn.indexOf('insertRunWorkInputReceiptIfAbsent(tx')
    const itemAt = fn.indexOf('getWorkInboxItemForUpdate(tx, event.inboxItemId)')
    expect(lockAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(lockAt)
    expect(itemAt).toBeGreaterThan(insertAt)
    // 回执正文/标题不得进入观测：store 只接受 id、计数与摘要字段。
    expect(fn).not.toContain('body:')
    expect(fn).not.toContain('title:')
  })

  it('logs invalid receipts locally instead of letting CONFLICT reach the socket', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const source = readFileSync(join(repoRoot, 'apps/hub/src/modules/run/orchestrator.ts'), 'utf8')
    const start = source.indexOf('private async handleRunWorkInputReceipt')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n  }\n', start)
    expect(end).toBeGreaterThan(start)
    const handler = source.slice(start, end)
    expect(handler).toContain("error instanceof RunCommandError && error.code === 'CONFLICT'")
    expect(handler).toContain("this.contextLog('work.input_receipt_invalid'")
    expect(handler).toContain('return')
  })
})

describe('RD-02b entry admission and subscription boundaries', () => {
  it('keeps automatic entry routing out of RD-01 shadow decisions and Run/outbox writers', () => {
    const entry = readFileSync(join(WORK_MODULE_DIR, 'entry.ts'), 'utf8')
    const subscriptions = readFileSync(join(WORK_MODULE_DIR, 'subscriptions.ts'), 'utf8')
    // 自动入口的慢路径是独立 Router 调用记录；写 router_decision 会占用 RD-01 的
    // 「同一来源只裁决一次」唯一键，让显式准入再也无法重新评估。
    expect(entry).not.toContain('insertRouterDecision')
    expect(entry).not.toContain('getRouterDecisionBySource')
    expect(entry).not.toContain('routerDecisions')
    expect(entry).toContain('insertWorkEntryRouterCall')
    expect(entry).toContain('routerCallId')

    // 订阅写命令必须走 Task→Work 锁序与 assignee-only 校验。
    expect(subscriptions).toContain('lockWorkContext(tx, workKey)')
    expect(subscriptions).toContain('requireAssignee(tx, task, actorUserId)')
    expect(subscriptions).not.toContain('insertRun')
    expect(subscriptions).not.toContain('appendTeamEvent')
  })

  it('locks Work before terminal item updates', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const runStatus = readFileSync(join(repoRoot, 'apps/hub/src/modules/run/run-status.ts'), 'utf8')
    const terminalAt = runStatus.indexOf('TERMINAL_RUN_STATUSES.has(status)')
    const lockAt = runStatus.indexOf('getWorkByIdForUpdate(tx, work.id)', terminalAt)
    const unconfirmedAt = runStatus.indexOf('markRunWorkInputsUnconfirmed', terminalAt)
    expect(terminalAt).toBeGreaterThan(-1)
    // 终态同时更新 item（unconfirmed）并投影 Observation → 入口准入会锁 Work；
    // 必须先锁 Work，保持 Run→Work→item，不能形成 item→Work 反向边。
    expect(lockAt).toBeGreaterThan(terminalAt)
    expect(unconfirmedAt).toBeGreaterThan(lockAt)

    const taskCommands = readFileSync(
      join(repoRoot, 'apps/hub/src/modules/task/commands.ts'),
      'utf8',
    )
    const cancelStart = taskCommands.indexOf('async function cancelWorkProposals')
    const cancelEnd = taskCommands.indexOf('\n}\n', cancelStart)
    const cancel = taskCommands.slice(cancelStart, cancelEnd)
    const cancelLockAt = cancel.indexOf('getWorkByIdForUpdate(tx, work.id)')
    const cancelExpireAt = cancel.indexOf('expireWorkSubscriptionsAndRetract')
    expect(cancelLockAt).toBeGreaterThan(-1)
    expect(cancelExpireAt).toBeGreaterThan(cancelLockAt)
  })

  it('does not silently deliver a source without an active subscription', () => {
    const entry = readFileSync(join(WORK_MODULE_DIR, 'entry.ts'), 'utf8')
    const start = entry.indexOf('async function admitWorkEntry')
    expect(start).toBeGreaterThan(-1)
    const end = entry.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const fn = entry.slice(start, end)
    const deliverAt = fn.indexOf("outcome: inserted === undefined ? 'drop' : 'deliver'")
    const routeAt = fn.lastIndexOf('const routed = await deps.router.route')
    expect(deliverAt).toBeGreaterThan(-1)
    expect(routeAt).toBeGreaterThan(deliverAt)
    // 交付分支必须只在 subscription 判有效之后，且慢路径是兜底而不是默认。
    expect(fn.indexOf('if (validity.valid)')).toBeGreaterThan(-1)
    expect(fn.indexOf('if (validity.valid)')).toBeLessThan(deliverAt)
  })
})

describe('RD-02a-2b dispatch-time source identity', () => {
  it('requires version, digest and authorization generation to all match', () => {
    const item = {
      sourceVersion: 'v1',
      sourceDigest: 'a'.repeat(64),
      authorizationGeneration: 'gen-1',
    }
    expect(workSourceMatchesItem({ ...item }, item)).toBe(true)
    expect(workSourceMatchesItem({ ...item, sourceVersion: 'v2' }, item)).toBe(false)
    expect(workSourceMatchesItem({ ...item, sourceDigest: 'b'.repeat(64) }, item)).toBe(false)
    expect(workSourceMatchesItem({ ...item, authorizationGeneration: 'gen-2' }, item)).toBe(false)
  })
})

describe('RD-03a dispatch port boundaries', () => {
  it('creates machine Runs only through the shared orchestrator core in lock order', () => {
    const source = readFileSync(join(DISPATCH_MODULE_DIR, 'service.ts'), 'utf8')
    // 端口不能自己写 Run/TeamEvent/状态：机器 Run 必须复用同一创建核心（含单活跃/约定/快照）。
    expect(source).toContain('createWithinTransaction')
    expect(source).not.toMatch(/\binsertRun\b/)
    expect(source).not.toMatch(/\bappendTeamEvent\b/)
    expect(source).not.toMatch(/\bsetRunStatus\b/)
    // 锁序 Task → Work → intent → Run：意图锁必须在 Work 锁之后、Run 创建之前。
    const lockWorkAt = source.indexOf('lockWorkContext(tx, workKey)')
    const intentLockAt = source.indexOf('getDispatchIntentForUpdate(tx, intentId)')
    const createAt = source.indexOf('createWithinTransaction(')
    const mandateLockAt = source.indexOf('getWorkMandateForUpdate(tx, intent.mandateId)')
    expect(lockWorkAt).toBeGreaterThan(-1)
    expect(intentLockAt).toBeGreaterThan(lockWorkAt)
    expect(mandateLockAt).toBeGreaterThan(intentLockAt)
    expect(createAt).toBeGreaterThan(mandateLockAt)
    // 事务内查设备就绪必须复用 tx；走池里的第二连接会在连接打满时行锁自锁。
    expect(source).toContain('getDeviceDshDistributionVersion(tx, request.deviceId, now)')
    expect(source).not.toContain('dshDistributionVersionFor')
  })

  it('keeps the normal create path from forging machine provenance', () => {
    const orchestrator = readFileSync(
      fileURLToPath(new URL('../src/modules/run/orchestrator.ts', import.meta.url)),
      'utf8',
    )
    expect(orchestrator).toContain("input.origin === 'mandate'")
    expect(orchestrator).toContain('machine runs must be created by the dispatch port')
    expect(orchestrator).toContain('machine run provenance is incomplete')
    expect(orchestrator).toContain("approvalPolicy === 'full_access'")
    expect(orchestrator).toContain("origin === 'mandate' && explicitWorkKey === undefined")
  })

  it('enforces provenance and one-run-per-intent at the database layer', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const migration = readFileSync(
      join(repoRoot, 'packages/db/migrations/0034_rd03_dispatch_provenance.sql'),
      'utf8',
    )
    expect(migration).toContain('constraint run_origin_fields')
    expect(migration).toContain("origin = 'mandate'")
    expect(migration).toContain('create unique index run_dispatch_intent_unique')
    expect(migration).toContain('create unique index dispatch_intent_run_unique')
    expect(migration).toContain('constraint dispatch_intent_target_fields')
  })
})
