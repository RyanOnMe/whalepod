/**
 * P1-18 六原语 harness 自证（05 §4 P1-18 验收标准）。
 *
 * 「故意打断任一层，verify 必须 FAIL 并指明 Hub、Node、Runtime 或 Browser」
 * 的机器证据：对每一层注入故障跑一次 drive→verify，断言 FAIL 且归因层正确；
 * 绿链（standard 场景全主链）断言 PASS。判定只看证据事实，注入参数不参与
 * 判定（verify 对 fault 字段只透传展示，见 verify.ts）。
 *
 * 另含 CLI 三入口的子进程冒烟：证明 scripts/phase1-{drive,verify,evidence}.mts
 * 作为独立可复跑入口成立（自起一次性 PG → 采集 → 判定 → 出包过 secret-scan）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { createTestDatabase } from '../../apps/hub/tests/helpers.js'
import { drivePhase1 } from '../lib/phase1/drive.js'
import { verifyEvidence } from '../lib/phase1/verify.js'
import { evidenceRoot } from '../lib/phase1/evidence.js'
import { writeSyntheticGreenEvidence } from './phase1-synthetic.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const attemptDirs: string[] = []

function newAttemptDir(name: string): string {
  const dir = join(
    evidenceRoot(),
    `phase1-selftest-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  attemptDirs.push(dir)
  return dir
}

describe('P1-18 harness 自证（六原语：drive/observe/assert/localize/evidence/discover）', () => {
  let database: Database

  beforeAll(async () => {
    database = await createTestDatabase()
  }, 180_000)

  afterAll(async () => {
    await database.close()
    for (const dir of attemptDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('绿链 standard：Task→Run→Approval→Artifact→Reviewer 全主链，verify PASS（归因为空）', async () => {
    const dir = newAttemptDir('standard-green')
    const result = await drivePhase1({
      scenario: 'standard',
      fault: 'none',
      attemptDir: dir,
      database,
    })
    expect(result.captured, `drive 采集失败：${result.error ?? ''}`).toBe(true)
    expect(result.runIds.length).toBe(2) // builder + reviewer

    const verdict = verifyEvidence(dir)
    const failed = verdict.checks.filter((c) => !c.pass)
    expect(
      verdict.pass,
      `verify 应 PASS；失败项：${failed.map((c) => `${c.id}(${c.detail})`).join('; ')}`,
    ).toBe(true)
    expect(verdict.attribution).toBeUndefined()
    // 六原语的观测纪律在绿链上成立：四层 component 都在案。
    expect(verdict.checks.find((c) => c.id === 'observe-layer-coverage')?.pass).toBe(true)
    // 跨层索引：run 在 runtime/node/hub/browser 四层都有证据。
    expect(verdict.checks.find((c) => c.id === 'index.cross-layer')?.pass).toBe(true)
  }, 300_000)

  it.each([
    ['hub', 'Hub'],
    ['node', 'Node'],
    ['runtime', 'Runtime'],
    ['browser', 'Browser'],
  ] as const)(
    '断层自证：打断 %s 层 → verify FAIL 且归因 %s',
    async (fault, layer) => {
      const dir = newAttemptDir(`fault-${fault}`)
      const result = await drivePhase1({
        scenario: 'minimal',
        fault,
        attemptDir: dir,
        database,
      })
      // drive 的职责是采集：即使链路被打断，采集本身必须完整（判定是 verify 的事）。
      expect(result.captured, `drive 采集失败：${result.error ?? ''}`).toBe(true)

      const verdict = verifyEvidence(dir)
      expect(verdict.pass, `打断 ${fault} 后 verify 必须 FAIL`).toBe(false)
      expect(verdict.attribution, 'FAIL 必须带归因').toBeDefined()
      expect(verdict.attribution?.layer, `打断 ${fault} 必须归因到 ${layer}`).toBe(layer)
      expect(verdict.attribution?.evidence.length).toBeGreaterThan(0)
    },
    240_000,
  )

  it('断层自证硬度：fault=browser 时链路其余部分跑到终态（Hub 侧 completed，排除等待窗误判）', async () => {
    // 归因树只有在 Hub 已落库 completed 的前提下才把缺失判给 Browser；
    // 若 drive 的等待窗先于终态收口，会被误判成 Node——这里钉死终态必达。
    const dir = newAttemptDir('fault-browser-terminal')
    const result = await drivePhase1({
      scenario: 'minimal',
      fault: 'browser',
      attemptDir: dir,
      database,
    })
    expect(result.captured, `drive 采集失败：${result.error ?? ''}`).toBe(true)
    const snapshot = JSON.parse(readFileSync(join(dir, 'db-snapshot.json'), 'utf8')) as {
      runs: Array<{ id: string; status: string }>
    }
    const run = snapshot.runs.find((r) => r.id === result.runIds[0])
    expect(run?.status, 'fault=browser 时 run 必须在 Hub 侧到达 completed').toBe('completed')
  }, 240_000)

  it('secrets 场景端到端：drive→verify PASS（§6.4 corpus 判定分支）', async () => {
    const dir = newAttemptDir('secrets-green')
    const result = await drivePhase1({
      scenario: 'secrets',
      fault: 'none',
      attemptDir: dir,
      database,
    })
    expect(result.captured, `drive 采集失败：${result.error ?? ''}`).toBe(true)
    const verdict = verifyEvidence(dir)
    const failed = verdict.checks.filter((c) => !c.pass)
    expect(
      verdict.pass,
      `verify 应 PASS；失败项：${failed.map((c) => `${c.id}(${c.detail})`).join('; ')}`,
    ).toBe(true)
    expect(verdict.checks.find((c) => c.id === 'Q7.corpus-absent')?.pass).toBe(true)
    expect(verdict.checks.find((c) => c.id === 'Q7.redaction-markers')?.pass).toBe(true)
  }, 180_000)

  it('判定硬度：绿链证据里单次瞬时探活失败不误判 Hub（合成证据）', () => {
    // 重负载 spawn 抖动可能让一次探活超时——归因只认「末尾连续失败」，
    // 不认「曾经失败过」，否则这是 harness 未来最主要的偶发红来源。
    const dir = newAttemptDir('synthetic-transient-probe')
    writeSyntheticGreenEvidence(dir, {
      runId: randomUUID(),
      probes: [true, true, false, true, true],
    })
    const verdict = verifyEvidence(dir)
    const failed = verdict.checks.filter((c) => !c.pass)
    expect(
      verdict.pass,
      `单次瞬时探活失败不得改变绿链判定；失败项：${failed.map((c) => `${c.id}(${c.detail})`).join('; ')}；归因=${verdict.attribution?.layer ?? '无'}`,
    ).toBe(true)
    expect(verdict.attribution).toBeUndefined()
  })

  it('判定硬度：末尾连续探活失败仍归因 Hub（合成证据）', () => {
    const dir = newAttemptDir('synthetic-hub-down')
    writeSyntheticGreenEvidence(dir, { runId: randomUUID(), probes: [true, false, false, false] })
    const verdict = verifyEvidence(dir)
    expect(verdict.pass, 'Hub 探活末尾连续失败必须 FAIL').toBe(false)
    expect(verdict.attribution?.layer).toBe('Hub')
  })

  it('判定硬度：Hub 观测覆盖必须来自真实 hub.* 事件，harness.* 不充数（合成证据）', () => {
    // observe-layer-coverage 的「Hub 在案」不能靠 harness 自身事件满足，
    // 否则对 Hub 观测面不独立有力。
    const dir = newAttemptDir('synthetic-no-hub-events')
    writeSyntheticGreenEvidence(dir, {
      runId: randomUUID(),
      probes: [true, true, true],
      stripHubEvents: true,
    })
    const verdict = verifyEvidence(dir)
    const coverage = verdict.checks.find((c) => c.id === 'observe-layer-coverage')
    expect(
      coverage?.pass,
      `剔除 hub.* 事件后 Hub 层覆盖必须判负（实际 detail：${coverage?.detail ?? '检查缺失'}）`,
    ).toBe(false)
  })

  it('CLI 冒烟：phase1-drive → verify → evidence 三入口独立复跑，出包过 secret-scan', async () => {
    const tsx = (args: string[]): { stdout: string; code: number } => {
      try {
        return {
          stdout: execFileSync('pnpm', ['exec', 'tsx', ...args], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 600_000,
          }),
          code: 0,
        }
      } catch (error) {
        const err = error as { status?: number; stdout?: Buffer | string }
        return { stdout: String(err.stdout ?? ''), code: err.status ?? 1 }
      }
    }

    const drive = tsx(['scripts/phase1-drive.mts', '--scenario', 'minimal'])
    expect(drive.code, `drive CLI 失败：${drive.stdout}`).toBe(0)
    // stdout 契约：唯一一行 = 证据目录。
    const dir = drive.stdout.trim().split('\n').pop()
    expect(dir, 'drive CLI stdout 必须是证据目录').toBeDefined()
    expect(dir?.startsWith(evidenceRoot())).toBe(true)

    const verify = tsx(['scripts/phase1-verify.mts', '--evidence', dir as string])
    expect(verify.code, `verify CLI 应 PASS：${verify.stdout}`).toBe(0)
    expect(verify.stdout).toContain('PASS phase1')

    const pack = tsx(['scripts/phase1-evidence.mts', '--evidence', dir as string])
    expect(pack.code, `evidence CLI 失败：${pack.stdout}`).toBe(0)
    expect(pack.stdout).toContain('"secretScan": "PASS"')
  }, 700_000)
})
