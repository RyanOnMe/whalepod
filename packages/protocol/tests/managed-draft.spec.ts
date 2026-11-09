import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ManagedDraftSourceManifestSchema,
  ManagedDraftModelAttemptSchema,
  ManagedDraftCandidateProofSchema,
} from '../src/managed-draft.js'

const sha256 = 'a'.repeat(64)
const ids = {
  runId: randomUUID(),
  taskId: randomUUID(),
  projectId: randomUUID(),
  workKey: randomUUID(),
  ownerUserId: randomUUID(),
  mandateId: randomUUID(),
  profileRevisionId: randomUUID(),
  deviceId: randomUUID(),
  workspaceId: randomUUID(),
}
const source = { policyId: randomUUID(), revisionId: randomUUID(), sha256, byteSize: 45 }
const sourceManifest = {
  ...ids,
  kind: 'managed_draft_source.v1',
  instruction: 'draft_registered_agreement.v1',
  mandateVersion: 1,
  source,
  modelBindingDigest: sha256,
  managedHostGeneration: 1,
  expiresAt: '2026-11-09T15:00:00Z',
}

describe('RD-03c3a source wire contracts (not enabled for dispatch)', () => {
  it('pins one source and a versioned fixed instruction; never accepts private bytes on the control plane', () => {
    expect(ManagedDraftSourceManifestSchema.parse(sourceManifest)).toEqual(sourceManifest)
    for (const field of [
      'prompt',
      'persona',
      'credentialSlot',
      'workspacePath',
      'pluginPack',
      'resumeSessionId',
    ]) {
      expect(
        ManagedDraftSourceManifestSchema.safeParse({ ...sourceManifest, [field]: 'private' })
          .success,
      ).toBe(false)
    }
    expect(
      ManagedDraftSourceManifestSchema.safeParse({
        ...sourceManifest,
        source: { ...source, content: 'private' },
      }).success,
    ).toBe(false)
    expect(
      ManagedDraftSourceManifestSchema.safeParse({
        ...sourceManifest,
        instruction: 'other_instruction',
      }).success,
    ).toBe(false)
  })

  it('rejects unknown model generations, arbitrary retries and content in an admission frame', () => {
    const attempt = {
      runId: ids.runId,
      manifestDigest: sha256,
      deviceId: ids.deviceId,
      attemptId: randomUUID(),
      modelBindingDigest: sha256,
      requestDigest: 'b'.repeat(64),
      byteSize: 43,
    }
    expect(ManagedDraftModelAttemptSchema.parse(attempt)).toEqual(attempt)
    for (const field of ['providerCredentials', 'prompt', 'retryPermit']) {
      expect(
        ManagedDraftModelAttemptSchema.safeParse({ ...attempt, [field]: 'private' }).success,
      ).toBe(false)
    }
    expect(
      ManagedDraftModelAttemptSchema.safeParse({
        ...attempt,
        modelBindingDigest: 'unknown',
      }).success,
    ).toBe(false)
  })

  it('requires an independent write receipt and verified upload receipt for exactly one fixed file', () => {
    const proof = {
      runId: ids.runId,
      manifestDigest: sha256,
      artifactId: randomUUID(),
      sha256,
      byteSize: 16,
      fileWriteReceiptId: randomUUID(),
      verifiedUploadReceiptId: randomUUID(),
    }
    expect(ManagedDraftCandidateProofSchema.parse(proof)).toEqual(proof)
    expect(
      ManagedDraftCandidateProofSchema.safeParse({ ...proof, title: 'draft text' }).success,
    ).toBe(false)
    expect(ManagedDraftCandidateProofSchema.safeParse({ ...proof, byteSize: 65_537 }).success).toBe(
      false,
    )
    expect(
      ManagedDraftCandidateProofSchema.safeParse({
        ...proof,
        verifiedUploadReceiptId: proof.fileWriteReceiptId,
      }).success,
    ).toBe(false)
  })
})
