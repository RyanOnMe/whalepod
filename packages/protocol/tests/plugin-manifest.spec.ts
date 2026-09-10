/**
 * 插件清单 schema 与 pack digest 单测（02 Task 17 Step 1/3/5）。
 *
 * 攻击矩阵（04 §6.5）：version range/tag/git URL/本地路径、非 HTTPS tarball、
 * 坏 SRI、绝对/越界 entrypoint、未声明 review 状态——一律拒绝。
 * digest：packages 顺序无关、字段缺省即漂移。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ExactVersionSchema,
  PluginManifestSchema,
  trustForReviewStatus,
  type PluginManifest,
} from '../src/plugin-manifest.js'
import { canonicalJson, compareCodePoints, digestPluginPack } from '../src/plugin-pack-digest.js'

const VALID_MANIFEST: PluginManifest = {
  schemaVersion: 1,
  name: '@whalepod/wp-fixed-time',
  version: '0.1.0',
  tarballUrl: 'https://registry.npmjs.org/@whalepod/wp-fixed-time/-/wp-fixed-time-0.1.0.tgz',
  integrity: 'sha512-' + 'A'.repeat(86) + '==',
  dependencyLockDigest: 'a'.repeat(64),
  dshCompatibility: '0.1.0-rc.8',
  entrypoint: 'dist/index.js',
  capabilities: ['workspace.read'],
  capabilityClass: 'declared',
  license: 'MIT',
  review: {
    status: 'reviewed',
    commit: 'b'.repeat(40),
    at: '2026-08-28T00:00:00.000Z',
  },
}

describe('PluginManifestSchema', () => {
  it('接受合法清单', () => {
    expect(PluginManifestSchema.parse(VALID_MANIFEST)).toEqual(VALID_MANIFEST)
  })

  it.each(['latest', '^1.2.0', '~1.2.0', '>=1.0.0', 'github:user/repo', 'file:../x', '1.2'])(
    '拒绝非不可变来源/版本: %s',
    (version) => {
      expect(ExactVersionSchema.safeParse(version).success).toBe(false)
      expect(PluginManifestSchema.safeParse({ ...VALID_MANIFEST, version }).success).toBe(false)
    },
  )

  it('拒绝非 HTTPS tarball 与坏 SRI', () => {
    expect(
      PluginManifestSchema.safeParse({
        ...VALID_MANIFEST,
        tarballUrl: 'http://registry.npmjs.org/x.tgz',
      }).success,
    ).toBe(false)
    expect(
      PluginManifestSchema.safeParse({ ...VALID_MANIFEST, integrity: 'md5-deadbeef' }).success,
    ).toBe(false)
  })

  it('拒绝绝对路径与 .. 越界 entrypoint', () => {
    for (const entrypoint of ['/etc/passwd', '../escape.js', 'a/../../b.js']) {
      expect(PluginManifestSchema.safeParse({ ...VALID_MANIFEST, entrypoint }).success).toBe(false)
    }
  })

  it('拒绝未知 review 状态与附加字段（strictObject）', () => {
    expect(
      PluginManifestSchema.safeParse({
        ...VALID_MANIFEST,
        review: { ...VALID_MANIFEST.review, status: 'whatever' },
      }).success,
    ).toBe(false)
    expect(PluginManifestSchema.safeParse({ ...VALID_MANIFEST, extra: true }).success).toBe(false)
  })

  it('review 状态 → trust 映射：reviewed→curated，其余→unreviewed', () => {
    expect(trustForReviewStatus('reviewed')).toBe('curated')
    expect(trustForReviewStatus('unreviewed')).toBe('unreviewed')
    expect(trustForReviewStatus('local-development')).toBe('unreviewed')
  })
})

describe('digestPluginPack', () => {
  const entryA = {
    name: 'a-pkg',
    version: '1.0.0',
    integrity: 'sha256-' + 'C'.repeat(43) + '=',
    dependencyLockDigest: 'd'.repeat(64),
    entrypoint: 'index.js',
    configDigest: 'e'.repeat(64),
  }
  const entryB = {
    name: 'b-pkg',
    version: '2.0.0',
    integrity: 'sha256-' + 'D'.repeat(43) + '=',
    dependencyLockDigest: 'f'.repeat(64),
    entrypoint: 'main.js',
    configDigest: '0'.repeat(64),
  }

  it('packages 顺序无关（按 name 排序规范化）', () => {
    const d1 = digestPluginPack({ schemaVersion: 1, packages: [entryA, entryB] })
    const d2 = digestPluginPack({ schemaVersion: 1, packages: [entryB, entryA] })
    expect(d1).toBe(d2)
    expect(d1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('任一固定字段变化即漂移（含 configDigest）', () => {
    const base = digestPluginPack({ schemaVersion: 1, packages: [entryA] })
    expect(
      digestPluginPack({ schemaVersion: 1, packages: [{ ...entryA, version: '1.0.1' }] }),
    ).not.toBe(base)
    expect(
      digestPluginPack({
        schemaVersion: 1,
        packages: [{ ...entryA, configDigest: '1'.repeat(64) }],
      }),
    ).not.toBe(base)
    expect(
      digestPluginPack({
        schemaVersion: 1,
        packages: [{ ...entryA, dependencyLockDigest: '2'.repeat(64) }],
      }),
    ).not.toBe(base)
  })

  it('非法输入直接抛（schema 把关）', () => {
    expect(() =>
      digestPluginPack({ schemaVersion: 1, packages: [{ ...entryA, version: 'latest' }] }),
    ).toThrow()
  })

  it('canonicalJson 键序确定', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 3], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,3]},"b":1}',
    )
  })

  it('规范化排序是码点序而非 locale 序（ICU 无关，跨环境复算一致）', () => {
    // ICU localeCompare 会把 'a_b' 排在 'a-b' 前（标点折叠）；码点序相反
    // （'-'=0x2d < '_'=0x5f）。digest 是内容纯函数，不能依赖 ICU 排序表。
    const dash = { ...entryA, name: 'a-b' }
    const underscore = { ...entryB, name: 'a_b' }
    expect(compareCodePoints('a-b', 'a_b')).toBe(-1)
    expect('a_b'.localeCompare('a-b')).toBe(-1) // 确认两序在此输入上确实分歧
    const expected = canonicalJson({
      schemaVersion: 1,
      packages: [dash, underscore], // 码点序：dash 在前
    })
    expect(digestPluginPack({ schemaVersion: 1, packages: [underscore, dash] })).toBe(
      createHash('sha256').update(expected).digest('hex'),
    )
  })

  it('同名包多版本 fail-closed（digest 必须是内容纯函数）', () => {
    expect(() =>
      digestPluginPack({
        schemaVersion: 1,
        packages: [entryA, { ...entryA, version: '2.0.0' }],
      }),
    ).toThrow(/duplicate package name/)
  })
})

// ---------- plugin-runtime-config：Cordis entry 生成与 configDigest ----------
describe('pluginCordisEntry + digestPluginCordisEntry', async () => {
  const { pluginCordisEntry, cordisEntryId } = await import('../src/plugin-runtime-config.js')
  const { digestPluginCordisEntry } = await import('../src/plugin-pack-digest.js')

  const base = { name: 'whalepod-fixed-time', version: '0.1.0', entrypoint: 'index.js' }

  it('generates a deterministic entry with empty config', () => {
    expect(pluginCordisEntry(base)).toEqual({
      schemaVersion: 1,
      id: 'whalepod-fixed-time',
      name: 'whalepod-fixed-time',
      version: '0.1.0',
      entrypoint: 'index.js',
      config: {},
    })
  })

  it('maps scoped names to fs-safe ids', () => {
    expect(cordisEntryId('@acme/tools')).toBe('acme--tools')
  })

  it('digest is stable and drift-sensitive', () => {
    const digest = digestPluginCordisEntry(pluginCordisEntry(base))
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digestPluginCordisEntry(pluginCordisEntry(base))).toBe(digest)
    expect(digestPluginCordisEntry(pluginCordisEntry({ ...base, entrypoint: 'main.js' }))).not.toBe(
      digest,
    )
  })
})
