import { getWorkMandateForUpdate, type Tx } from '@whalepod/db'
import {
  ManagedDraftSourceManifestSchema,
  type ManagedDraftSourceManifest,
} from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { lockWorkContext } from '../work/context.js'
import { lockRegisteredDraftSource, type ManagedSourceModelRoute } from './source-registry.js'

interface ManifestRequest {
  readonly actorUserId: string
  readonly workKey: string
  readonly runId: string
  readonly sourceId: string
}

/** Authority must come from trusted managed-host provisioning, not node.hello or a client DTO. */
interface ManagedSourcePlacement {
  readonly deviceId: string
  readonly workspaceId: string
  readonly profileRevisionId: string
  readonly managedHostGeneration: number
}

/**
 * Prepare the body-free manifest under the dispatch transaction. This is not
 * dispatch or a model admission; the caller still needs the ordinary approved
 * intent and resource guards, the dedicated Node transport and output proof.
 */
export async function loadManagedDraftSourceManifest(
  tx: Tx,
  request: ManifestRequest,
  placement: ManagedSourcePlacement | undefined,
  modelRoute: ManagedSourceModelRoute | undefined,
  now: Date,
  checkExistingRun = false,
): Promise<
  { manifest: ManagedDraftSourceManifest; manifestDigest: string; bytes: Buffer } | undefined
> {
  if (placement === undefined || modelRoute === undefined) return undefined
  const { task, work } = await lockWorkContext(tx, request.workKey)
  const owner = request.actorUserId
  const stateMatches = checkExistingRun
    ? work.state === 'waiting' &&
      work.resumeMode === 'auto' &&
      work.resumeCondition === `run:${request.runId}`
    : work.state === 'active'
  if (
    !stateMatches ||
    work.humanOwnerUserId !== owner ||
    work.projectId !== task.projectId ||
    task.assigneeUserId !== owner ||
    work.mandateId === null
  )
    return undefined
  const mandate = await getWorkMandateForUpdate(tx, work.mandateId)
  if (
    mandate === undefined ||
    mandate.workId !== work.id ||
    mandate.workKey !== work.workKey ||
    mandate.projectId !== task.projectId ||
    mandate.taskId !== task.id ||
    mandate.status !== 'active' ||
    mandate.principalUserId !== owner ||
    mandate.onBehalfOfUserId !== owner ||
    mandate.humanOwnerUserId !== owner ||
    mandate.draftRecipientUserId !== owner ||
    !mandate.allowedActionClasses.includes('draft') ||
    !(mandate.expiresAt.getTime() > now.getTime())
  )
    return undefined
  const source = await lockRegisteredDraftSource(tx, request.sourceId, modelRoute, now, task)
  if (source === undefined || source.row.ownerUserId !== owner) return undefined
  const expiresAt = new Date(
    Math.min(
      source.row.expiresAt.getTime(),
      mandate.expiresAt.getTime(),
      modelRoute.expiresAt.getTime(),
    ),
  ).toISOString()
  const parsed = ManagedDraftSourceManifestSchema.safeParse({
    kind: 'managed_draft_source.v1',
    instruction: 'draft_registered_agreement.v1',
    runId: request.runId,
    projectId: task.projectId,
    taskId: task.id,
    workKey: work.workKey,
    ownerUserId: owner,
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    deviceId: placement.deviceId,
    workspaceId: placement.workspaceId,
    profileRevisionId: placement.profileRevisionId,
    managedHostGeneration: placement.managedHostGeneration,
    source: {
      policyId: source.row.id,
      revisionId: source.row.revisionId,
      sha256: source.row.sha256,
      byteSize: source.row.byteSize,
    },
    modelBindingDigest: source.row.modelBindingDigest,
    expiresAt,
  })
  if (!parsed.success) return undefined
  return {
    manifest: parsed.data,
    manifestDigest: sha256Hex(canonicalJson(parsed.data)),
    bytes: source.bytes,
  }
}

/** Outbox/control path deliberately strips the source before creating a frame. */
export async function prepareManagedDraftSourceManifest(
  ...args: Parameters<typeof loadManagedDraftSourceManifest>
) {
  const source = await loadManagedDraftSourceManifest(...args)
  if (source === undefined) return undefined
  return { manifest: source.manifest, manifestDigest: source.manifestDigest }
}
