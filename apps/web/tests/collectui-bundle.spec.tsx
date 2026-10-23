import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as bundle from '../src/vendor/collectui/collectui.js'

const directory = join(import.meta.dirname, '../src/vendor/collectui')
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
  license: string
  compiler: { minify: boolean; sourceMap: boolean }
  exports: string[]
  sources: Array<{ item: string; url: string; capturedExcerptSha256: string }>
  files: Array<{ name: string; sha256: string; bytes: number }>
}

describe('P1-421 restricted presentation distribution', () => {
  it('only ships the compiled assets, owned declaration and provenance; no editable originals/maps', () => {
    expect(readdirSync(directory).sort()).toEqual([
      'LICENSE.md',
      'README.md',
      'collectui.css',
      'collectui.d.ts',
      'collectui.js',
      'manifest.json',
    ])
    expect(manifest.compiler).toMatchObject({ minify: true, sourceMap: false })
    expect(manifest.license).toBe('LicenseRef-CollectUI-Restricted')
    expect(readFileSync(join(directory, 'LICENSE.md'), 'utf8')).toContain('not licensed under')
  })

  it('loads the declared exports and detects any changed or missing compiled asset', () => {
    expect(Object.keys(bundle).sort()).toEqual(manifest.exports.toSorted())
    expect(manifest.files.map((file) => file.name).sort()).toEqual([
      'collectui.css',
      'collectui.js',
    ])
    for (const file of manifest.files) {
      const bytes = readFileSync(join(directory, file.name))
      expect(bytes.byteLength).toBe(file.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
      expect(bytes.toString()).not.toMatch(/sourceMappingURL|sourcesContent|artifacts\/private-ui/)
      expect(bytes.toString()).toContain('Copyright (c) 2026 React Bits Pro')
    }
  })

  it('records all nine upstream items without serializing raw excerpts or demo/network behavior', () => {
    expect(manifest.sources.map((source) => source.item).sort()).toEqual([
      'agent-activity-3',
      'agent-approval-1',
      'ai-chat-2',
      'app-dialog-6',
      'app-sidebar-4',
      'command-menu-1',
      'empty-state-1',
      'prompt-input-2',
      'tool-calls-2',
    ])
    for (const source of manifest.sources) {
      expect(source.url).toMatch(/^https:\/\/bits\.collectui\.pro\/docs\/app-ui\//)
      expect(source.capturedExcerptSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(source).not.toHaveProperty('excerpt')
    }
    expect(readFileSync(join(directory, 'collectui.js'), 'utf8')).not.toMatch(
      /fetch\(|WebSocket|localStorage|setTimeout|FAKE-|REACTBITS_LICENSE_KEY|MAX_TOKENS|useSmoothedText/,
    )
  })
})
