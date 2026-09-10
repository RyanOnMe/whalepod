/**
 * plugin-api schema 单测（P1-17 Hub 侧 HTTP 面的协议契约）。
 * 重点：DTO 严格模式（多字段拒绝）、精确 version/uuid/枚举约束、
 * descriptor 形态与 manifest/lockfile 组合。
 */
import { describe, expect, it } from 'vitest'
import type { PluginManifest } from './src/plugin-manifest.js'
import {
  PluginCatalogEntryViewSchema,
  PluginInstallRequestSchema,
  PluginInstallationViewSchema,
  PluginPackCreateRequestSchema,
  PluginPackDescriptorSchema,
  PluginPackViewSchema,
} from '../src/plugin-api.js'

const VALID_MANIFEST: PluginManifest = {
  schemaVersion: 1,
  name: 'wp-fixed-time',
  version: '0.1.0',
  tarballUrl: 'https://catalog.fixtures.whalepod.test/tarballs/wp-fixed-time-0.1.0.tgz',
  integrity: 'sha256-' + 'A'.repeat(43) + '=',
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

const UUID_A = '018f0000-0000-7000-8000-000000000001'
const UUID_B = '018f0000-0000-7000-8000-000000000002'

const VALID_INSTALLATION = {
  id: UUID_A,
  packageName: 'wp-fixed-time',
  packageVersion: '0.1.0',
  integrity: 'sha256-' + 'A'.repeat(43) + '=',
  dependencyLockDigest: 'a'.repeat(64),
  trust: 'curated',
  capabilityClass: 'declared',
  capabilities: ['workspace.read'],
  status: 'installed',
  installedBy: UUID_B,
  createdAt: '2026-08-28T00:00:00.000Z',
} as const

describe('PluginInstallRequestSchema', () => {
  it('接受 catalog 内精确版本', () => {
    expect(PluginInstallRequestSchema.parse({ name: 'wp-fixed-time', version: '0.1.0' })).toEqual({
      name: 'wp-fixed-time',
      version: '0.1.0',
    })
  })

  it('拒绝 version range/tag 与多余字段', () => {
    expect(() =>
      PluginInstallRequestSchema.parse({ name: 'wp-fixed-time', version: '^0.1.0' }),
    ).toThrow()
    expect(() =>
      PluginInstallRequestSchema.parse({ name: 'wp-fixed-time', version: 'latest' }),
    ).toThrow()
    expect(() =>
      PluginInstallRequestSchema.parse({ name: 'wp-fixed-time', version: '0.1.0', extra: 1 }),
    ).toThrow()
  })
})

describe('PluginInstallationViewSchema', () => {
  it('接受安装行视图', () => {
    expect(PluginInstallationViewSchema.parse(VALID_INSTALLATION)).toEqual(VALID_INSTALLATION)
  })

  it('拒绝未知 trust/status 与坏 uuid', () => {
    expect(() =>
      PluginInstallationViewSchema.parse({ ...VALID_INSTALLATION, trust: 'unknown' }),
    ).toThrow()
    expect(() =>
      PluginInstallationViewSchema.parse({ ...VALID_INSTALLATION, status: 'zombie' }),
    ).toThrow()
    expect(() =>
      PluginInstallationViewSchema.parse({ ...VALID_INSTALLATION, id: 'not-a-uuid' }),
    ).toThrow()
  })
})

describe('PluginPackViewSchema / PluginPackCreateRequestSchema', () => {
  const installation = PluginInstallationViewSchema.parse(VALID_INSTALLATION)
  const entry = {
    name: 'wp-fixed-time',
    version: '0.1.0',
    integrity: 'sha256-' + 'A'.repeat(43) + '=',
    dependencyLockDigest: 'a'.repeat(64),
    entrypoint: 'dist/index.js',
    configDigest: 'c'.repeat(64),
  }

  it('接受含展开 entries 的 Pack 视图', () => {
    const view = {
      id: UUID_B,
      name: 'curated-base',
      packDigest: 'd'.repeat(64),
      installations: [UUID_A],
      entries: [{ entry, installation }],
      createdBy: UUID_B,
      createdAt: '2026-08-28T00:00:00.000Z',
    }
    expect(PluginPackViewSchema.parse(view)).toEqual(view)
  })

  it('Pack 视图拒绝坏 digest 形态', () => {
    expect(() =>
      PluginPackViewSchema.parse({
        id: UUID_B,
        name: 'curated-base',
        packDigest: 'zz'.repeat(32),
        installations: [],
        entries: [],
        createdBy: UUID_B,
        createdAt: '2026-08-28T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('创建请求要求非空 uuid 数组', () => {
    expect(PluginPackCreateRequestSchema.parse({ name: 'p', installationIds: [UUID_A] })).toEqual({
      name: 'p',
      installationIds: [UUID_A],
    })
    expect(() => PluginPackCreateRequestSchema.parse({ name: 'p', installationIds: [] })).toThrow()
    expect(() =>
      PluginPackCreateRequestSchema.parse({ name: 'p', installationIds: ['nope'] }),
    ).toThrow()
  })
})

describe('PluginPackDescriptorSchema', () => {
  it('接受 manifest + lockfile 原文的组合', () => {
    const descriptor = {
      schemaVersion: 1,
      packDigest: 'd'.repeat(64),
      name: 'curated-base',
      packages: [{ manifest: VALID_MANIFEST, lockfile: 'schemaVersion: 1\ndependencies: []\n' }],
    }
    expect(PluginPackDescriptorSchema.parse(descriptor)).toEqual(descriptor)
  })

  it('拒绝空 lockfile、坏 packDigest 与多余字段', () => {
    const base = {
      schemaVersion: 1,
      packDigest: 'd'.repeat(64),
      name: 'curated-base',
      packages: [{ manifest: VALID_MANIFEST, lockfile: 'x' }],
    }
    expect(() => PluginPackDescriptorSchema.parse({ ...base, schemaVersion: 2 })).toThrow()
    expect(() =>
      PluginPackDescriptorSchema.parse({
        ...base,
        packages: [{ manifest: VALID_MANIFEST, lockfile: '' }],
      }),
    ).toThrow()
    expect(() => PluginPackDescriptorSchema.parse({ ...base, unexpected: true })).toThrow()
  })
})

describe('PluginCatalogEntryViewSchema', () => {
  it('与 PluginManifest 同构（manifest 全字段即审核摘要）', () => {
    expect(PluginCatalogEntryViewSchema.parse(VALID_MANIFEST)).toEqual(VALID_MANIFEST)
    expect(() => PluginCatalogEntryViewSchema.parse({ ...VALID_MANIFEST, license: '' })).toThrow()
  })
})
