import { and, eq, isNull } from 'drizzle-orm'
import {
  getDiscoveryApplicationById,
  getDiscoveryExecutionByApplication,
  getDiscoveryPermit,
  getTaskMessage,
  revokeDiscoveryExecution,
  schema,
  type Database,
  type Tx,
} from '@whalepod/db'
import type {
  DiscoveryExecutionExecutor,
  DiscoveryExecutorSourceGrantRequest,
} from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import {
  executorDigest,
  loadDiscoveryExecutionBasis,
  lockDiscoveryExecutionScope,
  type DiscoveryExecutionSourceView,
} from './execution.js'

const grants = schema.discoveryExecutorSourceGrants

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'executor source grant unavailable')
}

function matches(left: DiscoveryExecutionSourceView, right: DiscoveryExecutionSourceView) {
  return (
    left.kind === right.kind &&
    left.sourceId === right.sourceId &&
    left.sourceVersion === right.sourceVersion &&
    left.sourceDigest === right.sourceDigest &&
    left.authorizationGeneration === right.authorizationGeneration
  )
}

async function sourceOwner(
  tx: Tx,
  source: Pick<DiscoveryExecutionSourceView, 'kind' | 'sourceId'>,
) {
  switch (source.kind) {
    case 'task_message':
      return (await getTaskMessage(tx, source.sourceId))?.authorUserId
    case 'artifact': {
      const [row] = await tx
        .select({ owner: schema.artifacts.ownerUserId })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, source.sourceId))
      return row?.owner
    }
    case 'receipt': {
      const [row] = await tx
        .select({ owner: schema.discoveryVerifications.verifierUserId })
        .from(schema.discoveryVerifications)
        .where(eq(schema.discoveryVerifications.id, source.sourceId))
      return row?.owner
    }
  }
}

export async function grantExecutorSource(
  database: Database,
  actorId: string,
  projectId: string,
  applicationId: string,
  input: DiscoveryExecutorSourceGrantRequest,
  configuredRoute: DiscoveryExecutionExecutor,
) {
  return database.transaction(async (tx) => {
    const routeDigest = executorDigest(input.executor)
    if (routeDigest !== executorDigest(configuredRoute)) notFound()
    const application = await getDiscoveryApplicationById(tx, applicationId)
    if (!application || application.projectId !== projectId || application.status !== 'applied')
      notFound()
    if ((await sourceOwner(tx, input.source)) !== actorId) notFound()
    const permit = await getDiscoveryPermit(tx, application.permitId)
    if (!permit?.executorLimits) notFound()
    await lockDiscoveryExecutionScope(tx, permit.principalUserId, applicationId, projectId)
    const now = new Date()
    const basis = await loadDiscoveryExecutionBasis(
      tx,
      permit.principalUserId,
      projectId,
      applicationId,
      now,
      true,
    )
    if (!basis.eligible || !basis.sources.some((source) => matches(source, input.source)))
      notFound()
    if ((await sourceOwner(tx, input.source)) !== actorId) notFound()
    const [prior] = await tx
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.applicationId, applicationId),
          eq(grants.executorDigest, routeDigest),
          eq(grants.kind, input.source.kind),
          eq(grants.sourceId, input.source.sourceId),
        ),
      )
    if (prior) {
      if (prior.revokedAt || prior.granterUserId !== actorId || !matches(prior, input.source))
        notFound()
      return { id: prior.id }
    }
    const id = uuidv7(now.getTime())
    await tx.insert(grants).values({
      ...input.source,
      id,
      applicationId,
      granterUserId: actorId,
      executorDigest: routeDigest,
      grantedAt: now,
    })
    return { id }
  })
}

export async function revokeExecutorSource(
  database: Database,
  actorId: string,
  projectId: string,
  applicationId: string,
  grantId: string,
) {
  await database.transaction(async (tx) => {
    const application = await getDiscoveryApplicationById(tx, applicationId)
    if (!application || application.projectId !== projectId) notFound()
    const [grant] = await tx
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.id, grantId),
          eq(grants.applicationId, applicationId),
          eq(grants.granterUserId, actorId),
        ),
      )
    if (!grant) notFound()
    // A grant is independent of the principal, including after the project is archived.
    // Serialize with dispatch/begin on the Project row, then recheck before updating.
    await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .for('update')
    const now = new Date()
    await tx
      .update(grants)
      .set({ revokedAt: now })
      .where(and(eq(grants.id, grantId), isNull(grants.revokedAt)))
    const execution = await getDiscoveryExecutionByApplication(tx, applicationId)
    if (execution?.executorDigest === grant.executorDigest)
      await revokeDiscoveryExecution(tx, execution.id, 'executor_source_grant_revoked', now)
  })
}

/** Called under the execution authority scope for dispatch and each model attempt. */
export async function executorSourceGrantsDigest(
  tx: Tx,
  applicationId: string,
  routeDigest: string,
  sources: readonly DiscoveryExecutionSourceView[],
): Promise<string | undefined> {
  const rows = await tx
    .select()
    .from(grants)
    .where(and(eq(grants.applicationId, applicationId), eq(grants.executorDigest, routeDigest)))
  if (sources.length === 0 || rows.length !== sources.length) return undefined
  const identities: { id: string; granter: string }[] = []
  for (const source of sources) {
    const grant = rows.find((row) => matches(row, source))
    if (!grant || grant.revokedAt || grant.granterUserId !== (await sourceOwner(tx, source)))
      return undefined
    identities.push({ id: grant.id, granter: grant.granterUserId })
  }
  return sha256Hex(canonicalJson(identities))
}
