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
    // 授权、条目读取与水位必须在同一个 transaction 回调内；授权放在事务外
    // 再另开列表事务会重新打开 TOCTOU。
    expect(fn).toContain('database.transaction(')
    expect(fn).toContain('await requireAssignee(tx, task, actorUserId)')
    expect(fn).toContain('readInboxView(tx, work, filter)')
    expect(fn).not.toContain('database.db')
  })
})
