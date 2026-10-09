/**
 * tests/ typecheck 基线的机检（#183 的「禁新增」）：见 scripts/lib/typecheck-test-baseline.ts。
 *
 * 为什么放进 Q0（unit project）：它不需要 PG/Docker，两条 tsc 各约 1.5s；放进最常跑的
 * 门里，才可能在「顺手加了个测试」的那一刻拦住新增错误——而不是等到某个 release 前。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TEST_TYPECHECK_BASELINE,
  type TestTypecheckBaselineEntry,
} from '../lib/typecheck-test-baseline.js'
import { TYPECHECK_WIRING_DEFERRED } from '../check-boundaries.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 跑一次该包的 tests typecheck，返回 `error TS` 行数与原始输出（失败时给人看）。 */
export function countTestTypecheckErrors(where: string): { count: number; output: string } {
  const cwd = join(REPO_ROOT, where)
  let output = ''
  try {
    output = execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // tsc 有错误时退出码非零——错误就在 stdout/stderr 里，不是执行失败。
    const anyError = error as { stdout?: string; stderr?: string }
    output = `${anyError.stdout ?? ''}${anyError.stderr ?? ''}`
  }
  const count = output.split('\n').filter((line) => line.includes('error TS')).length
  return { count, output }
}

describe('tests/ typecheck 基线（#183 禁新增）', () => {
  it('基线表与 check-boundaries 的未接线表一一对应（两处登记不许漂）', () => {
    const baselineKeys = TEST_TYPECHECK_BASELINE.map((entry) => entry.where).sort()
    const deferredKeys = [...TYPECHECK_WIRING_DEFERRED.keys()].sort()
    expect(
      baselineKeys,
      'TEST_TYPECHECK_BASELINE 与 TYPECHECK_WIRING_DEFERRED 的键必须一致：接线一片 = 两处同时删',
    ).toEqual(deferredKeys)
  })

  it('每个未接线包的存量错误数不高于基线（只许向下）', () => {
    const offenders: string[] = []
    for (const entry of TEST_TYPECHECK_BASELINE) {
      if (!existsSync(join(REPO_ROOT, entry.where, 'tsconfig.test.json'))) {
        offenders.push(`${entry.where}: 缺 tsconfig.test.json（基线无从测量）`)
        continue
      }
      const { count, output } = countTestTypecheckErrors(entry.where)
      if (count > entry.errors) {
        offenders.push(
          `${entry.where}: ${count} > 基线 ${entry.errors}（${entry.issue} 未清完，新增错误必须先修）\n` +
            output
              .split('\n')
              .filter((line) => line.includes('error TS'))
              .slice(0, 10)
              .join('\n'),
        )
      } else if (count < entry.errors) {
        offenders.push(
          `${entry.where}: ${count} < 基线 ${entry.errors}——修少了是好事，但请把 ` +
            'scripts/lib/typecheck-test-baseline.ts 的数字改小（棘轮只许向下，不许留余量）',
        )
      }
    }
    expect(offenders, offenders.join('\n\n')).toEqual([])
  }, 120_000)
})
