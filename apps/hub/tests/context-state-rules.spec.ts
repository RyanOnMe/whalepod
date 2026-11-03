/**
 * ADR-0027 §6（PC-05b）：上下文撤权派生规则的分支级判据。
 */
import { describe, expect, it } from 'vitest'
import {
  deriveEntryState,
  snapshotStatusOf,
  type DerivationInput,
} from '../src/modules/context/state.js'

const NOW = new Date('2026-11-03T00:00:00.000Z')

function entry(overrides: Record<string, unknown> = {}) {
  return {
    entryId: '01905f7c-0000-7000-8000-000000000951',
    sourceId: null,
    authorizationGeneration: null,
    identityUnverified: false,
    permissionStateAtSelection: 'authorized',
    ...overrides,
  } as never
}

function contextEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: '01905f7c-0000-7000-8000-000000000951',
    status: 'active',
    correctedAt: null,
    ...overrides,
  } as never
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: '01905f7c-0000-7000-8000-000000000991',
    status: 'active',
    permissionState: 'verified',
    permissionExpiresAt: new Date('2026-11-04T00:00:00.000Z'),
    authorizationGeneration: 3,
    ...overrides,
  } as never
}

function derive(overrides: Partial<DerivationInput>) {
  return deriveEntryState({
    entry: entry(),
    contextEntry: contextEntry(),
    source: undefined,
    now: NOW,
    ...overrides,
  })
}

describe('PC-05b context entry derivation', () => {
  it('keeps an active uncorrected business entry frozen', () => {
    expect(derive({})).toEqual({ state: 'frozen', reason: null })
  })

  it('retracts corrected or superseded business entries', () => {
    expect(derive({ contextEntry: contextEntry({ correctedAt: NOW }) })).toEqual({
      state: 'retracted',
      reason: 'entry_corrected',
    })
    expect(derive({ contextEntry: contextEntry({ status: 'superseded' }) })).toEqual({
      state: 'retracted',
      reason: 'entry_superseded',
    })
    expect(derive({ contextEntry: undefined })).toEqual({
      state: 'unavailable',
      reason: 'entry_missing',
    })
    // Decision schema 不接受 permission_*；身份/选择权限问题必须落到 unavailable。
    expect(derive({ entry: entry({ identityUnverified: true }) })).toEqual({
      state: 'unavailable',
      reason: 'identity_unverified',
    })
    expect(derive({ entry: entry({ permissionStateAtSelection: 'unknown' }) })).toEqual({
      state: 'unavailable',
      reason: 'permission_not_authorized',
    })
  })

  it('maps source lifecycle and permission states', () => {
    const sourceEntry = entry({
      sourceId: '01905f7c-0000-7000-8000-000000000991',
      authorizationGeneration: '3',
    })
    const deriveSource = (overrides: Record<string, unknown>) =>
      derive({ entry: sourceEntry, contextEntry: contextEntry(), source: source(overrides) })

    expect(deriveSource({})).toEqual({ state: 'frozen', reason: null })
    expect(deriveSource({ status: 'revoked' })).toEqual({
      state: 'source_tombstoned',
      reason: 'source_revoked',
    })
    expect(deriveSource({ status: 'paused' })).toEqual({
      state: 'unavailable',
      reason: 'source_paused',
    })
    expect(deriveSource({ status: 'unavailable' })).toEqual({
      state: 'unavailable',
      reason: 'source_unavailable',
    })
    expect(deriveSource({ permissionState: 'unknown' })).toEqual({
      state: 'permission_unknown',
      reason: 'permission_unknown',
    })
    expect(deriveSource({ permissionState: 'denied' })).toEqual({
      state: 'permission_denied',
      reason: 'permission_denied',
    })
    expect(deriveSource({ permissionExpiresAt: new Date('2026-11-02T00:00:00.000Z') })).toEqual({
      state: 'permission_unknown',
      reason: 'permission_expired',
    })
    // 重新核验后代次递增仍可恢复；倒退才不可读。
    expect(deriveSource({ authorizationGeneration: 4 })).toEqual({
      state: 'frozen',
      reason: null,
    })
    expect(deriveSource({ authorizationGeneration: 2 })).toEqual({
      state: 'permission_unknown',
      reason: 'authorization_generation_regressed',
    })
    expect(derive({ entry: sourceEntry, contextEntry: contextEntry(), source: undefined })).toEqual(
      {
        state: 'unavailable',
        reason: 'source_missing',
      },
    )
    // 来源恢复不能复活已被纠正的 Observation。
    expect(
      derive({
        entry: sourceEntry,
        contextEntry: contextEntry({ correctedAt: NOW }),
        source: source(),
      }),
    ).toEqual({ state: 'retracted', reason: 'entry_corrected' })
  })

  it('aggregates snapshot status without hiding a partially unavailable basis', () => {
    expect(snapshotStatusOf([])).toBe('frozen')
    expect(
      snapshotStatusOf([
        {
          entryId: 'a',
          kind: 'observation',
          state: 'frozen',
          currentAuthorizationGeneration: null,
          reason: null,
        },
      ]),
    ).toBe('frozen')
    expect(
      snapshotStatusOf([
        {
          entryId: 'a',
          kind: 'observation',
          state: 'frozen',
          currentAuthorizationGeneration: null,
          reason: null,
        },
        {
          entryId: 'b',
          kind: 'observation',
          state: 'permission_unknown',
          currentAuthorizationGeneration: '3',
          reason: 'permission_unknown',
        },
      ]),
    ).toBe('partially_unavailable')
    expect(
      snapshotStatusOf([
        {
          entryId: 'a',
          kind: 'observation',
          state: 'retracted',
          currentAuthorizationGeneration: null,
          reason: 'entry_corrected',
        },
      ]),
    ).toBe('invalidated')
  })
})
