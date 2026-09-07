/**
 * license-check 判定力自检（#24 gate 自身的六原语·判定半边）：
 * 门的逻辑必须能被红样证伪——与 secret-scan --self-test 同理。
 */
import { describe, expect, it } from 'vitest'
import { evaluateLicenses, type AcceptedEntry } from '../license-check.mts'

const base: LicenseInput2 = {
  MIT: [{ name: 'left-pad' }],
  'Apache-2.0': [{ name: 'some-asl' }],
}
type LicenseInput2 = Parameters<typeof evaluateLicenses>[0]

const libvips: AcceptedEntry = {
  package: '@img/sharp-libvips-*',
  license: 'LGPL-3.0-or-later',
  via: 'runtime-dsh → dsh → sharp',
  rationale: '未修改二进制动态链接',
}

describe('license-check 判定', () => {
  it('允许面直接放行：MIT/Apache/MPL-2.0/Python-2.0 零违规', () => {
    const { violations } = evaluateLicenses(
      { ...base, 'MPL-2.0': [{ name: 'lightningcss' }], 'Python-2.0': [{ name: 'argparse' }] },
      [libvips],
    )
    expect(violations).toEqual([])
  })

  it('红样①：AGPL 无白名单 ⟹ 违规（禁 copyleft 的立门本意）', () => {
    const { violations } = evaluateLicenses({ 'AGPL-3.0-or-later': [{ name: 'viral' }] }, [libvips])
    expect(violations.some((v) => v.includes('viral') && v.includes('AGPL'))).toBe(true)
  })

  it('红样②：UNKNOWN ⟹ 违规（许可不明=不可分发）', () => {
    const { violations } = evaluateLicenses({ UNKNOWN: [{ name: 'mystery' }] }, [libvips])
    expect(violations.some((v) => v.includes('mystery'))).toBe(true)
  })

  it('红样③：LGPL 前缀通配放行平台变体；未入名单的 LGPL 独立组件仍红', () => {
    const ok = evaluateLicenses(
      { 'LGPL-3.0-or-later': [{ name: '@img/sharp-libvips-linux-x64' }] },
      [libvips],
    )
    expect(ok.violations).toEqual([])
    const bad = evaluateLicenses({ 'LGPL-3.0-or-later': [{ name: 'some-other-lib' }] }, [libvips])
    expect(bad.violations.length).toBe(1)
  })

  it('红样④：白名单裸条目（缺 via/rationale）自身违规——白名单不是免检通道', () => {
    const { violations } = evaluateLicenses(base, [
      { package: 'sneaky', license: 'AGPL-3.0', via: '', rationale: '' },
    ])
    expect(violations.some((v) => v.includes('sneaky') && v.includes('裸放行'))).toBe(true)
  })
})
