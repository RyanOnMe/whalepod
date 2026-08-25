import { describe, expect, it } from 'vitest'
import { expectDomainError } from './helpers.js'
import type { ArtifactEvent, ArtifactStatus } from '../src/artifact.js'
import { transitionArtifact } from '../src/artifact.js'

// 规则以 03-领域模型与运行协议.md §3.4 为准：
// candidate -> published | rejected；published 与 rejected 为终态。
const ARTIFACT_STATUSES: readonly ArtifactStatus[] = ['candidate', 'published', 'rejected']
const ARTIFACT_EVENTS: readonly ArtifactEvent[] = [{ type: 'publish' }, { type: 'reject' }]

const ARTIFACT_LEGAL: Readonly<
  Record<ArtifactStatus, Partial<Record<ArtifactEvent['type'], ArtifactStatus>>>
> = {
  candidate: { publish: 'published', reject: 'rejected' },
  published: {},
  rejected: {},
}

describe('transitionArtifact', () => {
  it('candidate -> published on publish', () => {
    expect(transitionArtifact({ status: 'candidate' }, { type: 'publish' })).toEqual({
      status: 'published',
    })
  })

  it('candidate -> rejected on reject', () => {
    expect(transitionArtifact({ status: 'candidate' }, { type: 'reject' })).toEqual({
      status: 'rejected',
    })
  })

  it('never completes a Task implicitly when published', () => {
    // 03 §3.4：发布只产生 artifact.published Team Event，不改变 Task。
    expect(transitionArtifact({ status: 'candidate' }, { type: 'publish' })).toEqual({
      status: 'published',
    })
  })

  it.each(
    ARTIFACT_STATUSES.flatMap((status) => ARTIFACT_EVENTS.map((event) => [status, event] as const)),
  )('%s + %s follows the transition table exactly', (status, event) => {
    const expected = ARTIFACT_LEGAL[status][event.type]
    if (expected !== undefined) {
      expect(transitionArtifact({ status }, event)).toEqual({ status: expected })
    } else {
      expectDomainError(() => transitionArtifact({ status }, event), 'INVALID_ARTIFACT_TRANSITION')
    }
  })

  it.each(['published', 'rejected'] as const)(
    'never revives a terminal Artifact (%s)',
    (status) => {
      for (const event of ARTIFACT_EVENTS) {
        expectDomainError(
          () => transitionArtifact({ status }, event),
          'INVALID_ARTIFACT_TRANSITION',
        )
      }
    },
  )
})
