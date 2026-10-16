/**
 * DSH 版本锁三方漂移检查（02 Task 11 Step 3，Q3 门的一部分）：
 * dsh.lock.json ↔ pnpm catalog（pnpm-workspace.yaml）↔ pnpm-lock.yaml
 * 三处的版本与 tarball integrity 必须一致；catalog 只允许精确版本；runtime-dsh
 * 只允许 `catalog:` 引用。判定实现见 `helpers/lock-drift.ts`（#290 起与回滚演练
 * **共用同一份**：演练在临时副本上跑同一套检查，不复制逻辑）。
 *
 * 本文件只保留：清单形态断言（schemaVersion/verifiedAt/八项 requiredContracts/
 * 十项直接依赖）+ 把检查结果压成断言。
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkDshLockDrift, readDshLockState } from './helpers/lock-drift.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const REQUIRED_CONTRACTS = [
  'agents.create',
  'agent.followup',
  'agent.cancel',
  'agent.whenIdle',
  'session.event',
  'approval.request',
  'tools.register',
  'sessions.flush',
]

describe('dsh.lock.json drift guard', () => {
  const state = readDshLockState(REPO_ROOT)
  const findings = checkDshLockDrift(state)

  it('declares schemaVersion 1, verifiedAt, and the eight required contracts', () => {
    expect(state.manifest.schemaVersion).toBe(1)
    expect(state.manifest.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect([...state.manifest.requiredContracts].sort()).toEqual([...REQUIRED_CONTRACTS].sort())
  })

  it('pins exactly the ten DSH direct dependencies', () => {
    expect(Object.keys(state.manifest.packages).sort()).toEqual(
      [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-app-boot',
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-replay',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-user-approval',
      ].sort(),
    )
  })

  it('three-way consistency holds (lock ↔ catalog ↔ pnpm-lock): no drift findings', () => {
    expect(findings).toEqual([])
  })

  it.each(Object.keys(readDshLockState(REPO_ROOT).manifest.packages))(
    '%s: lock manifest == catalog == pnpm lockfile (version + integrity)',
    (name) => {
      expect(findings.filter((finding) => finding.package === name)).toEqual([])
    },
  )
})
