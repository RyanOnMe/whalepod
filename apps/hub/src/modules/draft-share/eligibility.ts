import type { ArtifactRow, RunRow } from '@whalepod/db'

/** Trusted Hub facts only: never populate these from an offer, link, or Node self-declaration. */
export interface DraftShareEvidence {
  grantorUserId: string
  recipientUserId: string
  enabledUserIds: readonly string[]
  task: { id: string; projectId: string; assigneeUserId: string; available: boolean }
  work: { key: string; taskId: string; ownerUserId: string; available: boolean }
  run: Pick<
    RunRow,
    | 'id'
    | 'taskId'
    | 'ownerUserId'
    | 'workKey'
    | 'origin'
    | 'status'
    | 'managedDraftSourceDigest'
    | 'mandateId'
    | 'onBehalfOfUserId'
  >
  artifact: Pick<
    ArtifactRow,
    'id' | 'runId' | 'taskId' | 'ownerUserId' | 'status' | 'sha256' | 'byteSize'
  >
  outputProof: {
    runId: string
    artifactId: string
    sourceManifestDigest: string
    sha256: string
    byteSize: number
    fileWriteReceiptId: string
    verifiedUploadReceiptId: string
  } | null
  sourceManifest: {
    digest: string
    mandateId: string
    mandateVersion: number
    sources: readonly SourceBinding[]
    modelPolicy: { id: string; generation: number }
  } | null
  mandate: {
    id: string
    version: number
    state: 'active' | 'paused' | 'revoked' | 'superseded'
    principalUserId: string
    workKey: string
    expiresAt: Date
  } | null
  sourcePolicies: readonly (SourceBinding & {
    projectId: string
    permitsReadRecipient: string | null
    active: boolean
    expiresAt: Date
  })[]
  modelPolicy: { id: string; generation: number; active: boolean } | null
}

interface SourceBinding {
  id: string
  contentSha256: string
  generation: number
}

type DraftShareRejection =
  | 'actor_or_scope_unavailable'
  | 'source_run_unavailable'
  | 'candidate_unavailable'
  | 'output_unproven'
  | 'mandate_unavailable'
  | 'source_authority_unavailable'

export type DraftShareEligibility =
  | { readonly ok: true; readonly expiresNoLaterThan: Date }
  | { readonly ok: false; readonly reason: DraftShareRejection }

const DIGEST = /^[a-f0-9]{64}$/
const currentGeneration = (value: number): boolean => Number.isSafeInteger(value) && value > 0

/**
 * Check the evidence intersection for one proposed human reader. Callers must load
 * current facts inside the final authorization transaction. A successful check
 * supplies an expiry cap; it does not accept a grant or authorize sending bytes.
 */
export function checkDraftShareEligibility(
  evidence: DraftShareEvidence,
  now: Date,
): DraftShareEligibility {
  const {
    grantorUserId,
    recipientUserId,
    task,
    work,
    run,
    artifact,
    outputProof,
    sourceManifest,
    mandate,
    sourcePolicies,
    modelPolicy,
  } = evidence

  if (
    grantorUserId === recipientUserId ||
    !evidence.enabledUserIds.includes(grantorUserId) ||
    !evidence.enabledUserIds.includes(recipientUserId) ||
    task.assigneeUserId !== grantorUserId ||
    !task.available ||
    !work.available ||
    work.taskId !== task.id ||
    work.ownerUserId !== grantorUserId
  )
    return { ok: false, reason: 'actor_or_scope_unavailable' }

  if (
    run.origin !== 'mandate' ||
    run.status !== 'completed' ||
    run.taskId !== task.id ||
    run.ownerUserId !== grantorUserId ||
    run.onBehalfOfUserId !== grantorUserId ||
    run.workKey !== work.key ||
    run.managedDraftSourceDigest === null ||
    !DIGEST.test(run.managedDraftSourceDigest)
  )
    return { ok: false, reason: 'source_run_unavailable' }

  if (
    artifact.status !== 'candidate' ||
    artifact.runId !== run.id ||
    artifact.taskId !== task.id ||
    artifact.ownerUserId !== grantorUserId ||
    !DIGEST.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteSize) ||
    artifact.byteSize < 0
  )
    return { ok: false, reason: 'candidate_unavailable' }

  if (
    outputProof === null ||
    outputProof.runId !== run.id ||
    outputProof.artifactId !== artifact.id ||
    outputProof.sourceManifestDigest !== run.managedDraftSourceDigest ||
    outputProof.sha256 !== artifact.sha256 ||
    outputProof.byteSize !== artifact.byteSize ||
    outputProof.fileWriteReceiptId === '' ||
    outputProof.verifiedUploadReceiptId === '' ||
    sourceManifest === null ||
    sourceManifest.digest !== run.managedDraftSourceDigest
  )
    return { ok: false, reason: 'output_unproven' }

  const nowMs = now.getTime()
  if (
    mandate === null ||
    mandate.state !== 'active' ||
    mandate.id !== run.mandateId ||
    mandate.id !== sourceManifest.mandateId ||
    !currentGeneration(mandate.version) ||
    mandate.version !== sourceManifest.mandateVersion ||
    mandate.principalUserId !== grantorUserId ||
    mandate.workKey !== work.key ||
    !(mandate.expiresAt.getTime() > nowMs)
  )
    return { ok: false, reason: 'mandate_unavailable' }

  if (
    modelPolicy === null ||
    !modelPolicy.active ||
    modelPolicy.id !== sourceManifest.modelPolicy.id ||
    !currentGeneration(modelPolicy.generation) ||
    modelPolicy.generation !== sourceManifest.modelPolicy.generation ||
    sourceManifest.sources.length === 0
  )
    return { ok: false, reason: 'source_authority_unavailable' }

  let cap = mandate.expiresAt.getTime()
  const seen = new Set<string>()
  for (const source of sourceManifest.sources) {
    const current = sourcePolicies.filter(({ id }) => id === source.id)
    const policy = current[0]
    if (
      seen.has(source.id) ||
      current.length !== 1 ||
      policy === undefined ||
      !policy.active ||
      policy.projectId !== task.projectId ||
      policy.permitsReadRecipient !== recipientUserId ||
      !currentGeneration(policy.generation) ||
      policy.generation !== source.generation ||
      !DIGEST.test(policy.contentSha256) ||
      policy.contentSha256 !== source.contentSha256 ||
      !(policy.expiresAt.getTime() > nowMs)
    )
      return { ok: false, reason: 'source_authority_unavailable' }
    seen.add(source.id)
    cap = Math.min(cap, policy.expiresAt.getTime())
  }
  return { ok: true, expiresNoLaterThan: new Date(cap) }
}
