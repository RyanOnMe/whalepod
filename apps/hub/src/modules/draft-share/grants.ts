import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import {
  findCommandReceipt,
  getOutboxCommand,
  getTaskForUpdate,
  getWorkMandateForUpdate,
  schema,
  type Database,
  type Tx,
} from '@whalepod/db'
import { ManagedDraftExecuteSchema } from '@whalepod/protocol'
import type { SessionActor } from '../auth/session.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { lockWorkContext } from '../work/context.js'
import type { ManagedDraftCandidateStore } from './candidate-store.js'
import { checkDraftShareEligibility } from './eligibility.js'
import { lockRegisteredDraftSource, type ManagedSourceModelRoute } from './source-registry.js'

const {
  artifacts,
  authSessions,
  draftShareGrants: grants,
  draftShareReadAdmissions: admissions,
} = schema
type Grant = typeof grants.$inferSelect
type Artifact = typeof artifacts.$inferSelect
type GrantView = Pick<Grant, 'state'> & { grantId: string; expiresAt: string }
type CurrentCandidate = {
  artifact: Artifact
  projectId: string
  workKey: string
  sourcePolicyId: string
  sourcePolicyDigest: string
  mandateId: string
  mandateVersion: number
  sourceManifestDigest: string
  modelBindingDigest: string
  verifiedUploadReceiptId: string
  recipientUserId: string
  expiresAtMs: number
}
type Actor = Pick<SessionActor, 'sessionId' | 'userId'>
type Offer = {
  recipientUserId: string
  sha256: string
  reviewReceiptId: string
  expiresAt: Date
  replaceGrantId?: string | undefined
  idempotencyKey: string
}

const openStates = ['offered', 'active'] as const
const isOpen = (grant: Grant) => grant.state === 'offered' || grant.state === 'active'
const missing = () => new ApiError(404, 'NOT_FOUND', 'draft not found')
const conflict = () =>
  new ApiError(409, 'CONFLICT', 'a grant for this draft and recipient already exists')
const view = (grant: Grant): GrantView => ({
  grantId: grant.id,
  state: grant.state,
  expiresAt: grant.expiresAt.toISOString(),
})

function matches(grant: Grant, candidate: CurrentCandidate, now: number): boolean {
  const { artifact } = candidate
  return (
    isOpen(grant) &&
    grant.expiresAt.getTime() > now &&
    grant.expiresAt.getTime() <= candidate.expiresAtMs &&
    grant.projectId === candidate.projectId &&
    grant.taskId === artifact.taskId &&
    grant.workKey === candidate.workKey &&
    grant.runId === artifact.runId &&
    grant.artifactId === artifact.id &&
    grant.sourcePolicyId === candidate.sourcePolicyId &&
    grant.sourcePolicyDigest === candidate.sourcePolicyDigest &&
    grant.mandateId === candidate.mandateId &&
    grant.mandateVersion === candidate.mandateVersion &&
    grant.sourceManifestDigest === candidate.sourceManifestDigest &&
    grant.modelBindingDigest === candidate.modelBindingDigest &&
    grant.verifiedUploadReceiptId === candidate.verifiedUploadReceiptId &&
    grant.grantorUserId === artifact.ownerUserId &&
    grant.recipientUserId === candidate.recipientUserId &&
    grant.sha256 === artifact.sha256 &&
    grant.byteSize === artifact.byteSize
  )
}

async function lockSession(tx: Tx, actor: Actor): Promise<number> {
  const [row] = await tx
    .select({ revokedAt: authSessions.revokedAt, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(and(eq(authSessions.id, actor.sessionId), eq(authSessions.userId, actor.userId)))
    .for('share')
  if (row === undefined || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now())
    throw missing()
  return row.expiresAt.getTime()
}

/** Record a key binding without trusting its cached result as current authorization. */
async function bindAction(
  tx: Tx,
  actor: Actor,
  grant: Grant,
  operation: 'accept' | 'revoked' | 'declined',
  idempotencyKey: string,
): Promise<void> {
  const key = `draft-share.action:${actor.userId}:${sha256Hex(idempotencyKey)}`
  const requestDigest = sha256Hex(
    canonicalJson({
      actorUserId: actor.userId,
      grantId: grant.id,
      artifactId: grant.artifactId,
      sha256: grant.sha256,
      verifiedUploadReceiptId: grant.verifiedUploadReceiptId,
      operation,
    }),
  )
  const receipts = schema.commandReceipts
  const [inserted] = await tx
    .insert(receipts)
    .values({ key, result: { requestDigest } })
    .onConflictDoNothing({ target: receipts.key })
    .returning({ key: receipts.key })
  if (inserted === undefined) {
    const prior = await findCommandReceipt(tx, key)
    if ((prior?.result as { requestDigest?: string } | undefined)?.requestDigest !== requestDigest)
      throw new ApiError(409, 'CONFLICT', 'draft action does not match the original request')
  }
}

export class DraftShareGrants {
  constructor(
    private readonly database: Database,
    private readonly store: ManagedDraftCandidateStore,
    private readonly modelRoute: ManagedSourceModelRoute,
  ) {}

  /**
   * Initial pointer probes do not grant access. Lock order matches managed execution:
   * Task → Work → Mandate → members/source policy → Run → Artifact → session → grant.
   * The verified output receipt and original command payload only have immutable identities.
   */
  private async lockCandidate(
    tx: Tx,
    artifactId: string,
    grantorUserId: string,
  ): Promise<CurrentCandidate> {
    const receipts = schema.managedDraftCandidates
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.artifactId, artifactId))
    if (receipt === undefined) throw missing()
    const executions = schema.managedDraftExecutions
    const [execution] = await tx
      .select()
      .from(executions)
      .where(eq(executions.runId, receipt.runId))
    if (
      execution?.modelAttemptId !== receipt.modelAttemptId ||
      execution.modelRespondedAt === null ||
      execution.modelResponseSha256 !== receipt.sha256 ||
      execution.modelResponseByteSize !== receipt.byteSize
    )
      throw missing()
    const command = await getOutboxCommand(tx, execution.commandId)
    if (
      command?.type !== 'managed_draft.execute' ||
      command.ackedAt === null ||
      command.failedAt !== null
    )
      throw missing()
    const parsed = ManagedDraftExecuteSchema.shape.payload.safeParse(command.payload)
    if (!parsed.success) throw missing()
    const { manifest, manifestDigest } = parsed.data
    if (
      manifest.ownerUserId !== grantorUserId ||
      manifest.runId !== receipt.runId ||
      manifest.source.policyId !== receipt.sourcePolicyId ||
      manifestDigest !== receipt.manifestDigest ||
      manifestDigest !== sha256Hex(canonicalJson(manifest))
    )
      throw missing()

    const { task, work } = await lockWorkContext(tx, manifest.workKey)
    if (
      task.id !== manifest.taskId ||
      task.projectId !== manifest.projectId ||
      work.projectId !== manifest.projectId ||
      work.mandateId !== manifest.mandateId
    )
      throw missing()
    const mandate = await getWorkMandateForUpdate(tx, manifest.mandateId)
    if (
      mandate === undefined ||
      mandate.status !== 'active' ||
      mandate.version !== manifest.mandateVersion ||
      mandate.workId !== work.id ||
      mandate.taskId !== task.id ||
      mandate.projectId !== task.projectId ||
      mandate.onBehalfOfUserId !== grantorUserId ||
      mandate.humanOwnerUserId !== grantorUserId ||
      mandate.draftRecipientUserId !== grantorUserId ||
      !mandate.allowedActionClasses.includes('draft')
    )
      throw missing()
    const source = await lockRegisteredDraftSource(
      tx,
      receipt.sourcePolicyId,
      this.modelRoute,
      new Date(),
      task,
    )
    if (
      source === undefined ||
      source.row.ownerUserId !== grantorUserId ||
      source.row.revisionId !== manifest.source.revisionId ||
      source.row.sha256 !== manifest.source.sha256 ||
      source.row.byteSize !== manifest.source.byteSize ||
      source.row.modelBindingDigest !== manifest.modelBindingDigest
    )
      throw missing()

    const [run] = await tx
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, receipt.runId))
      .for('share')
    const [artifact] = await tx
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .for('share')
    if (
      run === undefined ||
      artifact === undefined ||
      run.mandateInvalidatedAt !== null ||
      run.deviceId !== manifest.deviceId ||
      run.workspaceId !== manifest.workspaceId ||
      run.profileRevisionId !== manifest.profileRevisionId ||
      run.specRevisionId !== manifest.source.revisionId ||
      command.deviceId !== run.deviceId
    )
      throw missing()

    const binding = { id: source.row.id, contentSha256: source.row.sha256, generation: 1 }
    const modelPolicy = {
      id: manifest.modelBindingDigest,
      generation: this.modelRoute.policyGeneration,
    }
    const eligible = checkDraftShareEligibility(
      {
        grantorUserId,
        recipientUserId: source.row.recipientUserId,
        // lockRegisteredDraftSource requires both still-enabled members and the current
        // eligible Task, project, confirmed agreement and exact immutable source policy.
        enabledUserIds: [source.row.ownerUserId, source.row.recipientUserId],
        task: {
          id: task.id,
          projectId: task.projectId,
          assigneeUserId: task.assigneeUserId,
          available: true,
        },
        work: {
          key: work.workKey,
          taskId: work.taskId,
          ownerUserId: work.humanOwnerUserId,
          available:
            work.state === 'active' || (work.state === 'waiting' && work.resumeMode === 'auto'),
        },
        run,
        artifact,
        outputProof: {
          runId: receipt.runId,
          artifactId: receipt.artifactId,
          sourceManifestDigest: receipt.manifestDigest,
          sha256: receipt.sha256,
          byteSize: receipt.byteSize,
          fileWriteReceiptId: receipt.fileWriteReceiptId,
          verifiedUploadReceiptId: receipt.verifiedUploadReceiptId,
        },
        sourceManifest: {
          digest: manifestDigest,
          mandateId: manifest.mandateId,
          mandateVersion: manifest.mandateVersion,
          sources: [binding],
          modelPolicy,
        },
        mandate: {
          id: mandate.id,
          version: mandate.version,
          state: mandate.status,
          principalUserId: mandate.principalUserId,
          workKey: mandate.workKey,
          expiresAt: mandate.expiresAt,
        },
        sourcePolicies: [
          {
            ...binding,
            projectId: source.row.projectId,
            permitsReadRecipient: source.row.recipientUserId,
            active: true,
            expiresAt: source.row.expiresAt,
          },
        ],
        modelPolicy: { ...modelPolicy, active: true },
      },
      new Date(),
    )
    if (!eligible.ok) throw missing()
    const expiresAtMs = Math.min(
      eligible.expiresNoLaterThan.getTime(),
      Date.parse(manifest.expiresAt),
      this.modelRoute.expiresAt.getTime(),
    )
    if (!(expiresAtMs > Date.now())) throw missing()
    return {
      artifact,
      projectId: task.projectId,
      workKey: work.workKey,
      sourcePolicyId: source.row.id,
      sourcePolicyDigest: source.row.sha256,
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      sourceManifestDigest: manifestDigest,
      modelBindingDigest: source.row.modelBindingDigest,
      verifiedUploadReceiptId: receipt.verifiedUploadReceiptId,
      recipientUserId: source.row.recipientUserId,
      expiresAtMs,
    }
  }

  async listCandidates(actor: Actor) {
    const receipts = schema.managedDraftCandidates
    const items = await this.database.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(receipts, eq(receipts.artifactId, artifacts.id))
      .where(and(eq(artifacts.ownerUserId, actor.userId), eq(artifacts.status, 'candidate')))
      .orderBy(desc(artifacts.createdAt))
      .limit(50)
    const visible = []
    for (const { id } of items) {
      const item = await this.optional(() =>
        this.database.transaction(async (tx) => {
          const { artifact, expiresAtMs } = await this.lockCandidate(tx, id, actor.userId)
          const sessionExpiresAt = await lockSession(tx, actor)
          if (Date.now() >= Math.min(sessionExpiresAt, expiresAtMs)) throw missing()
          return {
            artifactId: artifact.id,
            title: artifact.title,
            sha256: artifact.sha256,
            byteSize: artifact.byteSize,
            expiresNoLaterThan: new Date(expiresAtMs).toISOString(),
          }
        }),
      )
      if (item !== undefined) visible.push(item)
    }
    return visible
  }

  async inspect(actor: Actor, artifactId: string) {
    return this.database.transaction(async (tx) => {
      const candidate = await this.lockCandidate(tx, artifactId, actor.userId)
      const sessionExpiresAt = await lockSession(tx, actor)
      return this.admit(tx, actor, candidate, sessionExpiresAt)
    })
  }

  async offer(actor: Actor, artifactId: string, input: Offer): Promise<GrantView> {
    return this.database.transaction(async (tx) => {
      const candidate = await this.lockCandidate(tx, artifactId, actor.userId)
      const sessionExpiresAt = await lockSession(tx, actor)
      if (
        input.recipientUserId !== candidate.recipientUserId ||
        input.sha256 !== candidate.artifact.sha256
      )
        throw missing()
      const [review] = await tx
        .select()
        .from(admissions)
        .where(eq(admissions.id, input.reviewReceiptId))
      if (
        review === undefined ||
        review.grantId !== null ||
        review.actorUserId !== actor.userId ||
        review.artifactId !== artifactId ||
        review.sha256 !== input.sha256 ||
        review.verifiedUploadReceiptId !== candidate.verifiedUploadReceiptId
      )
        throw missing()
      const requestDigest = sha256Hex(
        canonicalJson({
          artifactId,
          recipientUserId: input.recipientUserId,
          sha256: input.sha256,
          expiresAt: input.expiresAt.toISOString(),
          reviewReceiptId: input.reviewReceiptId,
          replaceGrantId: input.replaceGrantId ?? null,
          purpose: 'human_read',
        }),
      )
      const [prior] = await tx
        .select()
        .from(grants)
        .where(
          and(
            eq(grants.grantorUserId, actor.userId),
            eq(grants.artifactId, artifactId),
            eq(grants.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for('update')
      const [open] = await tx
        .select()
        .from(grants)
        .where(
          and(
            eq(grants.artifactId, artifactId),
            eq(grants.recipientUserId, input.recipientUserId),
            inArray(grants.state, openStates),
          ),
        )
        .for('update')
      const now = new Date()
      if (
        now.getTime() >= Math.min(sessionExpiresAt, candidate.expiresAtMs) ||
        !(input.expiresAt.getTime() > now.getTime()) ||
        !(input.expiresAt.getTime() <= candidate.expiresAtMs)
      )
        throw missing()
      if (prior !== undefined) {
        if (prior.requestDigest !== requestDigest) throw conflict()
        if (!matches(prior, candidate, now.getTime())) throw missing()
        return view(prior)
      }
      if (open !== undefined) {
        const expired = open.expiresAt.getTime() <= now.getTime()
        if (input.replaceGrantId !== undefined && input.replaceGrantId !== open.id) throw missing()
        if (!expired && input.replaceGrantId === undefined) throw conflict()
        await tx
          .update(grants)
          .set({
            state: expired ? 'expired' : 'superseded',
            closedAt: now,
          })
          .where(eq(grants.id, open.id))
      } else if (input.replaceGrantId !== undefined) throw missing()
      const [grant] = await tx
        .insert(grants)
        .values({
          id: randomUUID(),
          artifactId,
          projectId: candidate.projectId,
          taskId: candidate.artifact.taskId,
          workKey: candidate.workKey,
          runId: candidate.artifact.runId,
          sourcePolicyId: candidate.sourcePolicyId,
          sourcePolicyDigest: candidate.sourcePolicyDigest,
          mandateId: candidate.mandateId,
          mandateVersion: candidate.mandateVersion,
          sourceManifestDigest: candidate.sourceManifestDigest,
          modelBindingDigest: candidate.modelBindingDigest,
          verifiedUploadReceiptId: candidate.verifiedUploadReceiptId,
          grantorUserId: actor.userId,
          recipientUserId: input.recipientUserId,
          sha256: input.sha256,
          byteSize: candidate.artifact.byteSize,
          expiresAt: input.expiresAt,
          offeredAt: now,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
        })
        .returning()
      if (grant === undefined) throw new Error('draft grant insert returned no row')
      if (
        Date.now() >= Math.min(sessionExpiresAt, candidate.expiresAtMs, input.expiresAt.getTime())
      )
        throw missing()
      return view(grant)
    })
  }

  async listGrants(actor: Actor) {
    const rows = await this.database.db
      .select({ id: grants.id })
      .from(grants)
      .where(
        and(
          or(eq(grants.grantorUserId, actor.userId), eq(grants.recipientUserId, actor.userId)),
          inArray(grants.state, openStates),
        ),
      )
      .orderBy(desc(grants.offeredAt))
      .limit(50)
    const visible = []
    for (const { id } of rows) {
      const entry = await this.optional(() =>
        this.withGrant(actor, id, 'either', async (_tx, grant) =>
          actor.userId === grant.grantorUserId
            ? { ...view(grant), artifactId: grant.artifactId }
            : view(grant),
        ),
      )
      if (entry !== undefined) visible.push(entry)
    }
    return visible
  }

  async accept(actor: Actor, grantId: string, idempotencyKey: string): Promise<GrantView> {
    return this.withGrant(
      actor,
      grantId,
      'recipient',
      async (tx, grant, candidate, _now, sessionExpiresAt) => {
        await bindAction(tx, actor, grant, 'accept', idempotencyKey)
        const deadline = Math.min(
          sessionExpiresAt,
          candidate.expiresAtMs,
          grant.expiresAt.getTime(),
        )
        const now = new Date()
        if (now.getTime() >= deadline) throw missing()
        if (grant.state === 'active') return view(grant)
        const [accepted] = await tx
          .update(grants)
          .set({ state: 'active', acceptedAt: now })
          .where(eq(grants.id, grant.id))
          .returning()
        if (accepted === undefined || Date.now() >= deadline) throw missing()
        return view(accepted)
      },
    )
  }

  async close(
    actor: Actor,
    grantId: string,
    operation: 'revoked' | 'declined',
    idempotencyKey: string,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [probe] = await tx.select().from(grants).where(eq(grants.id, grantId))
      if (
        probe === undefined ||
        !this.ownsGrant(actor, probe, operation === 'declined' ? 'recipient' : 'either')
      )
        throw missing()
      if ((await getTaskForUpdate(tx, probe.taskId)) === undefined) throw missing()
      const expiresAt = await lockSession(tx, actor)
      const [current] = await tx.select().from(grants).where(eq(grants.id, grantId)).for('update')
      if (
        current === undefined ||
        (current.state !== operation &&
          (!isOpen(current) || (operation === 'declined' && current.state !== 'offered')))
      )
        throw missing()
      await bindAction(tx, actor, current, operation, idempotencyKey)
      const now = new Date()
      if (now.getTime() >= expiresAt) throw missing()
      if (current.state === operation) return
      await tx.update(grants).set({ state: operation, closedAt: now }).where(eq(grants.id, grantId))
    })
  }

  async read(actor: Actor, grantId: string) {
    return this.withGrant(
      actor,
      grantId,
      'either',
      async (tx, grant, candidate, _now, sessionExpiresAt) => {
        if (grant.state !== 'active') throw missing()
        return this.admit(
          tx,
          actor,
          candidate,
          Math.min(sessionExpiresAt, grant.expiresAt.getTime()),
          grant.id,
        )
      },
    )
  }

  private ownsGrant(actor: Actor, grant: Grant, audience: 'recipient' | 'either'): boolean {
    return (
      actor.userId === grant.recipientUserId ||
      (audience === 'either' && actor.userId === grant.grantorUserId)
    )
  }

  private async withGrant<T>(
    actor: Actor,
    grantId: string,
    audience: 'recipient' | 'either',
    apply: (
      tx: Tx,
      grant: Grant,
      candidate: CurrentCandidate,
      now: Date,
      sessionExpiresAt: number,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const [probe] = await tx.select().from(grants).where(eq(grants.id, grantId))
      if (probe === undefined || !this.ownsGrant(actor, probe, audience)) throw missing()
      const candidate = await this.lockCandidate(tx, probe.artifactId, probe.grantorUserId)
      const sessionExpiresAt = await lockSession(tx, actor)
      const [grant] = await tx.select().from(grants).where(eq(grants.id, grantId)).for('update')
      const now = new Date()
      if (
        grant === undefined ||
        !this.ownsGrant(actor, grant, audience) ||
        now.getTime() >= sessionExpiresAt ||
        !matches(grant, candidate, now.getTime())
      )
        throw missing()
      return apply(tx, grant, candidate, now, sessionExpiresAt)
    })
  }

  private async admit(
    tx: Tx,
    actor: Actor,
    candidate: CurrentCandidate,
    expiresAtMs: number,
    grantId?: string,
  ) {
    const { artifact } = candidate
    const bytes = await this.store.readVerified(artifact.storageKey, artifact.sha256)
    if (bytes.byteLength !== artifact.byteSize) throw missing()
    // The local verified read is bounded. No response or network work happens
    // while locks are held. The admission commits before the one buffered response.
    const now = new Date()
    if (now.getTime() >= Math.min(expiresAtMs, candidate.expiresAtMs)) throw missing()
    const admissionId = randomUUID()
    await tx.insert(admissions).values({
      id: admissionId,
      grantId: grantId ?? null,
      artifactId: artifact.id,
      actorUserId: actor.userId,
      sha256: artifact.sha256,
      verifiedUploadReceiptId: candidate.verifiedUploadReceiptId,
      admittedAt: now,
    })
    if (Date.now() >= Math.min(expiresAtMs, candidate.expiresAtMs)) throw missing()
    return { bytes, admissionId }
  }

  private async optional<T>(apply: () => Promise<T>): Promise<T | undefined> {
    try {
      return await apply()
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) return undefined
      throw error
    }
  }
}
