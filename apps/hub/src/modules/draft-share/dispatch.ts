import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  ackInTransaction,
  appendTeamEvent,
  failInTransaction,
  getDeviceForShare,
  getOutboxCommand,
  getProfileRevision,
  insertRun,
  schema,
  type Database,
  type DispatchIntentRow,
  type Outbox,
  type Tx,
} from '@whalepod/db'
import {
  MANAGED_DRAFT_CONTROL_VERSION,
  MANAGED_DRAFT_PREPARATION_MAX_AGE_MS,
  ManagedDraftStartSchema,
  type NodeDownstream,
} from '@whalepod/protocol'
import type { WebSocket } from 'ws'
import type { ManagedDraftHost } from '../../config.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { nodeConnections } from '../device/connection-registry.js'
import type { DeviceGateway } from '../run/device-gateway.js'
import { cancelRunInTransaction } from '../run/cancel.js'
import { ApiError } from '../shared/http-error.js'
import { lockWorkContext } from '../work/context.js'
import { verifyRunMachineDispatch } from '../work/run-dispatch.js'
import { prepareManagedDraftSourceManifest } from './source-manifest.js'
import type { ManagedSourceModelRoute } from './source-registry.js'

export interface ManagedDraftPlacement {
  readonly host: ManagedDraftHost
  readonly modelRoute: ManagedSourceModelRoute
}

const unavailable = () =>
  new ApiError(409, 'CONFLICT', 'managed draft source preparation is unavailable')
type Offer = Extract<NodeDownstream, { type: 'managed_draft.start' }>

async function verifyPlacement(tx: Tx, placement: ManagedDraftPlacement) {
  const { host, modelRoute } = placement
  const device = await getDeviceForShare(tx, host.deviceId)
  if (device?.ownerUserId !== host.ownerUserId || device.revokedAt !== null) return undefined
  const [workspace] = await tx
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, host.workspaceId))
    .for('share')
  if (
    workspace?.deviceId !== host.deviceId ||
    workspace.ownerUserId !== host.ownerUserId ||
    !workspace.available
  )
    return undefined
  const revision = await getProfileRevision(tx, host.profileRevisionId)
  if (revision?.provider !== modelRoute.provider || revision.model !== modelRoute.model)
    return undefined
  return revision
}

/** A transport preparation creates a sealed queued Run and body-free command, with no model rights. */
export async function queueManagedDraftPreparation(
  tx: Tx,
  outbox: Outbox,
  input: {
    placement: ManagedDraftPlacement
    workKey: string
    actorUserId: string
    sourceId: string
    intent: DispatchIntentRow
    agentId: string
    now: Date
  },
) {
  const { host, modelRoute } = input.placement
  if (!nodeConnections.isManagedDraftOnline(host) || host.ownerUserId !== input.actorUserId)
    throw unavailable()
  const runId = randomUUID()
  const prepared = await prepareManagedDraftSourceManifest(
    tx,
    { ...input, runId },
    host,
    modelRoute,
    input.now,
  )
  if (
    prepared === undefined ||
    prepared.manifest.mandateId !== input.intent.mandateId ||
    prepared.manifest.mandateVersion !== input.intent.mandateVersion
  )
    throw unavailable()
  const revision = await verifyPlacement(tx, input.placement)
  if (revision?.agentId !== input.agentId) throw unavailable()
  const [pack] = await tx
    .select({ digest: schema.pluginPacks.packDigest })
    .from(schema.pluginPacks)
    .where(eq(schema.pluginPacks.id, revision.pluginPackId))
  if (pack === undefined) throw unavailable()
  const { manifest, manifestDigest } = prepared
  const run = await insertRun(tx, {
    id: runId,
    taskId: manifest.taskId,
    ownerUserId: manifest.ownerUserId,
    agentId: revision.agentId,
    profileRevisionId: revision.id,
    deviceId: host.deviceId,
    workspaceId: host.workspaceId,
    profileDigest: revision.profileDigest,
    pluginPackDigest: pack.digest,
    dshDistributionVersion: MANAGED_DRAFT_CONTROL_VERSION,
    specRevisionId: manifest.source.revisionId,
    origin: 'mandate',
    mandateId: manifest.mandateId,
    dispatchIntentId: input.intent.id,
    onBehalfOfUserId: manifest.ownerUserId,
    workKey: manifest.workKey,
    approvalPolicy: 'approval_required',
    artifactInputManifest: { taskId: manifest.taskId, artifacts: [] },
    resumeContext: 'blocked',
    managedDraftSourceDigest: manifestDigest,
    managedDraftPreparation: true,
    createdAt: input.now,
  })
  const commandId = randomUUID()
  await outbox.enqueue(tx, {
    id: commandId,
    deviceId: host.deviceId,
    type: 'managed_draft.start',
    payload: ManagedDraftStartSchema.shape.payload.parse({ commandId, manifest, manifestDigest }),
    notBefore: input.now,
  })
  await appendTeamEvent(tx, {
    type: 'run.changed',
    payload: { runId, taskId: run.taskId, status: 'queued' },
  })
  return run
}

/** The actual socket send is enclosed by the authority transaction. Nothing sends source bytes. */
export class ManagedDraftTransport {
  constructor(
    private readonly database: Database,
    private readonly outbox: Outbox,
    private readonly placement: ManagedDraftPlacement | undefined,
  ) {}

  private async withOffer<T>(
    deviceId: string,
    payload: Offer['payload'],
    apply: (
      tx: Tx,
      valid: boolean,
      run: typeof schema.runs.$inferSelect,
      now: Date,
      command: typeof schema.dispatchOutbox.$inferSelect,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    const { manifest, manifestDigest, commandId } = payload
    if (sha256Hex(canonicalJson(manifest)) !== manifestDigest) return undefined
    return this.database.transaction(async (tx) => {
      const { work, task } = await lockWorkContext(tx, manifest.workKey)
      if (task.id !== manifest.taskId || work.projectId !== manifest.projectId) return undefined
      const placement = this.placement
      const now = new Date()
      const frozen =
        placement === undefined
          ? undefined
          : await prepareManagedDraftSourceManifest(
              tx,
              {
                actorUserId: manifest.ownerUserId,
                workKey: manifest.workKey,
                runId: manifest.runId,
                sourceId: manifest.source.policyId,
              },
              placement.host,
              placement.modelRoute,
              now,
              true,
            )
      const currentPlacement =
        placement === undefined || frozen === undefined
          ? undefined
          : await verifyPlacement(tx, placement)
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, manifest.runId))
        .for('update')
      if (
        run === undefined ||
        run.status !== 'queued' ||
        !run.managedDraftPreparation ||
        run.managedDraftSourceDigest !== manifestDigest ||
        run.taskId !== task.id ||
        run.workKey !== work.workKey ||
        run.deviceId !== deviceId
      )
        return undefined
      const [command] = await tx
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.id, commandId))
        .for('update')
      if (
        command?.type !== 'managed_draft.start' ||
        command.deviceId !== deviceId ||
        command.ackedAt !== null ||
        command.failedAt !== null
      )
        return undefined
      const valid =
        frozen?.manifestDigest === manifestDigest &&
        currentPlacement?.id === run.profileRevisionId &&
        run.mandateInvalidatedAt === null &&
        now.getTime() < run.createdAt.getTime() + MANAGED_DRAFT_PREPARATION_MAX_AGE_MS &&
        (await verifyRunMachineDispatch(tx, run, now)).ok
      return apply(tx, valid, run, now, command)
    })
  }

  async send(deviceId: string, frame: Offer, gateway: DeviceGateway): Promise<boolean> {
    return (
      (await this.withOffer(deviceId, frame.payload, async (tx, valid, run, _now, command) => {
        const now = new Date()
        if (
          !valid ||
          now.getTime() >= run.createdAt.getTime() + MANAGED_DRAFT_PREPARATION_MAX_AGE_MS
        ) {
          await cancelRunInTransaction(tx, { outbox: this.outbox, now }, run, 'admin')
          return false
        }
        await gateway.send(deviceId, frame)
        if (command.sentAt === null) {
          await tx
            .update(schema.dispatchOutbox)
            .set({ sentAt: now })
            .where(eq(schema.dispatchOutbox.id, frame.payload.commandId))
        }
        return true
      })) === true
    )
  }

  async receive(
    host: ManagedDraftHost,
    socket: WebSocket,
    ack: { commandId: string; accepted: boolean },
  ): Promise<boolean> {
    if (this.placement?.host !== host || !nodeConnections.isCurrent(host.deviceId, socket))
      return false
    const command = await getOutboxCommand(this.database.db, ack.commandId)
    if (command?.type !== 'managed_draft.start' || command.deviceId !== host.deviceId) return false
    const parsed = ManagedDraftStartSchema.shape.payload.safeParse(command.payload)
    if (!parsed.success) return false
    return (
      (await this.withOffer(host.deviceId, parsed.data, async (tx, valid, run, _now, current) => {
        if (current.sentAt === null || !nodeConnections.isCurrent(host.deviceId, socket))
          return false
        const now = new Date()
        const timely =
          now.getTime() < Date.parse(parsed.data.manifest.expiresAt) &&
          now.getTime() < run.createdAt.getTime() + MANAGED_DRAFT_PREPARATION_MAX_AGE_MS
        const accepted = valid && timely && ack.accepted
        if (accepted) await ackInTransaction(tx, current.id, now)
        else await failInTransaction(tx, current.id, now)
        // This is a transport receipt only. The preparation cannot become a running Run.
        await cancelRunInTransaction(tx, { outbox: this.outbox, now }, run, 'admin')
        return accepted
      })) === true
    )
  }
}
