import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/modules/coordination/digest.js'
import {
  assertDiscoveryTextStorable,
  assertTemplateWithinStorage,
} from '../src/modules/discovery/admission.js'
import { renderDiscoveryTemplate } from '../src/modules/discovery/catalog.js'

const template = (goal: string) => ({
  goal,
  constraints: '',
  acceptance: '',
  openQuestions: '',
})

describe('discovery template helpers', () => {
  it('rejects bytes that only fit before PostgreSQL jsonb separators', () => {
    const text = '汉'.repeat(5_439)
    const value = {
      goal: text,
      constraints: text,
      acceptance: text,
      openQuestions: text,
    }
    const bytes = Buffer.byteLength(canonicalJson(value), 'utf8')
    // Inside the old 65 536 canonical bound, above the new headroom, and over the DB
    // bound once jsonb adds `": "`/`", "` separators.
    expect(bytes).toBeGreaterThan(65_024)
    expect(bytes).toBeLessThanOrEqual(65_536)
    expect(() => assertTemplateWithinStorage(value)).toThrow(/storage bounds/)
  })

  it('accepts a template with ordinary storage headroom', () => {
    expect(() => assertTemplateWithinStorage(template('汉'.repeat(5_000)))).not.toThrow()
  })

  it('rejects NUL, which PostgreSQL jsonb cannot store', () => {
    expect(() => assertTemplateWithinStorage(template('a\u0000b'))).toThrow(/storage bounds/)
  })

  it('rejects lone surrogates in templates and config labels', () => {
    expect(() => assertTemplateWithinStorage(template('a\uD800b'))).toThrow(/storage bounds/)
    expect(() => assertDiscoveryTextStorable('\uDC00')).toThrow(/not storable/)
    expect(() => assertDiscoveryTextStorable('活动')).not.toThrow()
  })
})

describe('renderDiscoveryTemplate', () => {
  it('keeps replacement patterns and nested placeholders literal', () => {
    const rendered = renderDiscoveryTemplate(
      '{{activity}}|{{slot}}|{{sourceId}}|{{sourceVersion}}',
      {
        activity: '$&',
        slot: '$`',
        sourceId: "$'",
        sourceVersion: '$$',
      },
    )
    expect(rendered).toBe("$&|$`|$'|$$")
    expect(
      renderDiscoveryTemplate('为{{activity}}准备{{slot}}', {
        activity: '{{slot}}',
        slot: '接驳草稿',
        sourceId: 'id',
        sourceVersion: 'v',
      }),
    ).toBe('为{{slot}}准备接驳草稿')
  })
})
