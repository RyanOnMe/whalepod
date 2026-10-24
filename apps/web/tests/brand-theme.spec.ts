/** #437: approved WhalePod brand identity is application-owned; upstream tokens stay verifiable. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTROL_PRIMARY_FILL_TOKEN,
  CONTROL_PRIMARY_HOVER_TOKEN,
  CONTROL_PRIMARY_LABEL_TOKEN,
} from '../src/shared/control-style-tokens.js'
import { contrastRatio, parseCssColor } from './contrast.js'

const styles = join(import.meta.dirname, '../src/styles')
const app = readFileSync(join(styles, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const upstream = readFileSync(join(styles, 'dsw-tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const global = readFileSync(join(styles, 'global.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const block = (text: string, selector: string) =>
  [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]!.trim() === selector)
    .map((match) => match[2]!)
    .join('\n')
const declarations = (text: string) =>
  Object.fromEntries(
    [...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  )
const light = { ...declarations(block(upstream, ':root')), ...declarations(block(app, ':root')) }
const appDark = declarations(block(app, 'body[data-ds-dark-theme]'))
const dark = { ...light, ...declarations(block(upstream, 'body[data-ds-dark-theme]')), ...appDark }
function resolve(name: string, isDark = false): string {
  const tokens = isDark ? dark : light
  const seen = new Set<string>()
  while (true) {
    if (seen.has(name)) throw new Error(`Cyclic theme token: ${name}`)
    seen.add(name)
    const value = tokens[name]
    if (value === undefined) throw new Error(`Missing theme token: ${name}`)
    const target = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)?.[1]
    if (!target) return value
    name = target
  }
}
function declaration(selector: string, property: string) {
  const bodies = [...global.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) =>
      match[1]!
        .trim()
        .split(/\s*,\s*/)
        .includes(selector),
    )
    .map((match) => match[2]!)
  const values = bodies.flatMap((body) =>
    [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))].map((m) =>
      m[1]!.trim(),
    ),
  )
  return values.at(-1)
}
const textPairs = [
  ['--brand-on-primary', '--brand-primary'],
  ['--brand-on-primary', '--brand-primary-hover'],
  ['--brand-link', '--color-surface'],
  ['--brand-link', '--color-paper'],
  ['--brand-selected-ink', '--brand-selected-surface'],
  ['--brand-note-ink', '--brand-note-surface'],
  ['--color-ink', '--color-surface'],
  ['--color-ink-soft', '--color-surface'],
  ['--color-muted', '--color-paper'],
  ['--color-run', '--color-run-soft'],
  ['--color-run', '--color-surface'],
  ['--color-warn', '--color-warn-soft'],
  ['--color-warn', '--color-surface'],
  ['--color-danger', '--color-danger-soft'],
  ['--color-danger-strong', '--color-surface'],
  ['--color-danger-strong', '--dsw-alias-button-floating-hover'],
] as const

describe('P1-437 WhalePod tidal brand', () => {
  it('owns the approved blue/teal without relabeling copied upstream colors', () => {
    expect(parseCssColor(resolve('--brand-primary'))).toMatchObject({ r: 25, g: 91, b: 221, a: 1 })
    expect(parseCssColor(resolve('--brand-teal'))).toMatchObject({ r: 19, g: 184, b: 166, a: 1 })
    expect(declarations(block(upstream, ':root'))['--dsw-static-blue-600']).toBe('rgb(37, 99, 235)')
    expect(declarations(block(upstream, ':root'))['--dsw-alias-brand-primary']).toBe(
      'rgb(15, 17, 21)',
    )
  })

  it('colors actual primary actions, composer, brand mark, current navigation and resource icons', () => {
    expect(CONTROL_PRIMARY_FILL_TOKEN).toBe('--brand-primary')
    expect(CONTROL_PRIMARY_HOVER_TOKEN).toBe('--brand-primary-hover')
    expect(CONTROL_PRIMARY_LABEL_TOKEN).toBe('--brand-on-primary')
    for (const selector of [
      '.button-primary',
      '.workspace-dock .prompt-bar[data-collectui] .instruction-send',
    ])
      expect(declaration(selector, 'background')).toBe('var(--brand-primary)')
    expect(declaration('.app-rail .app-rail-brand', 'color')).toBe('var(--brand-on-primary)')
    expect(declaration(".app-nav a[aria-current='page']", 'background')).toBe(
      'var(--brand-selected-surface)',
    )
    expect(declaration(".app-nav a[aria-current='page']", 'color')).toBe(
      'var(--brand-selected-ink)',
    )
    expect(declaration('.cu-page-resource-icon', 'color')).toBe('var(--brand-selected-ink)')
  })

  for (const isDark of [false, true]) {
    it(`${isDark ? 'dark' : 'light'} text and brand action pairs remain AA`, () => {
      const report: string[] = []
      for (const [fg, bg] of textPairs) {
        const ratio = contrastRatio(
          parseCssColor(resolve(fg, isDark)),
          parseCssColor(resolve(bg, isDark)),
        )
        report.push(`${fg} / ${bg}: ${ratio.toFixed(2)}:1`)
        expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
      console.log(`[P1-437 ${isDark ? 'dark' : 'light'}]\n${report.join('\n')}`)
    })
  }

  it('provides all four activity colors in both themes, with deliberate dark adaptations', () => {
    for (const token of [
      '--brand-agent-blue',
      '--brand-agent-teal',
      '--brand-agent-sky',
      '--brand-agent-mist',
    ]) {
      expect(parseCssColor(resolve(token)).a).toBe(1)
      expect(parseCssColor(resolve(token, true)).a).toBe(1)
      expect(resolve(token, true)).not.toBe(resolve(token))
    }
  })

  it('rebinds application semantics on the dark body instead of inheriting resolved light aliases', () => {
    for (const token of [
      '--color-ink',
      '--color-ink-soft',
      '--color-muted',
      '--color-paper',
      '--color-surface',
      '--color-line',
      '--color-signal',
      '--color-signal-soft',
      '--color-signal-strong',
    ])
      expect(appDark[token], `missing dark rebinding: ${token}`).toBeDefined()
    expect(resolve('--color-paper', true)).not.toBe(resolve('--color-paper'))
    expect(resolve('--color-surface', true)).not.toBe(resolve('--color-surface'))
  })
})
