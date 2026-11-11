import { and, desc, eq } from 'drizzle-orm'
import {
  getCoordinatorStateForUpdate,
  getCurrentWorkByTask,
  getEnabledMember,
  getProject,
  getRouterConfig,
  getTeam,
  schema,
  transactCommand,
  type Database,
  type TaskMessageRow,
  type TaskRow,
  type Tx,
} from '@whalepod/db'
import type { ConfigureDiscoveryRequest } from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'

export type DiscoveryAdmission = typeof schema.discoveryAdmissions.$inferSelect
export type DiscoveryConfiguration = typeof schema.discoveryConfigurations.$inferSelect
export type DiscoveryConsent = typeof schema.discoveryConsents.$inferSelect
type Actor = { userId: string; role: 'owner' | 'admin' | 'member' }

export function sourceIdentity(message: TaskMessageRow) {
  const sourceVersion = (message.editedAt ?? message.createdAt).toISOString()
  return {
    sourceVersion,
    sourceDigest: sha256Hex(
      canonicalJson({
        taskId: message.taskId,
        id: message.id,
        authorUserId: message.authorUserId,
        body: message.body,
        kind: message.kind,
        origin: message.origin,
        sourceVersion,
      }),
    ),
  }
}

/** Work rows survive retirement. The newest identity fences even a no-work → work → no-work round trip. */
export async function entryGeneration(tx: Tx, taskId: string): Promise<string> {
  const [latest] = await tx
    .select({ id: schema.works.id })
    .from(schema.works)
    .where(eq(schema.works.taskId, taskId))
    .orderBy(desc(schema.works.createdAt), desc(schema.works.id))
    .limit(1)
  return latest?.id ?? 'no_work_ever'
}

export async function discoveryConfig(tx: Tx, projectId: string) {
  const [row] = await tx
    .select()
    .from(schema.discoveryConfigurations)
    .where(eq(schema.discoveryConfigurations.projectId, projectId))
  return row
}

async function getConsent(
  tx: Tx,
  projectId: string,
  userId: string,
  kind: DiscoveryConsent['kind'],
) {
  const [row] = await tx
    .select()
    .from(schema.discoveryConsents)
    .where(
      and(
        eq(schema.discoveryConsents.projectId, projectId),
        eq(schema.discoveryConsents.userId, userId),
        eq(schema.discoveryConsents.kind, kind),
      ),
    )
  return row
}

export async function activeConsent(
  tx: Tx,
  cfg: DiscoveryConfiguration,
  userId: string,
  kind: DiscoveryConsent['kind'],
) {
  const row = await getConsent(tx, cfg.projectId, userId, kind)
  if (!row?.active || row.configVersion !== cfg.version) return undefined
  const team = await getTeam(tx)
  return team && (await getEnabledMember(tx, team.id, userId)) ? row : undefined
}

export async function sourceConsent(tx: Tx, cfg: DiscoveryConfiguration, userId: string) {
  return userId === cfg.settings.principalUserId
    ? activeConsent(tx, cfg, userId, 'permit')
    : activeConsent(tx, cfg, userId, 'participation')
}

export function available(
  cfg: DiscoveryConfiguration | undefined,
  now: Date,
): cfg is DiscoveryConfiguration {
  return cfg?.settings.enabled === true && Date.parse(cfg.settings.expiresAt) > now.getTime()
}

export async function discoveryAdmission(tx: Tx, sourceId: string) {
  const [row] = await tx
    .select()
    .from(schema.discoveryAdmissions)
    .where(eq(schema.discoveryAdmissions.sourceId, sourceId))
  return row
}

/** Caller already holds the same Task row as create/retire Work and subscription changes. */
export async function classifyComment(tx: Tx, task: TaskRow, message: TaskMessageRow) {
  const previous = await discoveryAdmission(tx, message.id)
  if (previous) return { first: false, route: previous.route }
  const now = new Date()
  const base = {
    projectId: task.projectId,
    entryTaskId: task.id,
    sourceId: message.id,
    ...sourceIdentity(message),
    createdAt: now,
  }
  const write = async (route: DiscoveryAdmission['route'], reason: string, bindings = {}) => {
    await tx.insert(schema.discoveryAdmissions).values({ ...base, route, reason, ...bindings })
    return { first: true, route }
  }
  if (await getCurrentWorkByTask(tx, task.id)) return write('existing_work', 'current_work')
  const state = await getCoordinatorStateForUpdate(tx, task.projectId)
  const cfg = await discoveryConfig(tx, task.projectId)
  if (!available(cfg, now)) return write('closed', 'discovery_disabled')
  if (cfg.settings.entryTaskId !== task.id) return write('rejected', 'entry_not_designated')
  const project = await getProject(tx, task.projectId)
  if (
    !state?.enabled ||
    state.pausedAt !== null ||
    !project ||
    project.archivedAt !== null ||
    task.status === 'done' ||
    task.status === 'cancelled'
  )
    return write('rejected', 'entry_inactive')
  const model = await getRouterConfig(tx, task.projectId)
  if (
    !model?.enabled ||
    model.configVersion !== cfg.modelConfigVersion ||
    cfg.configuredBy !== model.operatorUserId ||
    cfg.configuredBy !== model.billingUserId
  )
    return write('rejected', 'coordination_config_changed')
  const permit = await activeConsent(tx, cfg, cfg.settings.principalUserId, 'permit')
  if (!permit) return write('rejected', 'permit_required')
  const author = await sourceConsent(tx, cfg, message.authorUserId)
  if (!author) return write('rejected', 'source_permission_required')
  return write('discovery', 'eligible', {
    entryGeneration: await entryGeneration(tx, task.id),
    configVersion: cfg.version,
    permitVersion: permit.version,
    authorVersion: author.version,
  })
}

export async function configureDiscovery(
  database: Database,
  actor: Actor,
  projectId: string,
  settings: ConfigureDiscoveryRequest,
  key: string,
) {
  if (actor.role === 'member')
    throw new ApiError(403, 'FORBIDDEN', 'discovery configuration requires administrator')
  return transactCommand(
    database,
    `discovery.config:${actor.userId}:${projectId}:${key}`,
    async (tx) => {
      // Same ordering as Router and comment admission: Task, coordinator state, then discovery rows.
      const [task] = await tx
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, settings.entryTaskId))
        .for('update')
      const project = await getProject(tx, projectId)
      if (task?.projectId !== projectId || !project || project.archivedAt !== null)
        throw new ApiError(404, 'NOT_FOUND', 'discovery entry not found')
      if (!(await getCoordinatorStateForUpdate(tx, projectId)))
        throw new ApiError(
          409,
          'CONFLICT',
          'configure coordination operator and billing before discovery',
        )
      const model = await getRouterConfig(tx, projectId)
      if (!model || (settings.enabled && !model.enabled))
        throw new ApiError(409, 'CONFLICT', 'coordination model has no current approval')
      if (
        settings.enabled &&
        (actor.userId !== model.operatorUserId || actor.userId !== model.billingUserId)
      )
        throw new ApiError(
          403,
          'FORBIDDEN',
          'discovery requires explicit approval by the coordination operator and billing owner',
        )
      const now = new Date()
      const team = await getTeam(tx)
      if (!team || !(await getEnabledMember(tx, team.id, settings.principalUserId)))
        throw new ApiError(409, 'CONFLICT', 'discovery principal must be a current member')
      if (settings.enabled && Date.parse(settings.expiresAt) <= now.getTime())
        throw new ApiError(
          400,
          'VALIDATION_FAILED',
          'discovery permission must have a future expiry',
        )
      const cfg = await discoveryConfig(tx, projectId)
      const version = (cfg?.version ?? 0) + 1
      const values = {
        projectId,
        version,
        modelConfigVersion: model.configVersion,
        settings,
        configuredBy: actor.userId,
        updatedAt: now,
      }
      await tx
        .insert(schema.discoveryConfigurations)
        .values(values)
        .onConflictDoUpdate({ target: schema.discoveryConfigurations.projectId, set: values })
      await tx
        .delete(schema.discoveryCandidates)
        .where(eq(schema.discoveryCandidates.projectId, projectId))
      return { projectId, configVersion: version, enabled: settings.enabled }
    },
  )
}

/** The actor can inspect what the version they confirm will allow, without raw material. */
export async function discoveryConsentBasis(database: Database, actor: Actor, projectId: string) {
  return database.transaction(async (tx) => {
    await getCoordinatorStateForUpdate(tx, projectId)
    const project = await getProject(tx, projectId)
    if (!project || project.archivedAt !== null)
      throw new ApiError(404, 'NOT_FOUND', 'discovery project not found')
    const cfg = await discoveryConfig(tx, projectId)
    const model = await getRouterConfig(tx, projectId)
    if (
      !available(cfg, new Date()) ||
      !model?.enabled ||
      model.configVersion !== cfg.modelConfigVersion
    )
      return { projectId, enabled: false, configVersion: null }
    const {
      entryTaskId,
      activity,
      slot,
      templateVersion,
      expiresAt,
      principalUserId,
      maxCalls,
      maxTokens,
      maxCostMicros,
    } = cfg.settings
    return {
      projectId,
      enabled: true,
      configVersion: cfg.version,
      entryTaskId,
      activity,
      slot,
      templateVersion,
      expiresAt,
      canConfirmPermit: principalUserId === actor.userId,
      maxCalls,
      maxTokens,
      maxCostMicros,
      provider: model.provider,
      model: model.model,
      modelConfigVersion: cfg.modelConfigVersion,
    }
  })
}

export async function changeDiscoveryConsent(
  database: Database,
  actor: Actor,
  projectId: string,
  kind: DiscoveryConsent['kind'],
  active: boolean,
  configVersion: number | undefined,
  key: string,
) {
  return transactCommand(
    database,
    `discovery.consent:${kind}:${active}:${actor.userId}:${projectId}:${key}`,
    async (tx) => {
      await getCoordinatorStateForUpdate(tx, projectId)
      const cfg = await discoveryConfig(tx, projectId)
      const now = new Date()
      if (!cfg || (kind === 'permit' && cfg.settings.principalUserId !== actor.userId))
        throw new ApiError(404, 'NOT_FOUND', 'discovery permission not found')
      const model = active ? await getRouterConfig(tx, projectId) : undefined
      if (
        active &&
        (!available(cfg, now) ||
          configVersion !== cfg.version ||
          !model?.enabled ||
          model.configVersion !== cfg.modelConfigVersion)
      )
        throw new ApiError(409, 'CONFLICT', 'discovery configuration is not current')
      const previous = await getConsent(tx, projectId, actor.userId, kind)
      if (previous && previous.active === active && previous.configVersion === cfg.version)
        return { projectId, configVersion: cfg.version, version: previous.version, active }
      const values = {
        projectId,
        userId: actor.userId,
        kind,
        configVersion: cfg.version,
        version: (previous?.version ?? 0) + 1,
        active,
        updatedAt: now,
      }
      const t = schema.discoveryConsents
      await tx
        .insert(t)
        .values(values)
        .onConflictDoUpdate({
          target: [t.projectId, t.userId, t.kind],
          set: values,
        })
      if (!active && kind === 'permit')
        await tx
          .delete(schema.discoveryCandidates)
          .where(
            and(
              eq(schema.discoveryCandidates.projectId, projectId),
              eq(schema.discoveryCandidates.principalUserId, actor.userId),
            ),
          )
      return { projectId, configVersion: cfg.version, version: values.version, active }
    },
  )
}

export async function withdrawDiscoverySource(
  database: Database,
  actor: Actor,
  projectId: string,
  sourceId: string,
  key: string,
) {
  return transactCommand(
    database,
    `discovery.withdraw:${actor.userId}:${sourceId}:${key}`,
    async (tx) => {
      const [message] = await tx
        .select()
        .from(schema.taskMessages)
        .where(eq(schema.taskMessages.id, sourceId))
      const admission = await discoveryAdmission(tx, sourceId)
      if (!message || message.authorUserId !== actor.userId || admission?.projectId !== projectId)
        throw new ApiError(404, 'NOT_FOUND', 'discovery source not found')
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, admission.entryTaskId))
        .for('update')
      await getCoordinatorStateForUpdate(tx, projectId)
      const current = await discoveryAdmission(tx, sourceId)
      if (current?.withdrawnAt === null)
        await tx
          .update(schema.discoveryAdmissions)
          .set({ withdrawnAt: new Date() })
          .where(eq(schema.discoveryAdmissions.sourceId, sourceId))
      await tx
        .delete(schema.discoveryCandidates)
        .where(eq(schema.discoveryCandidates.sourceId, sourceId))
      return { sourceId, withdrawn: true }
    },
  )
}
