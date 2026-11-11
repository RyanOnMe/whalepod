import { createHash, randomUUID } from 'node:crypto'
import { eq, or } from 'drizzle-orm'
import {
  ackInTransaction,
  appendTeamEvent,
  failInTransaction,
  getOutboxCommand,
  insertArtifact,
  schema,
  unwrapPgError,
  type Database,
  type Outbox,
  type RunRow,
  type Tx,
} from '@whalepod/db'
import { transitionRun } from '@whalepod/domain'
import {
  buildManagedDraftModelBody,
  MANAGED_DRAFT_EXECUTION_CHECK_MAX_AGE_MS,
  ManagedDraftExecuteSchema,
  type ManagedDraftCandidateProof,
  type ManagedDraftCandidateUpload,
  type ManagedDraftModelForwardRequestSchema,
  type ManagedDraftOutcomeSchema,
  type ManagedDraftSourceReadRequestSchema,
  type NodeDownstream,
} from '@whalepod/protocol'
import type { WebSocket } from 'ws'
import type { z } from 'zod'
import type { ManagedDraftHost } from '../../config.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { nodeConnections, NodeOfflineError } from '../device/connection-registry.js'
import { applyRunStatus } from '../run/run-status.js'
import { lockWorkContext } from '../work/context.js'
import { verifyRunMachineDispatch } from '../work/run-dispatch.js'
import type { ManagedDraftCandidateStore } from './candidate-store.js'
import { verifyManagedDraftPlacement, type ManagedDraftPlacement } from './dispatch.js'
import { forwardManagedDraftLoopback } from './loopback-broker.js'
import { loadManagedDraftSourceManifest } from './source-manifest.js'

type Offer = Extract<NodeDownstream, { type: 'managed_draft.execute' }>
type Binding = { readonly commandId: string; readonly manifestDigest: string }
type ExecutionRow = typeof schema.managedDraftExecutions.$inferSelect
const executions = schema.managedDraftExecutions
const candidates = schema.managedDraftCandidates
const active = new Set<RunRow['status']>(['queued', 'dispatching', 'running'])
class ManagedDraftCommitDenied extends Error {}

interface LockedExecution {
  readonly tx: Tx
  readonly offer: Offer['payload']
  readonly run: RunRow
  readonly row: ExecutionRow
  readonly connectionId: string | undefined
  readonly authorizedBytes: Buffer | undefined
  readonly now: Date
  readonly expiresAtMs: number
}

interface Admission<T> {
  readonly value: T
  readonly connectionId: string
  readonly expiresAtMs: number
}

/** The Hub owns the sole loopback request; neither a permit nor a model route leaves it. */
export class ManagedDraftExecution {
  constructor(
    private readonly database: Database,
    private readonly outbox: Outbox,
    private readonly placement: ManagedDraftPlacement | undefined,
    private readonly loopbackEndpoint: URL | undefined,
    private readonly candidateStore: ManagedDraftCandidateStore,
  ) {}

  private async withRun<T>(
    runId: string,
    binding: Binding,
    apply: (scope: LockedExecution) => Promise<T>,
  ): Promise<T | undefined> {
    const placement = this.placement
    if (
      placement === undefined ||
      this.loopbackEndpoint === undefined ||
      placement.modelRoute.endpointDigest !== sha256Hex(this.loopbackEndpoint.href)
    )
      return undefined
    const command = await getOutboxCommand(this.database.db, binding.commandId)
    if (command?.type !== 'managed_draft.execute' || command.deviceId !== placement.host.deviceId)
      return undefined
    const parsed = ManagedDraftExecuteSchema.shape.payload.safeParse(command.payload)
    if (!parsed.success) return undefined
    const offer = parsed.data
    const { manifest, manifestDigest } = offer
    if (
      manifest.runId !== runId ||
      offer.commandId !== binding.commandId ||
      manifestDigest !== binding.manifestDigest ||
      sha256Hex(canonicalJson(manifest)) !== manifestDigest ||
      offer.model !== placement.modelRoute.model
    )
      return undefined
    return this.database.transaction(async (tx) => {
      const { task } = await lockWorkContext(tx, manifest.workKey)
      if (task.id !== manifest.taskId) return undefined
      const loaded = await loadManagedDraftSourceManifest(
        tx,
        {
          actorUserId: manifest.ownerUserId,
          workKey: manifest.workKey,
          runId,
          sourceId: manifest.source.policyId,
        },
        placement.host,
        placement.modelRoute,
        new Date(),
        true,
      )
      const revision =
        loaded === undefined ? undefined : await verifyManagedDraftPlacement(tx, placement)
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update')
      if (
        run === undefined ||
        !active.has(run.status) ||
        !run.managedDraftPreparation ||
        run.managedDraftSourceDigest !== manifestDigest ||
        run.taskId !== task.id ||
        run.workKey !== manifest.workKey ||
        run.deviceId !== placement.host.deviceId
      )
        return undefined
      const [row] = await tx
        .select()
        .from(executions)
        .where(eq(executions.runId, runId))
        .for('update')
      if (row?.commandId !== binding.commandId) return undefined
      // The outbox may be held by a concurrent claim or cancel. Finish acquiring all
      // durable locks before the final wall-clock and live-attachment check.
      const [currentCommand] = await tx
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.id, binding.commandId))
        .for('update')
      if (currentCommand?.type !== 'managed_draft.execute' || currentCommand.failedAt !== null)
        return undefined
      const authorized =
        loaded?.manifestDigest === manifestDigest &&
        revision?.id === run.profileRevisionId &&
        run.mandateInvalidatedAt === null &&
        (await verifyRunMachineDispatch(tx, run, new Date())).ok
      const now = new Date()
      const expiresAtMs = Math.min(
        Date.parse(manifest.expiresAt),
        run.createdAt.getTime() + MANAGED_DRAFT_EXECUTION_CHECK_MAX_AGE_MS,
      )
      const fresh = now.getTime() < expiresAtMs
      return apply({
        tx,
        offer,
        run,
        row,
        now,
        expiresAtMs,
        connectionId: nodeConnections.managedDraftConnectionId(placement.host, true),
        authorizedBytes: authorized && fresh ? loaded?.bytes : undefined,
      })
    })
  }

  /** Persist the exact WS attachment before offering. A crash or disconnect never re-offers this Run. */
  async send(deviceId: string, frame: Offer): Promise<'sent' | 'skip' | 'rejected'> {
    const host = this.placement?.host
    if (host?.deviceId !== deviceId) return 'rejected'
    const decision = await this.withRun(
      frame.payload.manifest.runId,
      frame.payload,
      async (scope) => {
        if (scope.row.offeredAt !== null) return 'skip' as const
        if (scope.authorizedBytes === undefined) {
          await this.finish(scope, 'failed')
          return 'rejected' as const
        }
        if (scope.connectionId === undefined) throw new NodeOfflineError()
        await scope.tx
          .update(executions)
          .set({ connectionId: scope.connectionId, offeredAt: scope.now })
          .where(eq(executions.runId, scope.run.id))
        await scope.tx
          .update(schema.dispatchOutbox)
          .set({ sentAt: scope.now })
          .where(eq(schema.dispatchOutbox.id, scope.row.commandId))
        return {
          connectionId: scope.connectionId,
          expiresAtMs: scope.expiresAtMs,
          offer: scope.offer,
        }
      },
    )
    if (decision === undefined) return 'rejected'
    if (typeof decision === 'string') return decision
    if (!this.current(decision)) return 'skip'
    nodeConnections.sendManagedDraftExecution(host, decision.connectionId, {
      ...frame,
      payload: decision.offer,
    })
    return 'sent'
  }

  async source(
    runId: string,
    request: z.infer<typeof ManagedDraftSourceReadRequestSchema>,
  ): Promise<Buffer | undefined> {
    const admission = await this.withRun(runId, request, async (scope) => {
      if (
        scope.authorizedBytes === undefined ||
        !this.isOffered(scope) ||
        scope.row.sourceReadAt !== null ||
        scope.run.status !== 'queued'
      )
        return undefined
      if (!(await ackInTransaction(scope.tx, scope.row.commandId, scope.now))) return undefined
      await scope.tx
        .update(executions)
        .set({ sourceRequestId: request.requestId, sourceReadAt: scope.now })
        .where(eq(executions.runId, runId))
      const state = transitionRun(scope.run, { type: 'dispatch_acked' })
      await applyRunStatus(scope.tx, this.outbox, runId, state.status)
      return this.admission(scope, scope.authorizedBytes)
    })
    return admission !== undefined && this.current(admission) ? admission.value : undefined
  }

  async model(
    runId: string,
    request: z.infer<typeof ManagedDraftModelForwardRequestSchema>,
    signal: AbortSignal,
  ): Promise<{ attemptId: string; text: string } | undefined> {
    const endpoint = this.loopbackEndpoint
    if (endpoint === undefined || signal.aborted) return undefined
    const admission = await this.withRun(runId, request, async (scope) => {
      if (
        signal.aborted ||
        scope.authorizedBytes === undefined ||
        !this.isOffered(scope) ||
        scope.run.status !== 'dispatching' ||
        scope.row.sourceReadAt === null ||
        scope.row.modelAttemptId !== null ||
        scope.offer.manifest.modelBindingDigest !== request.modelBindingDigest
      )
        return undefined
      const text = new TextDecoder('utf-8', { fatal: true }).decode(scope.authorizedBytes)
      const body = Buffer.from(buildManagedDraftModelBody(scope.offer.model, text))
      if (
        body.byteLength !== request.byteSize ||
        createHash('sha256').update(body).digest('hex') !== request.requestDigest
      )
        return undefined
      // The Run lock serializes distinct attempts; the ledger also prevents reusing an attempt id across Runs.
      await scope.tx
        .update(executions)
        .set({
          modelAttemptId: request.attemptId,
          modelRequestDigest: request.requestDigest,
          modelRequestByteSize: request.byteSize,
          modelDecidedAt: scope.now,
        })
        .where(eq(executions.runId, runId))
      const state = transitionRun(scope.run, { type: 'runtime_ready' })
      await applyRunStatus(scope.tx, this.outbox, runId, state.status, { startedAt: scope.now })
      return this.admission(scope, body)
    })
    if (admission === undefined || signal.aborted || !this.current(admission)) return undefined
    const host = this.placement?.host
    if (host === undefined) return undefined
    const attachmentSignal = nodeConnections.managedDraftExecutionSignal(
      host,
      admission.connectionId,
    )
    if (attachmentSignal === undefined) return undefined
    const transferSignal = AbortSignal.any([signal, attachmentSignal])
    // Await the committed one-time decision above; never wait for provider IO inside the transaction.
    let result: Awaited<ReturnType<typeof forwardManagedDraftLoopback>>
    try {
      result = await forwardManagedDraftLoopback(endpoint, admission.value, transferSignal)
    } catch {
      return undefined
    }
    const response = await this.withRun(runId, request, async (scope) => {
      if (
        transferSignal.aborted ||
        scope.authorizedBytes === undefined ||
        !this.isOffered(scope) ||
        scope.run.status !== 'running' ||
        scope.row.modelAttemptId !== request.attemptId ||
        scope.row.modelRespondedAt !== null
      )
        return undefined
      await scope.tx
        .update(executions)
        .set({
          modelRespondedAt: scope.now,
          modelResponseSha256: sha256Hex(result.text),
          modelResponseByteSize: Buffer.byteLength(result.text),
        })
        .where(eq(executions.runId, runId))
      return this.admission(scope, { attemptId: request.attemptId, text: result.text })
    })
    return response !== undefined && this.current(response) ? response.value : undefined
  }

  /** Persist a single newly written candidate from the exact managed attachment and model output. */
  async candidate(
    runId: string,
    request: ManagedDraftCandidateUpload,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<ManagedDraftCandidateProof | undefined> {
    if (
      signal.aborted ||
      bytes.length !== request.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== request.sha256
    )
      return undefined
    try {
      const receipt = await this.withRun(runId, request, async (scope) => {
        if (
          signal.aborted ||
          scope.authorizedBytes === undefined ||
          !this.isOffered(scope) ||
          scope.run.status !== 'running' ||
          scope.row.modelAttemptId !== request.modelAttemptId ||
          scope.row.modelRespondedAt === null ||
          scope.row.modelResponseSha256 !== request.sha256 ||
          scope.row.modelResponseByteSize !== request.byteSize
        )
          return undefined
        const [existing] = await scope.tx
          .select({ runId: candidates.runId })
          .from(candidates)
          .where(
            or(
              eq(candidates.runId, runId),
              eq(candidates.fileWriteReceiptId, request.fileWriteReceiptId),
            ),
          )
          .limit(1)
        const admission = this.admission(scope, true)
        if (
          existing !== undefined ||
          admission === undefined ||
          !this.current(admission) ||
          signal.aborted
        )
          return undefined

        // The complete request is already in memory. Only bounded, private disk IO holds the
        // Task lock; revocation and artifact admission serialize at this same boundary.
        const storageKey = await this.candidateStore.saveUpload(request.sha256, bytes)
        if (!this.current(admission) || signal.aborted) return undefined

        const artifactId = randomUUID()
        const verifiedUploadReceiptId = randomUUID()
        const verifiedAt = new Date()
        const proof: ManagedDraftCandidateProof = {
          runId,
          manifestDigest: request.manifestDigest,
          artifactId,
          sha256: request.sha256,
          byteSize: request.byteSize,
          fileWriteReceiptId: request.fileWriteReceiptId,
          verifiedUploadReceiptId,
        }
        await insertArtifact(scope.tx, {
          id: artifactId,
          taskId: scope.run.taskId,
          runId,
          ownerUserId: scope.offer.manifest.ownerUserId,
          title: '受管草稿',
          mediaType: 'text/plain',
          storageKey,
          sha256: request.sha256,
          byteSize: request.byteSize,
        })
        await scope.tx.insert(candidates).values({
          ...proof,
          sourcePolicyId: scope.offer.manifest.source.policyId,
          modelAttemptId: request.modelAttemptId,
          verifiedAt,
        })
        if (!this.current(admission) || signal.aborted) throw new ManagedDraftCommitDenied()
        return this.admission(scope, proof)
      })
      return receipt !== undefined && this.current(receipt) && !signal.aborted
        ? receipt.value
        : undefined
    } catch (error) {
      // Another Run can race using the same write receipt. PG rejects the loser and rolls
      // back its Artifact. Content-addressed bytes left without a row are inaccessible.
      if (error instanceof ManagedDraftCommitDenied) return undefined
      const pg = unwrapPgError(error)
      if (
        pg?.code === '23505' &&
        pg.constraintName === 'managed_draft_candidate_file_write_receipt_id_key'
      )
        return undefined
      throw error
    }
  }

  private admission<T>(scope: LockedExecution, value: T): Admission<T> | undefined {
    return scope.connectionId === undefined
      ? undefined
      : { value, connectionId: scope.connectionId, expiresAtMs: scope.expiresAtMs }
  }

  private current(admission: Omit<Admission<unknown>, 'value'>): boolean {
    const host = this.placement?.host
    return (
      host !== undefined &&
      Date.now() < admission.expiresAtMs &&
      nodeConnections.managedDraftConnectionId(host, true) === admission.connectionId
    )
  }

  private isOffered(scope: LockedExecution): boolean {
    return scope.row.connectionId !== null && scope.row.connectionId === scope.connectionId
  }

  async receive(
    host: ManagedDraftHost,
    socket: WebSocket,
    receipt: z.infer<typeof ManagedDraftOutcomeSchema.shape.payload>,
  ): Promise<void> {
    if (this.placement?.host !== host || !nodeConnections.isCurrent(host.deviceId, socket)) return
    try {
      await this.withRun(receipt.runId, receipt, async (scope) => {
        if (!this.isOffered(scope) || !nodeConnections.isCurrent(host.deviceId, socket)) return
        if (receipt.outcome === 'failed') {
          await this.finish(scope, 'failed')
          return
        }
        if (
          scope.run.status !== 'running' ||
          scope.authorizedBytes === undefined ||
          scope.row.modelAttemptId !== receipt.attemptId ||
          scope.row.modelRespondedAt === null
        )
          return
        const [candidate] = await scope.tx
          .select()
          .from(candidates)
          .where(eq(candidates.runId, scope.run.id))
        const admission = this.admission(scope, true)
        if (
          candidate === undefined ||
          candidate.artifactId !== receipt.artifactId ||
          candidate.verifiedUploadReceiptId !== receipt.verifiedUploadReceiptId ||
          candidate.modelAttemptId !== receipt.attemptId ||
          candidate.manifestDigest !== receipt.manifestDigest ||
          candidate.sourcePolicyId !== scope.offer.manifest.source.policyId ||
          candidate.sha256 !== scope.row.modelResponseSha256 ||
          candidate.byteSize !== scope.row.modelResponseByteSize ||
          admission === undefined ||
          !this.current(admission) ||
          !nodeConnections.isCurrent(host.deviceId, socket)
        )
          return
        await this.finish(scope, 'completed')
        if (!this.current(admission) || !nodeConnections.isCurrent(host.deviceId, socket))
          throw new ManagedDraftCommitDenied()
      })
    } catch (error) {
      if (!(error instanceof ManagedDraftCommitDenied)) throw error
    }
  }

  private async finish(scope: LockedExecution, kind: 'completed' | 'failed'): Promise<void> {
    const state = transitionRun(scope.run, { type: kind })
    if (kind === 'failed') await failInTransaction(scope.tx, scope.row.commandId, scope.now)
    await applyRunStatus(scope.tx, this.outbox, scope.run.id, state.status, {
      finishedAt: scope.now,
    })
    await appendTeamEvent(scope.tx, {
      type: 'run.changed',
      payload: {
        runId: scope.run.id,
        taskId: scope.run.taskId,
        status: state.status,
      },
    })
  }
}
