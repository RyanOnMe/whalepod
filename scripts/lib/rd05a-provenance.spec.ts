import { describe, expect, it } from 'vitest'
import { RD05A_HARNESS_FILES } from './rd05a-provenance.js'

describe('RD05a source harness closure', () => {
  it('seals assembly resolution, disposable database and redaction dependencies', () => {
    expect(RD05A_HARNESS_FILES).toEqual(
      expect.arrayContaining([
        'scripts/lib/phase1/hub-assembly.ts',
        'scripts/lib/phase1/events.ts',
        'scripts/lib/ephemeral-postgres.mts',
      ]),
    )
  })
})
