/**
 * #440: provenance for one exact output, derived from immutable Run bindings.
 * No event body, device path, credential, private draft or candidate metadata leaves this seam.
 */
import type { Actor } from '@whalepod/domain'
import {
  getArtifact,
  getRun,
  getSpecRevision,
  listHandoffRevisionsByTask,
  type DbHandle,
} from '@whalepod/db'
import {
  ArtifactDeliveryBasisSchema,
  ArtifactInputManifestSchema,
  HandoffInputManifestSchema,
  type ArtifactDeliveryBasis,
  type ArtifactManifestEntry,
  type HandoffNarrative,
} from '@whalepod/protocol'
import { requireReadableArtifact } from './review.js'

export function matchesDeliveryArtifact(
  artifact: { id: string; taskId: string; runId: string; sha256: string },
  handoff: {
    taskId: string
    sourceRunId: string
    content: {
      system: {
        sourceRunId: string
        artifacts: Array<{ artifactId: string; sha256: string; status: string }>
      }
    }
  },
): boolean {
  return (
    handoff.taskId === artifact.taskId &&
    handoff.sourceRunId === artifact.runId &&
    handoff.content.system.sourceRunId === artifact.runId &&
    handoff.content.system.artifacts.some(
      (item) =>
        item.artifactId === artifact.id &&
        item.sha256 === artifact.sha256 &&
        item.status === 'published',
    )
  )
}

async function publishedInputs(handle: DbHandle, entries: ArtifactManifestEntry[], taskId: string) {
  const visible = await Promise.all(
    entries.map(async (entry) => {
      const current = await getArtifact(handle, entry.artifactId)
      return current !== undefined &&
        current.taskId === taskId &&
        current.status === 'published' &&
        current.sha256 === entry.sha256 &&
        current.runId === entry.runId &&
        current.byteSize === entry.byteSize
        ? entry
        : null
    }),
  )
  return {
    status: 'recorded' as const,
    complete: visible.every((entry) => entry !== null),
    artifacts: visible.filter((entry): entry is ArtifactManifestEntry => entry !== null),
  }
}

/** Published text remains explicitly shared; references are independently rechecked. */
async function visibleNarrative(handle: DbHandle, taskId: string, narrative: HandoffNarrative) {
  let complete = true
  const sectionKeys = [
    'completed',
    'interfaces',
    'unfinished',
    'decisions',
    'evidence',
    'downstream',
  ] as const
  const result = { ...narrative }
  for (const key of sectionKeys) {
    result[key] = await Promise.all(
      narrative[key].map(async (item) => {
        const refs = await Promise.all(
          item.refs.map(async (ref) => {
            if (ref.kind === 'artifact') {
              const artifact = await getArtifact(handle, ref.artifactId)
              if (
                artifact === undefined ||
                artifact.taskId !== taskId ||
                artifact.status !== 'published'
              ) {
                complete = false
                return null
              }
            } else if (ref.kind === 'run') {
              const run = await getRun(handle, ref.runId)
              if (run === undefined || run.taskId !== taskId) {
                complete = false
                return null
              }
            }
            return ref
          }),
        )
        return { ...item, refs: refs.filter((ref): ref is NonNullable<typeof ref> => ref !== null) }
      }),
    )
  }
  return { narrative: result, referencesComplete: complete }
}

export async function getArtifactDeliveryBasis(
  handle: DbHandle,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactDeliveryBasis> {
  const artifact = await requireReadableArtifact(handle, actor, artifactId)
  const candidateRun = await getRun(handle, artifact.runId)
  const run = candidateRun?.taskId === artifact.taskId ? candidateRun : undefined
  const unknown = { status: 'unknown' as const, complete: false, artifacts: [] }
  let agreement: ArtifactDeliveryBasis['agreement'] = { status: 'unavailable', revision: null }
  if (run !== undefined) {
    if (run.specRevisionId === null) agreement = { status: 'unbound', revision: null }
    else {
      const revision = await getSpecRevision(handle, run.specRevisionId)
      if (
        revision !== undefined &&
        revision.taskId === artifact.taskId &&
        revision.status === 'confirmed' &&
        revision.revisionNumber !== null
      ) {
        agreement = {
          status: 'bound',
          revision: {
            id: revision.id,
            revisionNumber: revision.revisionNumber,
            content: revision.content,
            confirmedByUserId: revision.confirmedBy,
            confirmedAt: revision.confirmedAt?.toISOString() ?? null,
          },
        }
      }
    }
  }
  const snapshot = ArtifactInputManifestSchema.safeParse(run?.artifactInputManifest)
  const taskInputs =
    snapshot.success && snapshot.data.taskId === artifact.taskId
      ? await publishedInputs(handle, snapshot.data.artifacts, artifact.taskId)
      : unknown
  const handoffSnapshot = HandoffInputManifestSchema.safeParse(run?.handoffInput)
  const handoffInputs =
    run === undefined
      ? unknown
      : run.handoffInput === null
        ? { status: 'not_selected' as const, complete: true, artifacts: [] }
        : handoffSnapshot.success
          ? await publishedInputs(
              handle,
              handoffSnapshot.data.artifacts,
              handoffSnapshot.data.upstreamTaskId,
            )
          : unknown
  const handoffs: ArtifactDeliveryBasis['handoffs'] = []
  const matching = (await listHandoffRevisionsByTask(handle, artifact.taskId)).find((row) =>
    matchesDeliveryArtifact(artifact, row),
  )
  if (matching !== undefined) {
    handoffs.push({
      id: matching.id,
      revisionNumber: matching.revisionNumber,
      publishedByUserId: matching.publishedBy,
      publishedAt: matching.publishedAt.toISOString(),
      ...(await visibleNarrative(handle, artifact.taskId, matching.content.narrative)),
    })
  }
  return ArtifactDeliveryBasisSchema.parse({
    artifactId: artifact.id,
    taskId: artifact.taskId,
    sourceRun:
      run === undefined
        ? null
        : { id: run.id, createdAt: run.createdAt.toISOString(), status: run.status },
    agreement,
    taskInputs,
    handoffInputs,
    handoffs,
  })
}
