import { and, desc, eq, isNull, notExists } from 'drizzle-orm'
import {
  findDiscoverySlot,
  getActiveDiscoveryPermit,
  getCoordinatorStateForUpdate,
  getCurrentDiscoveryReceipt,
  getCurrentSlotVerification,
  getCurrentWorkByTask,
  getDiscoveryPermitForUpdate,
  getDiscoverySlotOccupation,
  getEnabledMember,
  getLatestSourceCorrection,
  getOrCreateDiscoverySlot,
  getProject,
  getRouterConfig,
  getTeam,
  insertDiscoveryPermit,
  insertDiscoveryVerification,
  insertSourceCorrection,
  revokeDiscoveryExecutionsForMember,
  revokeDiscoveryExecutionsForProject,
  revokeDiscoveryExecutionsForSource,
  revokeDiscoveryPermits,
  revokeDiscoveryVerificationsForSource,
  schema,
  transactCommand,
  type Database,
  type TaskMessageRow,
  type TaskRow,
  type Tx,
} from '@whalepod/db'
import type {
  ConfigureDiscoveryRequest,
  DiscoveryPermitRequest,
  DiscoveryTier,
  TaskSpecContent,
} from '@whalepod/protocol'
import { TaskSpecContentSchema } from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { loadDiscoveryCatalog } from './catalog.js'

export type DiscoveryAdmission = typeof schema.discoveryAdmissions.$inferSelect
export type DiscoveryConfiguration = typeof schema.discoveryConfigurations.$inferSelect
export type DiscoveryConsent = typeof schema.discoveryConsents.$inferSelect
type Actor = { userId: string; role: 'owner' | 'admin' | 'member' }

const TIER_RANK: Record<DiscoveryTier, number> = { discover: 0, create: 1, execute: 2 }

export function templateDigestOf(template: TaskSpecContent): string {
  return sha256Hex(canonicalJson(template))
}

export function templateFor(settings: ConfigureDiscoveryRequest): TaskSpecContent {
  return TaskSpecContentSchema.parse(settings.template)
}

/**
 * Permit/template JSON is stored in one jsonb column with a 64 KiB DB guard.
 * PostgreSQL renders jsonb with `": "`/`", "` separators (7 bytes for the four-key
 * template) and rejects \u0000 and lone surrogates; keep headroom so no accepted
 * request reaches the check/parser as a 500.
 */
const TEMPLATE_STORAGE_LIMIT = 65_024
const UNSTORABLE_TEXT =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Config strings also land in the settings jsonb; reject what PostgreSQL cannot store. */
export function assertDiscoveryTextStorable(value: string): void {
  if (UNSTORABLE_TEXT.test(value))
    throw new ApiError(400, 'VALIDATION_FAILED', 'discovery configuration text is not storable')
}

export function assertTemplateWithinStorage(template: TaskSpecContent): void {
  if (
    Buffer.byteLength(canonicalJson(template), 'utf8') > TEMPLATE_STORAGE_LIMIT ||
    Object.values(template).some((value) => UNSTORABLE_TEXT.test(value))
  )
    throw new ApiError(400, 'VALIDATION_FAILED', 'discovery template exceeds storage bounds')
}

export async function sourceIdentity(tx: Tx, message: TaskMessageRow) {
  const correction = await getLatestSourceCorrection(tx, message.id)
  const sourceVersion =
    correction === undefined
      ? (message.editedAt ?? message.createdAt).toISOString()
      : `${correction.createdAt.toISOString()}#v${correction.version}`
  const body = correction?.body ?? message.body
  return {
    sourceVersion,
    sourceDigest: sha256Hex(
      canonicalJson({
        taskId: message.taskId,
        id: message.id,
        authorUserId: message.authorUserId,
        body,
        kind: message.kind,
        origin: message.origin,
        sourceVersion,
      }),
    ),
    body,
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
  const identity = await sourceIdentity(tx, message)
  const base = {
    projectId: task.projectId,
    entryTaskId: task.id,
    sourceId: message.id,
    sourceVersion: identity.sourceVersion,
    sourceDigest: identity.sourceDigest,
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
      // Same ordering as Router and comment admission: Task, coordinator state, Project, then
      // discovery rows. The Project lock serializes config/permit changes with apply and manual
      // creation, which both hold it before touching slots.
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
      const [lockedProject] = await tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .for('update')
      if (!lockedProject || lockedProject.archivedAt !== null)
        throw new ApiError(404, 'NOT_FOUND', 'discovery entry not found')
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
      // The whole settings object (template and labels included) is stored as jsonb on every
      // tier, so validate what PostgreSQL can store before any write, not only for create.
      const template = templateFor(settings)
      assertTemplateWithinStorage(template)
      for (const value of [settings.activity, settings.slot, settings.templateVersion])
        assertDiscoveryTextStorable(value)
      if (settings.enabled && settings.tier !== 'discover') {
        if (template.goal.trim() === '' || template.acceptance.trim() === '')
          throw new ApiError(
            400,
            'VALIDATION_FAILED',
            'create tier requires a non-empty goal and acceptance in the template',
          )
        if (
          settings.verifierUserIds.length === 0 ||
          new Set(settings.verifierUserIds).size !== settings.verifierUserIds.length
        )
          throw new ApiError(
            400,
            'VALIDATION_FAILED',
            'create tier requires distinct registered verifiers',
          )
        for (const verifier of settings.verifierUserIds) {
          if (!(await getEnabledMember(tx, team.id, verifier)))
            throw new ApiError(400, 'VALIDATION_FAILED', 'verifier is not an active team member')
        }
      }
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
      // A new config version invalidates every earlier permit; the principal must re-confirm.
      await revokeDiscoveryPermits(tx, {
        projectId,
        reason: settings.enabled ? 'config_changed' : 'discovery_disabled',
        now,
      })
      await revokeDiscoveryExecutionsForProject(
        tx,
        projectId,
        settings.enabled ? 'config_changed' : 'discovery_disabled',
        now,
      )
      const slot = await getOrCreateDiscoverySlot(tx, {
        id: uuidv7(now.getTime()),
        projectId,
        activity: settings.activity,
        slot: settings.slot,
        now,
      })
      await deleteCandidatesSafely(tx, { projectId })
      return { projectId, configVersion: version, enabled: settings.enabled, slotId: slot.id }
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
      tier,
      template,
      verifierUserIds,
      maxCreations,
    } = cfg.settings
    const templateBody = templateFor(cfg.settings)
    const slotRow = await findDiscoverySlot(tx, projectId, activity, slot)
    const principalPermit = await getActiveDiscoveryPermit(
      tx,
      projectId,
      principalUserId,
      cfg.version,
    )
    const permit =
      actor.userId === principalUserId
        ? principalPermit
        : await getActiveDiscoveryPermit(tx, projectId, actor.userId, cfg.version)
    const verification = slotRow ? await getCurrentSlotVerification(tx, slotRow.id) : undefined
    const occupation = slotRow ? await getDiscoverySlotOccupation(tx, slotRow.id) : undefined
    const catalog = await loadDiscoveryCatalog(tx, projectId)
    const verificationCurrent =
      slotRow !== undefined &&
      verification !== undefined &&
      verification.generation === slotRow.generation &&
      verification.permitId === principalPermit?.id &&
      verification.catalogDigest === catalog.digest
    return {
      projectId,
      enabled: true,
      configVersion: cfg.version,
      entryTaskId,
      activity,
      slot,
      slotId: slotRow?.id ?? null,
      slotGeneration: slotRow?.generation ?? null,
      templateVersion,
      template: templateBody,
      templateDigest: templateDigestOf(templateBody),
      tier,
      verifierUserIds,
      maxCreations,
      expiresAt,
      canConfirmPermit: principalUserId === actor.userId,
      maxCalls,
      maxTokens,
      maxCostMicros,
      provider: model.provider,
      model: model.model,
      modelConfigVersion: cfg.modelConfigVersion,
      permit:
        permit === undefined
          ? null
          : {
              id: permit.id,
              version: permit.version,
              tier: permit.tier,
              confirmedAt: permit.confirmedAt.toISOString(),
              expiresAt: permit.expiresAt.toISOString(),
              revokedAt: permit.revokedAt?.toISOString() ?? null,
            },
      catalog: {
        digest: catalog.digest,
        complete: catalog.complete,
        entryCount: catalog.entries.length,
      },
      verification:
        verification === undefined
          ? null
          : {
              id: verification.id,
              generation: verification.generation,
              verifiedAt: verification.verifiedAt.toISOString(),
              verifiedBy: verification.verifiedBy,
              current: verificationCurrent,
              eligibleEmpty:
                verificationCurrent &&
                occupation === undefined &&
                verification.entries.every((entry) => entry.coverage === 'not_covered'),
            },
      occupation:
        occupation === undefined
          ? null
          : {
              taskId: occupation.taskId,
              workId: occupation.workId,
              source: occupation.source,
              createdAt: occupation.createdAt.toISOString(),
            },
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
  permitInput?: DiscoveryPermitRequest,
) {
  return transactCommand(
    database,
    `discovery.consent:${kind}:${active}:${actor.userId}:${projectId}:${key}:${configVersion ?? ''}:${permitInput?.tier ?? ''}:${permitInput?.templateDigest ?? ''}`,
    async (tx) => {
      await getCoordinatorStateForUpdate(tx, projectId)
      // Project lock orders consent changes against apply/manual creation, which hold it before
      // reading permits, slots and the catalog.
      const [project] = await tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .for('update')
      if (!project || project.archivedAt !== null)
        throw new ApiError(404, 'NOT_FOUND', 'discovery permission not found')
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
      const t = schema.discoveryConsents
      if (kind === 'participation') {
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
        await tx
          .insert(t)
          .values(values)
          .onConflictDoUpdate({ target: [t.projectId, t.userId, t.kind], set: values })
        // An author/verifier leaving discovery invalidates every execution authorization
        // that might depend on their material; re-confirmation is required.
        if (!active)
          await revokeDiscoveryExecutionsForMember(tx, actor.userId, 'participation_changed', now)
        return { projectId, configVersion: cfg.version, version: values.version, active }
      }

      if (!active) {
        const nextVersion = (previous?.version ?? 0) + 1
        const values = {
          projectId,
          userId: actor.userId,
          kind,
          configVersion: cfg.version,
          version: nextVersion,
          active,
          updatedAt: now,
        }
        await tx
          .insert(t)
          .values(values)
          .onConflictDoUpdate({ target: [t.projectId, t.userId, t.kind], set: values })
        await revokeDiscoveryPermits(tx, {
          projectId,
          principalUserId: actor.userId,
          reason: 'permit_revoked',
          now,
        })
        await revokeDiscoveryExecutionsForProject(tx, projectId, 'permit_revoked', now)
        await deleteCandidatesSafely(tx, { projectId, principalUserId: actor.userId })
        return { projectId, configVersion: cfg.version, version: nextVersion, active }
      }

      const settingsTier = cfg.settings.tier
      // A permit never silently inherits the project's maximum tier; the principal must ask
      // for create/execute explicitly (RD-04c will gate execute behind its own controls).
      const tier = permitInput?.tier ?? 'discover'
      if (TIER_RANK[tier] > TIER_RANK[settingsTier])
        throw new ApiError(409, 'CONFLICT', 'permit tier exceeds the project discovery tier')
      const template = templateFor(cfg.settings)
      assertTemplateWithinStorage(template)
      const digest = templateDigestOf(template)
      if (tier !== 'discover' && permitInput?.templateDigest !== digest)
        throw new ApiError(
          409,
          'CONFLICT',
          'the confirmation template changed; refresh and confirm the current version',
        )
      if (tier !== 'discover') {
        if (template.goal.trim() === '' || template.acceptance.trim() === '')
          throw new ApiError(400, 'VALIDATION_FAILED', 'permit template needs goal and acceptance')
        const verifiers = [...new Set(cfg.settings.verifierUserIds)]
        if (verifiers.length === 0)
          throw new ApiError(409, 'CONFLICT', 'create tier needs at least one registered verifier')
        const team = await getTeam(tx)
        for (const verifier of verifiers) {
          if (!team || !(await getEnabledMember(tx, team.id, verifier)))
            throw new ApiError(409, 'CONFLICT', 'a registered verifier is not a current member')
        }
      }
      const existing = await getActiveDiscoveryPermit(tx, projectId, actor.userId, cfg.version)
      if (
        previous?.active === true &&
        previous.configVersion === cfg.version &&
        existing !== undefined &&
        existing.tier === tier &&
        existing.templateDigest === digest
      )
        return {
          projectId,
          configVersion: cfg.version,
          version: previous.version,
          active,
          permitId: existing.id,
          permitVersion: existing.version,
        }
      const slot = await getOrCreateDiscoverySlot(tx, {
        id: uuidv7(now.getTime()),
        projectId,
        activity: cfg.settings.activity,
        slot: cfg.settings.slot,
        now,
      })
      const nextVersion = Math.max(previous?.version ?? 0, existing?.version ?? 0) + 1
      await revokeDiscoveryPermits(tx, {
        projectId,
        principalUserId: actor.userId,
        reason: 'permit_reconfirmed',
        now,
      })
      // A new permit identity supersedes every earlier child execution authorization.
      await revokeDiscoveryExecutionsForProject(tx, projectId, 'permit_reconfirmed', now)
      const permit = await insertDiscoveryPermit(tx, {
        id: uuidv7(now.getTime()),
        projectId,
        slotId: slot.id,
        configVersion: cfg.version,
        version: nextVersion,
        principalUserId: actor.userId,
        entryTaskId: cfg.settings.entryTaskId,
        tier,
        templateVersion: cfg.settings.templateVersion,
        template,
        templateDigest: digest,
        maxCreations: cfg.settings.maxCreations,
        expiresAt: new Date(cfg.settings.expiresAt),
        verifierUserIds: [...new Set(cfg.settings.verifierUserIds)],
        confirmedAt: now,
        revokedAt: null,
        revokedReason: null,
      })
      const values = {
        projectId,
        userId: actor.userId,
        kind,
        configVersion: cfg.version,
        version: nextVersion,
        active,
        updatedAt: now,
      }
      await tx
        .insert(t)
        .values(values)
        .onConflictDoUpdate({ target: [t.projectId, t.userId, t.kind], set: values })
      return {
        projectId,
        configVersion: cfg.version,
        version: nextVersion,
        active,
        permitId: permit.id,
        permitVersion: permit.version,
      }
    },
  )
}

async function deleteCandidatesSafely(
  tx: Tx,
  where: {
    readonly projectId: string
    readonly principalUserId?: string
    readonly sourceId?: string
  },
) {
  await tx
    .delete(schema.discoveryCandidates)
    .where(
      and(
        eq(schema.discoveryCandidates.projectId, where.projectId),
        where.principalUserId === undefined
          ? undefined
          : eq(schema.discoveryCandidates.principalUserId, where.principalUserId),
        where.sourceId === undefined
          ? undefined
          : eq(schema.discoveryCandidates.sourceId, where.sourceId),
        notExists(
          tx
            .select({ one: schema.discoveryApplications.id })
            .from(schema.discoveryApplications)
            .where(eq(schema.discoveryApplications.candidateId, schema.discoveryCandidates.id)),
        ),
      ),
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
      const now = new Date()
      const current = await discoveryAdmission(tx, sourceId)
      if (current?.withdrawnAt === null)
        await tx
          .update(schema.discoveryAdmissions)
          .set({ withdrawnAt: now })
          .where(eq(schema.discoveryAdmissions.sourceId, sourceId))
      await revokeDiscoveryVerificationsForSource(tx, sourceId, 'source_withdrawn', now)
      await deleteCandidatesSafely(tx, { projectId, sourceId })
      await revokeDiscoveryExecutionsForSource(tx, sourceId, 'source_withdrawn', now)
      return { sourceId, withdrawn: true }
    },
  )
}

/** ADR-0030 §5：原作者版本化更正；原文不改，旧候选/回执整体失效。 */
export async function correctDiscoverySource(
  database: Database,
  actor: Actor,
  projectId: string,
  sourceId: string,
  body: string,
  key: string,
) {
  return transactCommand(
    database,
    `discovery.correct:${actor.userId}:${sourceId}:${sha256Hex(body)}:${key}`,
    async (tx) => {
      const [message] = await tx
        .select()
        .from(schema.taskMessages)
        .where(eq(schema.taskMessages.id, sourceId))
      const admission = await discoveryAdmission(tx, sourceId)
      if (!message || message.authorUserId !== actor.userId || admission?.projectId !== projectId)
        throw new ApiError(404, 'NOT_FOUND', 'discovery source not found')
      if (admission.withdrawnAt !== null)
        throw new ApiError(409, 'CONFLICT', 'a withdrawn discovery source cannot be corrected')
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, admission.entryTaskId))
        .for('update')
      await getCoordinatorStateForUpdate(tx, projectId)
      // Withdraw may have committed while we waited for the locks; re-read before versioning.
      const currentAdmission = await discoveryAdmission(tx, sourceId)
      if (
        !currentAdmission ||
        currentAdmission.projectId !== projectId ||
        currentAdmission.withdrawnAt !== null
      )
        throw new ApiError(409, 'CONFLICT', 'a withdrawn discovery source cannot be corrected')
      const latest = await getLatestSourceCorrection(tx, sourceId)
      if (latest?.body === body) {
        const current = await sourceIdentity(tx, message)
        return { sourceId, corrected: false, sourceVersion: current.sourceVersion }
      }
      const now = new Date()
      const correction = await insertSourceCorrection(tx, {
        id: uuidv7(now.getTime()),
        sourceId,
        projectId,
        authorUserId: actor.userId,
        version: (latest?.version ?? 0) + 1,
        body,
        digest: sha256Hex(body),
        createdAt: now,
      })
      const identity = await sourceIdentity(tx, message)
      await tx
        .update(schema.discoveryAdmissions)
        .set({ sourceVersion: identity.sourceVersion, sourceDigest: identity.sourceDigest })
        .where(eq(schema.discoveryAdmissions.sourceId, sourceId))
      await revokeDiscoveryVerificationsForSource(tx, sourceId, 'source_corrected', now)
      await deleteCandidatesSafely(tx, { projectId, sourceId })
      await revokeDiscoveryExecutionsForSource(tx, sourceId, 'source_corrected', now)
      return {
        sourceId,
        corrected: true,
        correctionId: correction.id,
        sourceVersion: identity.sourceVersion,
      }
    },
  )
}

/** 核实人经专门入口确认确切评论版本；作者本人不能自证。 */
export async function verifyDiscoverySource(
  database: Database,
  actor: Actor,
  projectId: string,
  sourceId: string,
  input: { readonly sourceVersion: string; readonly sourceDigest: string },
  key: string,
) {
  return transactCommand(
    database,
    `discovery.verify:${actor.userId}:${sourceId}:${input.sourceVersion}:${input.sourceDigest}:${key}`,
    async (tx) => {
      await getCoordinatorStateForUpdate(tx, projectId)
      const now = new Date()
      const cfg = await discoveryConfig(tx, projectId)
      if (!cfg || !available(cfg, now))
        throw new ApiError(404, 'NOT_FOUND', 'discovery is not active')
      const activePermit = await getActiveDiscoveryPermit(
        tx,
        projectId,
        cfg.settings.principalUserId,
        cfg.version,
      )
      const permit = activePermit
        ? await getDiscoveryPermitForUpdate(tx, activePermit.id)
        : undefined
      if (!permit || permit.revokedAt !== null || permit.expiresAt.getTime() <= now.getTime())
        throw new ApiError(404, 'NOT_FOUND', 'discovery permit is not active')
      if (!permit.verifierUserIds.includes(actor.userId))
        throw new ApiError(403, 'FORBIDDEN', 'only a registered verifier can confirm this source')
      const team = await getTeam(tx)
      if (!team || !(await getEnabledMember(tx, team.id, actor.userId)))
        throw new ApiError(403, 'FORBIDDEN', 'verifier is not an active member')
      const [message] = await tx
        .select()
        .from(schema.taskMessages)
        .where(eq(schema.taskMessages.id, sourceId))
      const admission = await discoveryAdmission(tx, sourceId)
      if (
        !message ||
        admission?.projectId !== projectId ||
        admission.route !== 'discovery' ||
        admission.withdrawnAt !== null
      )
        throw new ApiError(404, 'NOT_FOUND', 'discovery source not found')
      if (message.authorUserId === actor.userId)
        throw new ApiError(403, 'FORBIDDEN', 'a source author cannot verify their own comment')
      const identity = await sourceIdentity(tx, message)
      if (
        identity.sourceVersion !== input.sourceVersion ||
        identity.sourceDigest !== input.sourceDigest
      )
        throw new ApiError(409, 'CONFLICT', 'the source changed; refresh before confirming')
      const existing = await getCurrentDiscoveryReceipt(tx, {
        sourceId,
        slotId: permit.slotId,
        permitId: permit.id,
        verifierUserId: actor.userId,
      })
      if (existing) return toVerificationView(existing)
      const row = await insertDiscoveryVerification(tx, {
        id: uuidv7(now.getTime()),
        projectId,
        slotId: permit.slotId,
        permitId: permit.id,
        permitVersion: permit.version,
        sourceId,
        sourceVersion: identity.sourceVersion,
        sourceDigest: identity.sourceDigest,
        verifierUserId: actor.userId,
        kind: 'receipt',
        createdAt: now,
        revokedAt: null,
        revokedReason: null,
      })
      return toVerificationView(row)
    },
  )
}

/**
 * 核实人/责任人读取确切来源版本与摘要；评论正文仍走普通 Task 读面。
 * 这是回执入口的生产驱动面，避免客户端自行重算内部 canonical 摘要。
 */
export async function discoverySourceIdentity(
  database: Database,
  actor: Actor,
  projectId: string,
  sourceId: string,
) {
  return database.transaction(async (tx) => {
    await getCoordinatorStateForUpdate(tx, projectId)
    const now = new Date()
    const cfg = await discoveryConfig(tx, projectId)
    if (!cfg || !available(cfg, now))
      throw new ApiError(404, 'NOT_FOUND', 'discovery is not active')
    const permit = await getActiveDiscoveryPermit(
      tx,
      projectId,
      cfg.settings.principalUserId,
      cfg.version,
    )
    if (!permit || permit.revokedAt !== null || permit.expiresAt.getTime() <= now.getTime())
      throw new ApiError(404, 'NOT_FOUND', 'discovery permit is not active')
    if (actor.userId !== permit.principalUserId && !permit.verifierUserIds.includes(actor.userId))
      throw new ApiError(
        403,
        'FORBIDDEN',
        'only the principal or a registered verifier can read it',
      )
    const [message] = await tx
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.id, sourceId))
    const admission = await discoveryAdmission(tx, sourceId)
    if (
      !message ||
      admission?.projectId !== projectId ||
      admission.route !== 'discovery' ||
      admission.withdrawnAt !== null
    )
      throw new ApiError(404, 'NOT_FOUND', 'discovery source not found')
    const identity = await sourceIdentity(tx, message)
    return {
      sourceId,
      authorUserId: message.authorUserId,
      sourceVersion: identity.sourceVersion,
      sourceDigest: identity.sourceDigest,
      createdAt: message.createdAt.toISOString(),
      corrected: identity.sourceVersion !== (message.editedAt ?? message.createdAt).toISOString(),
    }
  })
}

/**
 * ADR §4：目录水位变化使旧评估失效时，把来源放回待评估队列而不是静默丢失。
 * 只重排当前仍指向该评估的准入行：落后的候选不能把已经派发的新评估清掉。
 */
export async function requeueDiscoveryAdmission(
  tx: Tx,
  sourceId: string,
  evaluationId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(schema.discoveryAdmissions)
    .set({
      processedAt: null,
      evaluationId: null,
      processingReason: 'stale_replan',
      requeuedAt: now,
    })
    .where(
      and(
        eq(schema.discoveryAdmissions.sourceId, sourceId),
        eq(schema.discoveryAdmissions.route, 'discovery'),
        eq(schema.discoveryAdmissions.evaluationId, evaluationId),
        isNull(schema.discoveryAdmissions.withdrawnAt),
      ),
    )
    .returning({ sourceId: schema.discoveryAdmissions.sourceId })
  return rows.length > 0
}

function toVerificationView(row: {
  readonly id: string
  readonly sourceId: string
  readonly sourceVersion: string
  readonly sourceDigest: string
  readonly verifierUserId: string
  readonly permitVersion: number
  readonly createdAt: Date
}) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceDigest: row.sourceDigest,
    verifierUserId: row.verifierUserId,
    permitVersion: row.permitVersion,
    createdAt: row.createdAt.toISOString(),
  }
}
