import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const vendor = new URL('../src/vendor/react-bits-micro/', import.meta.url)
const licenseHash = 'f4c33af6739191537738662d223b68d77bc226f4b57ea883e16481d8cc5c73c9'

describe('#306 第三方来源与许可', () => {
  it('完整保留固定上游许可，不能静默改标纯 MIT / Apache-2.0', () => {
    const license = readFileSync(new URL('LICENSE.md', vendor))
    expect(createHash('sha256').update(license).digest('hex')).toBe(licenseHash)
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', vendor), 'utf8')) as {
      revision: string
      license: string
      licenseSha256: string
      files: Array<{ local: string; upstreamPath: string; originalSha256: string; changes: string }>
    }
    expect(manifest.revision).toBe('d86fccbd477786f94ca7eb891fbe0ec039d3cd3b')
    expect(manifest.license).toBe('MIT + Commons Clause License Condition v1.0')
    expect(manifest.licenseSha256).toBe(licenseHash)
    expect(manifest.files.map((file) => file.local).sort()).toEqual([
      'CallChip.css',
      'CallChip.tsx',
      'StatusMark.css',
      'StatusMark.tsx',
    ])
    for (const file of manifest.files) {
      expect(file.originalSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.upstreamPath).toContain('src/ts-default/Micro/')
      expect(file.changes.length).toBeGreaterThan(30)
      expect(readFileSync(new URL(file.local, vendor), 'utf8')).toContain('React Bits')
    }
    const notice = readFileSync(new URL('../../../NOTICE', import.meta.url), 'utf8')
    expect(notice).toContain('Copyright (c) 2026 David Haz')
    expect(notice).toContain("rather\nthan WhalePod's Apache-2.0 license")
  })
})
