import { describe, expect, it } from 'vitest'
import { DOMAIN_VERSION } from '../src/index.js'
import { DomainError } from '../src/errors.js'
import {
  asAgentId,
  asApprovalId,
  asArtifactId,
  asDeviceId,
  asProfileRevisionId,
  asProjectId,
  asRunId,
  asTaskId,
  asTeamId,
  asUserId,
  asWorkspaceId,
} from '../src/ids.js'

describe('branded id constructors', () => {
  it('pass the raw string through unchanged', () => {
    expect(asTeamId('t')).toBe('t')
    expect(asUserId('u')).toBe('u')
    expect(asProjectId('p')).toBe('p')
    expect(asTaskId('ta')).toBe('ta')
    expect(asAgentId('a')).toBe('a')
    expect(asProfileRevisionId('pr')).toBe('pr')
    expect(asDeviceId('d')).toBe('d')
    expect(asWorkspaceId('w')).toBe('w')
    expect(asRunId('r')).toBe('r')
    expect(asApprovalId('ap')).toBe('ap')
    expect(asArtifactId('ar')).toBe('ar')
  })
})

describe('DomainError', () => {
  it('defaults message to the stable code', () => {
    const error = new DomainError('INVALID_RUN_TRANSITION')
    expect(error.message).toBe('INVALID_RUN_TRANSITION')
    expect(error.name).toBe('DomainError')
    expect(error.code).toBe('INVALID_RUN_TRANSITION')
  })

  it('accepts a human message without changing the code', () => {
    const error = new DomainError('TASK_TERMINAL', 'task already done')
    expect(error.message).toBe('task already done')
    expect(error.code).toBe('TASK_TERMINAL')
  })
})

it('exports DOMAIN_VERSION', () => {
  expect(DOMAIN_VERSION).toBe(1)
})
