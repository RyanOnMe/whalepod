import { describe, expect, it } from 'vitest'
import {
  checkDraftShareEligibility,
  type DraftShareEvidence,
} from '../src/modules/draft-share/eligibility.js'

const now = new Date('2026-11-09T12:00:00Z')
const mandateExpiry = new Date('2026-11-09T12:40:00Z')
const sourceExpiry = new Date('2026-11-09T12:20:00Z')
const artifactDigest = 'a'.repeat(64)
const manifestDigest = 'b'.repeat(64)

function verifiedEvidence(): DraftShareEvidence {
  return {
    grantorUserId: 'member-a',
    recipientUserId: 'member-b',
    enabledUserIds: ['member-a', 'member-b'],
    task: { id: 'task', projectId: 'project', assigneeUserId: 'member-a', available: true },
    work: { key: 'work', taskId: 'task', ownerUserId: 'member-a', available: true },
    run: {
      id: 'run',
      taskId: 'task',
      ownerUserId: 'member-a',
      workKey: 'work',
      mandateId: 'mandate',
      onBehalfOfUserId: 'member-a',
      origin: 'mandate',
      status: 'completed',
      managedDraftSourceDigest: manifestDigest,
    },
    artifact: {
      id: 'artifact',
      runId: 'run',
      taskId: 'task',
      ownerUserId: 'member-a',
      status: 'candidate',
      sha256: artifactDigest,
      byteSize: 8,
    },
    outputProof: {
      runId: 'run',
      artifactId: 'artifact',
      sourceManifestDigest: manifestDigest,
      sha256: artifactDigest,
      byteSize: 8,
      fileWriteReceiptId: 'write-receipt',
      verifiedUploadReceiptId: 'upload-receipt',
    },
    sourceManifest: {
      digest: manifestDigest,
      mandateId: 'mandate',
      mandateVersion: 3,
      sources: [{ id: 'material', contentSha256: 'c'.repeat(64), generation: 2 }],
      modelPolicy: { id: 'model-policy', generation: 2 },
    },
    mandate: {
      id: 'mandate',
      version: 3,
      state: 'active',
      principalUserId: 'member-a',
      workKey: 'work',
      expiresAt: mandateExpiry,
    },
    sourcePolicies: [
      {
        id: 'material',
        contentSha256: 'c'.repeat(64),
        generation: 2,
        projectId: 'project',
        permitsReadRecipient: 'member-b',
        active: true,
        expiresAt: sourceExpiry,
      },
    ],
    modelPolicy: { id: 'model-policy', generation: 2, active: true },
  }
}

describe('RD-03c3a grant evidence policy (component, not an end-to-end acceptance)', () => {
  it('permits the exact verified candidate for the specified recipient and caps expiry', () => {
    const evidence = verifiedEvidence()
    expect(checkDraftShareEligibility(evidence, now)).toEqual({
      ok: true,
      expiresNoLaterThan: sourceExpiry,
    })
    expect(checkDraftShareEligibility(evidence, sourceExpiry)).toEqual({
      ok: false,
      reason: 'source_authority_unavailable',
    })
  })

  it.each([
    [
      'ordinary Run',
      (e: DraftShareEvidence) => {
        e.run.managedDraftSourceDigest = null
      },
      'source_run_unavailable',
    ],
    [
      'failed Run',
      (e: DraftShareEvidence) => {
        e.run.status = 'failed'
      },
      'source_run_unavailable',
    ],
    [
      'verified blob without a write receipt',
      (e: DraftShareEvidence) => {
        e.outputProof!.fileWriteReceiptId = ''
      },
      'output_unproven',
    ],
    [
      'ordinary uploaded candidate',
      (e: DraftShareEvidence) => {
        e.outputProof = null
      },
      'output_unproven',
    ],
    [
      'digest mismatch',
      (e: DraftShareEvidence) => {
        e.artifact.sha256 = 'd'.repeat(64)
      },
      'output_unproven',
    ],
    [
      'same digest, different size',
      (e: DraftShareEvidence) => {
        e.outputProof!.byteSize += 1
      },
      'output_unproven',
    ],
    [
      'published artifact',
      (e: DraftShareEvidence) => {
        e.artifact.status = 'published'
      },
      'candidate_unavailable',
    ],
    [
      'Task reassigned',
      (e: DraftShareEvidence) => {
        e.task.assigneeUserId = 'member-c'
      },
      'actor_or_scope_unavailable',
    ],
    [
      'recipient disabled',
      (e: DraftShareEvidence) => {
        e.enabledUserIds = ['member-a']
      },
      'actor_or_scope_unavailable',
    ],
    [
      'Mandate version advanced',
      (e: DraftShareEvidence) => {
        e.mandate!.version += 1
      },
      'mandate_unavailable',
    ],
    [
      'source policy advanced and restored same recipient',
      (e: DraftShareEvidence) => {
        e.sourcePolicies[0]!.generation += 2
      },
      'source_authority_unavailable',
    ],
    [
      'different project',
      (e: DraftShareEvidence) => {
        e.sourcePolicies[0]!.projectId = 'other-project'
      },
      'source_authority_unavailable',
    ],
    [
      'reading permitted to someone else',
      (e: DraftShareEvidence) => {
        e.sourcePolicies[0]!.permitsReadRecipient = 'member-c'
      },
      'source_authority_unavailable',
    ],
    [
      'unknown source authority',
      (e: DraftShareEvidence) => {
        e.sourcePolicies = []
      },
      'source_authority_unavailable',
    ],
    [
      'changed model policy',
      (e: DraftShareEvidence) => {
        e.modelPolicy!.generation += 1
      },
      'source_authority_unavailable',
    ],
  ] as const)('denies %s', (_label, change, reason) => {
    const evidence = verifiedEvidence()
    change(evidence)
    expect(checkDraftShareEligibility(evidence, now)).toEqual({ ok: false, reason })
  })
})
