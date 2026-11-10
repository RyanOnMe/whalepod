import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import {
  getEnabledMember,
  getLatestConfirmedSpec,
  getProject,
  getTaskForUpdate,
  getTeam,
  schema,
  type Database,
  type TaskRow,
  type Tx,
} from '@whalepod/db'
import { TaskSpecContentSchema } from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { requireAssignee } from '../work/context.js'

/** Resolved from server-managed deployment policy, never from a dispatch or a browser. */
export interface ManagedSourceModelRoute {
  readonly provider: string
  readonly model: string
  readonly endpointId: string
  readonly endpointDigest?: string | undefined
  readonly accountId: string
  readonly policyGeneration: number
  readonly expiresAt: Date
}

export interface RegisterManagedDraftSourceInput {
  readonly projectId: string
  readonly taskId: string
  readonly revisionId: string
  readonly recipientUserId: string
  readonly permitsPublishedAudience: boolean
  readonly confirmsOwnershipAndUses: true
  readonly confirmedModelBindingDigest: string
  readonly expiresAt: Date
  readonly idempotencyKey: string
}

type SourcePolicyRow = schema.ManagedDraftSourcePolicyRow
type SourcePolicyView = Pick<
  SourcePolicyRow,
  'id' | 'revisionId' | 'recipientUserId' | 'permitsPublishedAudience' | 'sha256' | 'byteSize'
> & { readonly expiresAt: string }

const MAX_BYTES = 65_536
const policy = schema.managedDraftSourcePolicies
const unavailable = () =>
  new ApiError(409, 'CONFLICT', 'managed draft source authority is unavailable')
const notFound = () => new ApiError(404, 'NOT_FOUND', 'managed draft source not found')

export function managedDraftModelBindingDigest(
  route: ManagedSourceModelRoute | undefined,
  now: Date,
): string | undefined {
  if (
    route === undefined ||
    !(route.expiresAt.getTime() > now.getTime()) ||
    !Number.isSafeInteger(route.policyGeneration) ||
    route.policyGeneration < 1 ||
    [route.provider, route.model, route.endpointId, route.accountId].some(
      (value) => value.length === 0 || value.length > 128,
    )
  )
    return undefined
  return sha256Hex(
    canonicalJson({
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      ...(route.endpointDigest === undefined ? {} : { endpointDigest: route.endpointDigest }),
      accountId: route.accountId,
      policyGeneration: route.policyGeneration,
      policyExpiresAt: route.expiresAt.toISOString(),
    }),
  )
}

function view(row: SourcePolicyRow): SourcePolicyView {
  return {
    id: row.id,
    revisionId: row.revisionId,
    recipientUserId: row.recipientUserId,
    permitsPublishedAudience: row.permitsPublishedAudience,
    sha256: row.sha256,
    byteSize: row.byteSize,
    expiresAt: row.expiresAt.toISOString(),
  }
}

function taskAvailable(task: TaskRow): boolean {
  return (
    task.assignmentStatus === 'accepted' &&
    (task.status === 'open' || task.status === 'in_progress')
  )
}

async function loadAgreement(
  tx: Tx,
  task: TaskRow,
  ownerUserId: string,
  recipientUserId: string,
  revisionId: string,
): Promise<{ text: string; sha256: string; byteSize: number } | undefined> {
  if (
    !taskAvailable(task) ||
    task.assigneeUserId !== ownerUserId ||
    ownerUserId === recipientUserId
  )
    return undefined
  // Deactivation holds the same user-row locks before changing source policies.
  // Keep this ordering: Task → members → source policy.
  const members = await tx
    .select({ id: schema.userAccounts.id, disabledAt: schema.userAccounts.disabledAt })
    .from(schema.userAccounts)
    .where(inArray(schema.userAccounts.id, [ownerUserId, recipientUserId]))
    .orderBy(schema.userAccounts.id)
    .for('share')
  if (members.length !== 2 || members.some((member) => member.disabledAt !== null)) return undefined
  const project = await getProject(tx, task.projectId)
  const team = await getTeam(tx)
  if (
    project === undefined ||
    project.archivedAt !== null ||
    team === undefined ||
    (await getEnabledMember(tx, team.id, ownerUserId)) === undefined ||
    (await getEnabledMember(tx, team.id, recipientUserId)) === undefined
  )
    return undefined
  const current = await getLatestConfirmedSpec(tx, task.id)
  if (
    current === undefined ||
    current.id !== revisionId ||
    current.origin !== 'manual' ||
    // An edited draft does not track the editor for each version. One creation
    // followed by confirmation by the same A is the first verifiable source.
    current.draftVersion !== 1 ||
    current.createdBy !== ownerUserId ||
    current.confirmedBy !== ownerUserId
  )
    return undefined
  const content = TaskSpecContentSchema.safeParse(current.content)
  if (!content.success) return undefined
  const text = canonicalJson(content.data)
  const byteSize = Buffer.byteLength(text)
  if (byteSize === 0 || byteSize > MAX_BYTES) return undefined
  return { text, sha256: sha256Hex(text), byteSize }
}

/** Register only the exact agreement A wrote and confirmed, with explicit further-use policy. */
export async function registerManagedDraftSource(
  database: Database,
  actorUserId: string,
  input: RegisterManagedDraftSourceInput,
  route: ManagedSourceModelRoute | undefined,
  now: Date,
): Promise<SourcePolicyView> {
  return database.transaction(async (tx) => {
    const task = await getTaskForUpdate(tx, input.taskId)
    if (task === undefined || task.projectId !== input.projectId) throw notFound()
    await requireAssignee(
      tx,
      task,
      actorUserId,
      'only the current assignee can register this source',
    )
    const modelBindingDigest = managedDraftModelBindingDigest(route, now)
    if (
      modelBindingDigest === undefined ||
      route === undefined ||
      input.confirmsOwnershipAndUses !== true ||
      input.confirmedModelBindingDigest !== modelBindingDigest ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > 128 ||
      !(input.expiresAt.getTime() > now.getTime()) ||
      input.expiresAt.getTime() > route.expiresAt.getTime()
    )
      throw unavailable()
    const material = await loadAgreement(
      tx,
      task,
      actorUserId,
      input.recipientUserId,
      input.revisionId,
    )
    if (material === undefined) throw unavailable()
    const requestDigest = sha256Hex(
      canonicalJson({
        projectId: task.projectId,
        taskId: task.id,
        revisionId: input.revisionId,
        recipientUserId: input.recipientUserId,
        permitsPublishedAudience: input.permitsPublishedAudience,
        expiresAt: input.expiresAt.toISOString(),
        modelBindingDigest,
      }),
    )
    const [inserted] = await tx
      .insert(policy)
      .values({
        id: randomUUID(),
        projectId: task.projectId,
        taskId: task.id,
        revisionId: input.revisionId,
        ownerUserId: actorUserId,
        recipientUserId: input.recipientUserId,
        sha256: material.sha256,
        byteSize: material.byteSize,
        modelBindingDigest,
        permitsPublishedAudience: input.permitsPublishedAudience,
        expiresAt: input.expiresAt,
        createdAt: now,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
      })
      .onConflictDoNothing({ target: [policy.ownerUserId, policy.idempotencyKey] })
      .returning()
    if (inserted !== undefined) return view(inserted)
    const [prior] = await tx
      .select()
      .from(policy)
      .where(
        and(eq(policy.ownerUserId, actorUserId), eq(policy.idempotencyKey, input.idempotencyKey)),
      )
      .limit(1)
    if (prior === undefined || prior.requestDigest !== requestDigest || prior.revokedAt !== null)
      throw unavailable()
    return view(prior)
  })
}

/**
 * Recheck the exact bytes and current authority under the caller's transaction.
 * Keep Task → members → policy order; the caller must check all other required
 * authorities before allowing any out-of-process operation.
 */
export async function lockRegisteredDraftSource(
  tx: Tx,
  sourceId: string,
  route: ManagedSourceModelRoute | undefined,
  now: Date,
  alreadyLockedTask?: TaskRow,
): Promise<{ row: SourcePolicyRow; bytes: Buffer } | undefined> {
  // Binding is immutable. Read it to find the locks, then re-read the revoke fact.
  const [probe] = await tx.select().from(policy).where(eq(policy.id, sourceId))
  if (
    probe === undefined ||
    (alreadyLockedTask !== undefined && probe.taskId !== alreadyLockedTask.id)
  )
    return undefined
  const task = alreadyLockedTask ?? (await getTaskForUpdate(tx, probe.taskId))
  if (task === undefined) return undefined
  const digest = managedDraftModelBindingDigest(route, now)
  if (
    probe.projectId !== task.projectId ||
    !(probe.expiresAt.getTime() > now.getTime()) ||
    digest !== probe.modelBindingDigest
  )
    return undefined
  const current = await loadAgreement(
    tx,
    task,
    probe.ownerUserId,
    probe.recipientUserId,
    probe.revisionId,
  )
  if (
    current === undefined ||
    current.sha256 !== probe.sha256 ||
    current.byteSize !== probe.byteSize
  )
    return undefined
  const [row] = await tx.select().from(policy).where(eq(policy.id, sourceId)).for('share')
  if (row === undefined || row.revokedAt !== null) return undefined
  return { row, bytes: Buffer.from(current.text) }
}

/** Component preparation only. Never reuse this read as a final egress decision. */
export async function loadRegisteredDraftSource(
  database: Database,
  sourceId: string,
  route: ManagedSourceModelRoute | undefined,
  now: Date,
): Promise<{ policy: SourcePolicyView; bytes: Buffer } | undefined> {
  return database.transaction(async (tx) => {
    const loaded = await lockRegisteredDraftSource(tx, sourceId, route, now)
    return loaded === undefined ? undefined : { policy: view(loaded.row), bytes: loaded.bytes }
  })
}

export async function revokeManagedDraftSource(
  database: Database,
  actorUserId: string,
  sourceId: string,
  now: Date,
  expectedTaskId?: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [probe] = await tx
      .select({ taskId: policy.taskId })
      .from(policy)
      .where(eq(policy.id, sourceId))
    if (
      probe === undefined ||
      (expectedTaskId !== undefined && probe.taskId !== expectedTaskId) ||
      (await getTaskForUpdate(tx, probe.taskId)) === undefined
    )
      throw notFound()
    const [row] = await tx.select().from(policy).where(eq(policy.id, sourceId)).for('update')
    const team = await getTeam(tx)
    if (
      row === undefined ||
      row.ownerUserId !== actorUserId ||
      team === undefined ||
      (await getEnabledMember(tx, team.id, actorUserId)) === undefined
    )
      throw notFound()
    if (row.revokedAt === null)
      await tx.update(policy).set({ revokedAt: now }).where(eq(policy.id, sourceId))
  })
}
