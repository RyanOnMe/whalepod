import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ADR-0028（RD-01/RD-02a）：工作与收件箱模块的架构边界。它不是运行时网络抓包，而是把
// 「本切片不得调用模型/Node/Run/Outbox，也不得写业务事实」变成可机器判红的面：
// 新增这类依赖会让本用例直接失败，必须在评审里显式改边界而不是悄悄带进来。
const WORK_MODULE_DIR = fileURLToPath(new URL('../src/modules/work/', import.meta.url))

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

    const inputs = readFileSync(join(WORK_MODULE_DIR, 'run-inputs.ts'), 'utf8')
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
    expect(
      orchestrator.match(/await this\.assertWorkInputAssignee\(taskId, ctx\.userId\)/g),
    ).toHaveLength(2)
  })
})
