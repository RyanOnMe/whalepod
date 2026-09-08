/**
 * Q8 短档**判定数学**的门卫（load-test 的核心判据必须能被红样证伪，
 * 与 secret-scan --self-test / license-check 红样同理）。
 * 真负载跑在 scripts/load-test.mts（环境闸内），这里钉的是"尺子本身准"。
 */
import { describe, expect, it } from 'vitest'
import {
  assessEnvironment,
  finalVerdict,
  p95,
  regressionSlope,
  verdictLoadSample,
} from '../lib/phase1/load.js'

describe('p95', () => {
  it('样本不足必红（30 份是 Q8 短档下限，缺数据不得外推）', () => {
    expect(() => p95(Array.from({ length: 29 }, (_, i) => i))).toThrow(/样本不足/)
    expect(p95(Array.from({ length: 30 }, (_, i) => i)).value).toBeCloseTo(28) // ceil(0.95*30)-1
  })
  it('排序无关（同多重集乱序同结果）且取真实元素不插值', () => {
    const base = Array.from({ length: 100 }, (_, i) => i)
    const a = p95(base)
    const b = p95([...base].sort(() => 0.5 - Math.random()))
    expect(a.value).toBe(b.value)
    expect(a.value).toBe(94) // 最近秩 ceil(0.95*100)-1 ⟹ 第 95 小的真实元素，非插值
  })
})

describe('OLS 斜率（RSS 增长判据的尺）', () => {
  it('平坦序列斜率≈0；线性增长斜率=真值', () => {
    expect(
      regressionSlope(Array.from({ length: 12 }, () => 100).map((v, i) => ({ x: i, y: v }))).slope,
    ).toBeCloseTo(0)
    const ramp = Array.from({ length: 12 }, (_, i) => ({ x: i, y: 100 + 2 * i }))
    expect(regressionSlope(ramp).slope).toBeCloseTo(2)
  })
  it('点数不足必红', () => {
    expect(() =>
      regressionSlope([
        { x: 0, y: 1 },
        { x: 1, y: 2 },
      ]),
    ).toThrow(/采样/)
  })
})

describe('负载判决（Q8 短档判据，界值各钉双向）', () => {
  const flat = Array.from({ length: 12 }, (_, i) => ({ x: i * 3000, y: 90_000_000 }))
  // 确定性场景生成：n=100 时第 95 小落在 index 94——界值必须钉在 p95 **真会取到**的位置
  // （40 样本时 p95=第 38 小，个别离群点会被吸收——写错的判具比没判具更坏，本行即教训）。
  const prop = (ms: number): number[] => Array.from({ length: 100 }, (_, i) => (i >= 94 ? ms : 100))
  const ing = (ms: number): number[] => Array.from({ length: 100 }, (_, i) => (i >= 94 ? ms : 20))
  it('p95 在阈内 + RSS 平 + live 旁证 ⟹ PASS', () => {
    const v = verdictLoadSample({
      propagation: prop(300),
      ingest: ing(50),
      idleRssSamples: flat,
      liveSamples: 9,
    })
    expect(v.verdict).toBe('PASS')
    expect(v.metrics.propagationP95Ms).toBe(300)
  })
  it('传播 p95=501 ⟹ FAIL；499.9 ⟹ PASS（500 界两侧各钉一发）', () => {
    expect(
      verdictLoadSample({
        propagation: prop(501),
        ingest: ing(50),
        idleRssSamples: flat,
        liveSamples: 9,
      }).failures.join(),
    ).toContain('传播')
    expect(
      verdictLoadSample({
        propagation: prop(499.9),
        ingest: ing(50),
        idleRssSamples: flat,
        liveSamples: 9,
      }).verdict,
    ).toBe('PASS')
    // 平界钉死：p95 恰 500.0 也红（判据 >= 界即 FAIL，保守侧，一审 nit）。
    expect(
      verdictLoadSample({
        propagation: prop(500.0),
        ingest: ing(50),
        idleRssSamples: flat,
        liveSamples: 9,
      }).verdict,
    ).toBe('FAIL')
  })
  it('ingest p95=101 ⟹ FAIL', () => {
    expect(
      verdictLoadSample({
        propagation: prop(100),
        ingest: ing(101),
        idleRssSamples: flat,
        liveSamples: 9,
      }).failures.join(),
    ).toContain('ingest')
  })
  it('合成流独自作证 ⟹ FAIL（live 旁证必须 >0：产品链路真跑过的证据）', () => {
    const v = verdictLoadSample({
      propagation: prop(100),
      ingest: ing(20),
      idleRssSamples: flat,
      liveSamples: 0,
    })
    expect(v.verdict).toBe('FAIL')
    expect(v.failures.join()).toContain('live')
  })
  it('空闲段持续正增长（3s +3MiB ≈ 60MiB/min）⟹ FAIL（泄漏的空闲代理）', () => {
    const ramp = Array.from({ length: 12 }, (_, i) => ({
      x: i * 3000,
      y: 90_000_000 + i * 3 * 1024 * 1024,
    }))
    const v = verdictLoadSample({
      propagation: prop(100),
      ingest: ing(20),
      idleRssSamples: ramp,
      liveSamples: 9,
    })
    expect(v.verdict).toBe('FAIL')
    expect(v.failures.join()).toContain('空闲段 RSS 斜率')
  })
  it('斜率平缓但净增 100MiB（台阶式一次性扩张）⟹ FAIL 兜底', () => {
    const step = Array.from({ length: 12 }, (_, i) => ({
      x: i * 3000,
      y: 60_000_000 + (i > 1 ? 100 * 1024 * 1024 : 0),
    }))
    const v = verdictLoadSample({
      propagation: prop(100),
      ingest: ing(20),
      idleRssSamples: step,
      liveSamples: 9,
    })
    expect(v.verdict).toBe('FAIL')
    expect(v.failures.join()).toContain('净增')
  })
  it('任一连接被 4009 踢 = FAIL（样本缺失不得静默缩样）', () => {
    const v = verdictLoadSample({
      propagation: Array.from({ length: 40 }, () => 100),
      ingest: Array.from({ length: 40 }, () => 20),
      idleRssSamples: flat,
      droppedConnections: 1,
    })
    expect(v.verdict).toBe('FAIL')
  })
})

describe('环境闸（04 §8：4 CPU / 8 GiB / Linux / Docker）', () => {
  const ok = { platform: 'linux', cpus: 4, totalMemGiB: 16, docker: true }
  it('满足 ⟹ ELIGIBLE', () => {
    expect(assessEnvironment(ok).eligible).toBe(true)
  })
  it('macOS（本机）⟹ 不合格——开发机数字不得充当发布判据', () => {
    expect(assessEnvironment({ ...ok, platform: 'darwin' }).eligible).toBe(false)
  })
  it('CPU/内存/docker 任一不足 ⟹ 不合格，且逐条给原因（不许笼统）', () => {
    const r = assessEnvironment({ platform: 'linux', cpus: 2, totalMemGiB: 4, docker: false })
    expect(r.eligible).toBe(false)
    expect(r.reasons.length).toBe(3)
  })
})

describe('两级判定（#109 修订：合格环境权威判 / 欠规环境保守判，FAIL 不绿洗）', () => {
  const passV = {
    verdict: 'PASS' as const,
    failures: [],
    metrics: {
      propagationP95Ms: 1,
      ingestP95Ms: 1,
      idleRssSlopeMiBPerMin: 0,
      rssNetGrowthMiB: 0,
      propagationN: 40,
      ingestN: 40,
    },
  }
  const failV = { ...passV, verdict: 'FAIL' as const, failures: ['x'] }
  it('合格环境：PASS⟹0（PASS），FAIL⟹2（FAIL）——权威判不变', () => {
    expect(finalVerdict(true, passV, false)).toEqual({
      code: 0,
      label: expect.stringContaining('PASS'),
    })
    expect(finalVerdict(true, failV, false).code).toBe(2)
  })
  it('欠规环境无 dev-report：PASS⟹0 但标签必须写保守口径（弱机通过≠权威判据）', () => {
    const r = finalVerdict(false, passV, false)
    expect(r.code).toBe(0)
    expect(r.label).toContain('CONSERVATIVE')
  })
  it('欠规环境 FAIL⟹exit 3 INCONCLUSIVE（不许判产品红，也不许绿）', () => {
    const r = finalVerdict(false, failV, false)
    expect(r.code).toBe(3)
    expect(r.label).toContain('INCONCLUSIVE')
  })
  it('dev-report 恒 3（任何结果都不充当判据）', () => {
    expect(finalVerdict(false, passV, true).code).toBe(3)
    expect(finalVerdict(true, passV, true).code).toBe(3)
  })
})
