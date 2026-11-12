/**
 * ADR-0030 RD-04c1（Issue #540）：发现执行授权与精确来源包。
 *
 * 这里只写责任人的第二次授权：父许可必须已到 execute 档，来源逐件固定版本/摘要/
 * 授权代次，Executor 路由身份固定到该件执行。不创建 Mandate、派工意图或 Run；
 * RD-04c2 只能在同一条授权仍有效时继续。
 */
import { asc, eq, inArray } from 'drizzle-orm'
import {
  getCoordinatorStateForUpdate,
  getDiscoveryApplicationById,
  getDiscoveryExecutionByApplication,
  getDiscoveryExecutionForUpdate,
  getDiscoveryPermit,
  getDiscoveryPermitForUpdate,
  getDiscoverySlot,
  getDiscoverySourceBindingByApplication,
  getEnabledMember,
  getTask,
  getTaskForUpdate,
  getTaskMessage,
  getTeam,
  insertDiscoveryExecution,
  insertDiscoveryExecutionSources,
  listDiscoveryExecutionSources,
  listDiscoveryVerificationsByIds,
  revokeDiscoveryExecution,
  schema,
  transactCommand,
  type Database,
  type DiscoveryApplicationRow,
  type DiscoveryExecutionRow,
  type DiscoveryExecutionSourceKind,
  type Tx,
} from '@whalepod/db'
import type { DiscoveryExecutionAuthorizationRequest } from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import {
  assertDiscoveryTextStorable,
  available,
  discoveryAdmission,
  discoveryConfig,
  sourceIdentity,
  sourceConsent,
} from './admission.js'

export interface DiscoveryExecutionSourceView {
  readonly kind: DiscoveryExecutionSourceKind
  readonly sourceId: string
  readonly sourceVersion: string
  readonly sourceDigest: string
  readonly authorizationGeneration: string
}

export interface DiscoveryExecutionView {
  readonly applicationId: string
  readonly eligible: boolean
  readonly reason?: string
  readonly sourceManifestDigest: string | null
  readonly sources: readonly DiscoveryExecutionSourceView[]
  readonly execution: {
    readonly id: string
    readonly status: 'authorized' | 'expired' | 'revoked'
    readonly purpose: 'private_draft'
    readonly executor: {
      readonly provider: string
      readonly model: string
      readonly endpoint: string
      readonly account: string
      readonly policyGeneration: number
    }
    readonly executorDigest: string
    readonly sourceManifestDigest: string
    readonly expiresAt: string
    readonly authorizedAt: string
    readonly revokedAt: string | null
    readonly revokedReason: string | null
  } | null
}

interface Basis {
  readonly application: DiscoveryApplicationRow
  readonly sources: readonly DiscoveryExecutionSourceView[]
  readonly manifestDigest: string
  readonly eligible: boolean
  readonly reason?: string
}

const EXECUTION_TTL_MS = 24 * 60 * 60_000

const nowOf = (deps: { now?: () => Date }): Date => deps.now?.() ?? new Date()

function sourceManifestDigest(sources: readonly DiscoveryExecutionSourceView[]): string {
  return sha256Hex(
    canonicalJson(
      sources.map(({ kind, sourceId, sourceVersion, sourceDigest, authorizationGeneration }) => ({
        kind,
        sourceId,
        sourceVersion,
        sourceDigest,
        authorizationGeneration,
      })),
    ),
  )
}

function executorDigest(input: DiscoveryExecutionAuthorizationRequest['executor']): string {
  return sha256Hex(
    canonicalJson({
      purpose: 'private_draft',
      provider: input.provider,
      model: input.model,
      endpoint: input.endpoint,
      account: input.account,
      policyGeneration: input.policyGeneration,
    }),
  )
}

function executionStatus(
  execution: DiscoveryExecutionRow,
  now: Date,
): 'authorized' | 'expired' | 'revoked' {
  if (execution.revokedAt !== null) return 'revoked'
  return execution.expiresAt.getTime() <= now.getTime() ? 'expired' : 'authorized'
}

function storedSourceView(
  sources: readonly {
    readonly kind: DiscoveryExecutionSourceKind
    readonly sourceId: string
    readonly sourceVersion: string
    readonly sourceDigest: string
    readonly authorizationGeneration: string
  }[],
): DiscoveryExecutionSourceView[] {
  return sources.map(
    ({ kind, sourceId, sourceVersion, sourceDigest, authorizationGeneration }) => ({
      kind,
      sourceId,
      sourceVersion,
      sourceDigest,
      authorizationGeneration,
    }),
  )
}

function notFoundApplication(): never {
  throw new ApiError(404, 'NOT_FOUND', 'discovery application not found')
}

function notFoundExecution(): never {
  throw new ApiError(404, 'NOT_FOUND', 'discovery execution not found')
}

/**
 * Rebuild the exact source package the application was materialized from, re-checking
 * every authority now. A single drifted source makes the whole authorization ineligible.
 * `lock` is true only on the write path so GET never blocks permit/work transitions.
 */
async function loadBasis(
  tx: Tx,
  actorUserId: string,
  projectId: string,
  applicationId: string,
  now: Date,
  lock: boolean,
): Promise<Basis> {
  const application = await getDiscoveryApplicationById(tx, applicationId)
  if (!application || application.projectId !== projectId) notFoundApplication()
  const permit = lock
    ? await getDiscoveryPermitForUpdate(tx, application.permitId)
    : await getDiscoveryPermit(tx, application.permitId)
  if (!permit || permit.principalUserId !== actorUserId) notFoundApplication()

  const admission = await discoveryAdmission(tx, application.sourceId)
  if (
    !admission ||
    admission.projectId !== projectId ||
    admission.route !== 'discovery' ||
    admission.withdrawnAt !== null ||
    admission.sourceVersion !== application.sourceVersion ||
    admission.sourceDigest !== application.sourceDigest
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'source_changed',
    }

  const binding = await getDiscoverySourceBindingByApplication(tx, application.id)
  if (
    !binding ||
    binding.sourceId !== application.sourceId ||
    binding.sourceVersion !== application.sourceVersion ||
    binding.sourceDigest !== application.sourceDigest
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'source_changed',
    }

  const cfg = await discoveryConfig(tx, projectId)
  if (!available(cfg, now) || permit.revokedAt !== null)
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'permit_inactive',
    }
  const slot = await getDiscoverySlot(tx, permit.slotId)
  if (
    permit.configVersion !== cfg.version ||
    permit.expiresAt.getTime() <= now.getTime() ||
    !slot ||
    slot.projectId !== projectId ||
    slot.activity !== cfg.settings.activity ||
    slot.slot !== cfg.settings.slot
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'permit_inactive',
    }
  if (permit.tier !== 'execute')
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'tier_required',
    }

  const team = await getTeam(tx)
  if (!team || !(await getEnabledMember(tx, team.id, actorUserId)))
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'authority_changed',
    }
  const task = await getTask(tx, application.taskId)
  const workQuery = tx.select().from(schema.works).where(eq(schema.works.id, application.workId))
  const [work] = lock ? await workQuery.for('update') : await workQuery
  if (
    !task ||
    task.projectId !== projectId ||
    task.assigneeUserId !== actorUserId ||
    task.assignmentStatus !== 'accepted' ||
    !work ||
    work.taskId !== task.id ||
    work.state !== 'active' ||
    work.humanOwnerUserId !== actorUserId
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'authority_changed',
    }

  // The source comment belongs to the entry Task, not the discovery-created Task.
  const message = await getTaskMessage(tx, application.sourceId)
  if (!message || message.kind !== 'discussion')
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'source_changed',
    }
  const identity = await sourceIdentity(tx, message)
  // Freeze the exact user rows before checking consent/membership: a concurrent
  // disable/participation write must either commit before this read or wait for us.
  const evidenceRows = await Promise.all(
    application.verification.evidence.map(async (evidence) => {
      const [artifact] = await tx
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, evidence.artifactId))
      return { evidence, artifact }
    }),
  )
  const receipts = await listDiscoveryVerificationsByIds(tx, application.verification.receiptIds)
  const authorityIds = [
    ...new Set([
      actorUserId,
      message.authorUserId,
      ...evidenceRows.flatMap(({ artifact }) => (artifact ? [artifact.ownerUserId] : [])),
      ...receipts.map((receipt) => receipt.verifierUserId),
    ]),
  ].sort()
  if (lock) {
    await tx
      .select({ id: schema.userAccounts.id })
      .from(schema.userAccounts)
      .where(inArray(schema.userAccounts.id, authorityIds))
      .orderBy(asc(schema.userAccounts.id))
      .for('share')
    // Re-read after the freeze: a disable that committed while we waited must reject.
    if (!(await getEnabledMember(tx, team.id, actorUserId)))
      return {
        application,
        sources: [],
        manifestDigest: '',
        eligible: false,
        reason: 'authority_changed',
      }
  }
  const authorConsent = await sourceConsent(tx, cfg, message.authorUserId)
  if (
    identity.sourceVersion !== application.sourceVersion ||
    identity.sourceDigest !== application.sourceDigest ||
    !authorConsent
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'source_changed',
    }

  const sources: DiscoveryExecutionSourceView[] = [
    {
      kind: 'task_message',
      sourceId: application.sourceId,
      sourceVersion: application.sourceVersion,
      sourceDigest: application.sourceDigest,
      authorizationGeneration: `author:${authorConsent.version}:permit:${permit.version}:config:${cfg.version}`,
    },
  ]
  const registeredVerifiers = new Set(
    permit.verifierUserIds.filter((id) => id !== message.authorUserId),
  )
  const eligibleEvidenceOwner = async (userId: string) =>
    registeredVerifiers.has(userId) && (await sourceConsent(tx, cfg, userId)) !== undefined
  const eligibleReceiptVerifier = async (userId: string) =>
    registeredVerifiers.has(userId) && (await getEnabledMember(tx, team.id, userId))

  for (const { evidence, artifact } of evidenceRows) {
    const publishedAt = artifact?.publishedAt?.toISOString()
    if (
      !artifact ||
      artifact.status !== 'published' ||
      artifact.sha256 !== evidence.sha256 ||
      artifact.ownerUserId === message.authorUserId ||
      !publishedAt ||
      !(await eligibleEvidenceOwner(artifact.ownerUserId))
    )
      return {
        application,
        sources: [],
        manifestDigest: '',
        eligible: false,
        reason: 'evidence_changed',
      }
    sources.push({
      kind: 'artifact',
      sourceId: artifact.id,
      sourceVersion: artifact.sha256,
      sourceDigest: artifact.sha256,
      authorizationGeneration: `published:${publishedAt}:permit:${permit.version}`,
    })
  }

  for (const receipt of receipts) {
    if (
      receipt.revokedAt !== null ||
      receipt.verifierUserId === message.authorUserId ||
      receipt.sourceVersion !== application.sourceVersion ||
      receipt.sourceDigest !== application.sourceDigest ||
      receipt.permitId !== permit.id ||
      !(await eligibleReceiptVerifier(receipt.verifierUserId))
    )
      return {
        application,
        sources: [],
        manifestDigest: '',
        eligible: false,
        reason: 'receipt_changed',
      }
    sources.push({
      kind: 'receipt',
      sourceId: receipt.id,
      sourceVersion: receipt.sourceVersion,
      sourceDigest: receipt.sourceDigest,
      authorizationGeneration: `receipt:${receipt.createdAt.toISOString()}:permit:${permit.version}`,
    })
  }

  if (
    receipts.length !== new Set(application.verification.receiptIds).size ||
    (application.verification.evidence.length === 0 &&
      application.verification.receiptIds.length === 0)
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'receipt_changed',
    }

  sources.sort((left, right) =>
    left.kind === right.kind
      ? left.sourceId.localeCompare(right.sourceId)
      : left.kind.localeCompare(right.kind),
  )
  return {
    application,
    sources,
    manifestDigest: sourceManifestDigest(sources),
    eligible: true,
  }
}

function toView(
  applicationId: string,
  basis: Basis,
  execution: DiscoveryExecutionRow | undefined,
  sources: readonly DiscoveryExecutionSourceView[],
  now: Date,
): DiscoveryExecutionView {
  const status = execution === undefined ? undefined : executionStatus(execution, now)
  const live = status === 'authorized'
  const reason =
    execution !== undefined && !live
      ? status === 'revoked'
        ? 'execution_revoked'
        : 'execution_expired'
      : basis.reason
  const eligible = execution !== undefined && !live ? false : basis.eligible
  return {
    applicationId,
    eligible,
    ...(reason === undefined ? {} : { reason }),
    sourceManifestDigest: eligible && basis.manifestDigest !== '' ? basis.manifestDigest : null,
    sources,
    execution:
      execution === undefined || status === undefined
        ? null
        : {
            id: execution.id,
            status,
            purpose: 'private_draft',
            executor: {
              provider: execution.executorProvider,
              model: execution.executorModel,
              endpoint: execution.executorEndpoint,
              account: execution.executorAccount,
              policyGeneration: execution.executorPolicyGeneration,
            },
            executorDigest: execution.executorDigest,
            sourceManifestDigest: execution.sourceManifestDigest,
            expiresAt: execution.expiresAt.toISOString(),
            authorizedAt: execution.authorizedAt.toISOString(),
            revokedAt: execution.revokedAt?.toISOString() ?? null,
            revokedReason: execution.revokedReason,
          },
  }
}

/** Serialize with correction/withdrawal and task/work transitions before reading the basis. */
async function lockAuthorizationScope(
  tx: Tx,
  actorUserId: string,
  applicationId: string,
  projectId: string,
): Promise<void> {
  const application = await getDiscoveryApplicationById(tx, applicationId)
  if (!application || application.projectId !== projectId) notFoundApplication()
  const permit = await getDiscoveryPermit(tx, application.permitId)
  // Reject non-principals before taking any Task/coordinator/Project lock.
  if (!permit || permit.principalUserId !== actorUserId) notFoundApplication()
  const admission = await discoveryAdmission(tx, application.sourceId)
  if (!admission || admission.projectId !== projectId) notFoundApplication()
  // Task -> Task -> coordinator -> Project; correction locks the entry Task, task commands
  // lock the target Task before the Work, so this cannot invert with either.
  if (!(await getTaskForUpdate(tx, admission.entryTaskId))) notFoundApplication()
  if (!(await getTaskForUpdate(tx, application.taskId))) notFoundApplication()
  await getCoordinatorStateForUpdate(tx, projectId)
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .for('update')
  if (!project || project.archivedAt !== null) notFoundApplication()
}

export async function discoveryExecutionBasis(
  deps: { database: Database; now?: () => Date },
  actorUserId: string,
  projectId: string,
  applicationId: string,
): Promise<DiscoveryExecutionView> {
  const now = nowOf(deps)
  return deps.database.transaction(async (tx) => {
    const basis = await loadBasis(tx, actorUserId, projectId, applicationId, now, false)
    const execution = await getDiscoveryExecutionByApplication(tx, applicationId)
    const stored = execution
      ? storedSourceView(await listDiscoveryExecutionSources(tx, execution.id))
      : basis.sources
    return toView(applicationId, basis, execution, stored, now)
  })
}

export async function authorizeDiscoveryExecution(
  deps: { database: Database; now?: () => Date; log?: (event: Record<string, unknown>) => void },
  actorUserId: string,
  projectId: string,
  applicationId: string,
  input: DiscoveryExecutionAuthorizationRequest,
  idempotencyKey: string,
): Promise<DiscoveryExecutionView> {
  for (const value of [
    input.executor.provider,
    input.executor.model,
    input.executor.endpoint,
    input.executor.account,
  ])
    assertDiscoveryTextStorable(value)
  const requestedExecutorDigest = executorDigest(input.executor)
  const requestedExpiry = new Date(input.expiresAt).toISOString()
  let inserted = false
  const result = await transactCommand(
    deps.database,
    `discovery.execution:${actorUserId}:${projectId}:${applicationId}:${idempotencyKey}`,
    async (tx) => {
      const now = nowOf(deps)
      await lockAuthorizationScope(tx, actorUserId, applicationId, projectId)
      const basis = await loadBasis(tx, actorUserId, projectId, applicationId, now, true)
      if (!basis.eligible)
        throw new ApiError(409, 'CONFLICT', 'discovery execution authorization is not available', {
          code: 'DISCOVERY_EXECUTION_UNAVAILABLE',
          reason: basis.reason,
        })
      if (basis.manifestDigest !== input.sourceManifestDigest)
        throw new ApiError(
          409,
          'CONFLICT',
          'discovery sources changed; refresh and confirm again',
          {
            code: 'DISCOVERY_SOURCE_MANIFEST_CHANGED',
          },
        )
      const expiresAt = new Date(input.expiresAt)
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= now.getTime() ||
        expiresAt.getTime() > now.getTime() + EXECUTION_TTL_MS
      )
        throw new ApiError(
          400,
          'VALIDATION_FAILED',
          'discovery execution expiry must be within the next 24 hours',
        )
      const permit = await getDiscoveryPermitForUpdate(tx, basis.application.permitId)
      if (
        !permit ||
        permit.version !== basis.application.permitVersion ||
        permit.revokedAt !== null
      )
        throw new ApiError(409, 'CONFLICT', 'discovery permit changed; refresh and confirm again', {
          code: 'DISCOVERY_PERMIT_CHANGED',
        })
      if (expiresAt.getTime() > permit.expiresAt.getTime())
        throw new ApiError(
          400,
          'VALIDATION_FAILED',
          'discovery execution expiry exceeds the parent permit',
          { code: 'DISCOVERY_EXECUTION_EXPIRY' },
        )

      const existing = await getDiscoveryExecutionForUpdate(tx, applicationId)
      if (existing) {
        if (existing.revokedAt !== null)
          throw new ApiError(409, 'CONFLICT', 'discovery execution was revoked', {
            code: 'DISCOVERY_EXECUTION_REVOKED',
          })
        const same =
          existing.sourceManifestDigest === basis.manifestDigest &&
          existing.executorDigest === requestedExecutorDigest &&
          existing.expiresAt.toISOString() === requestedExpiry
        if (!same)
          throw new ApiError(
            409,
            'CONFLICT',
            'a different discovery execution is already authorized',
            {
              code: 'DISCOVERY_EXECUTION_EXISTS',
            },
          )
        return { executionId: existing.id }
      }

      const executionId = uuidv7(now.getTime())
      await insertDiscoveryExecution(tx, {
        id: executionId,
        projectId,
        applicationId,
        taskId: basis.application.taskId,
        workId: basis.application.workId,
        principalUserId: actorUserId,
        parentPermitId: basis.application.permitId,
        parentPermitVersion: basis.application.permitVersion,
        purpose: 'private_draft',
        executorProvider: input.executor.provider,
        executorModel: input.executor.model,
        executorEndpoint: input.executor.endpoint,
        executorAccount: input.executor.account,
        executorPolicyGeneration: input.executor.policyGeneration,
        executorDigest: requestedExecutorDigest,
        sourceManifestDigest: basis.manifestDigest,
        expiresAt,
        authorizedAt: now,
        revokedAt: null,
        revokedReason: null,
        createdAt: now,
      })
      await insertDiscoveryExecutionSources(
        tx,
        basis.sources.map((source) => ({
          id: uuidv7(now.getTime()),
          executionId,
          kind: source.kind,
          sourceId: source.sourceId,
          sourceVersion: source.sourceVersion,
          sourceDigest: source.sourceDigest,
          authorizationGeneration: source.authorizationGeneration,
          createdAt: now,
        })),
      )
      inserted = true
      return { executionId }
    },
  )

  const now = nowOf(deps)
  const [execution] = await deps.database.db
    .select()
    .from(schema.discoveryExecutions)
    .where(eq(schema.discoveryExecutions.id, result.executionId))
  if (!execution) throw new ApiError(500, 'INTERNAL_ERROR', 'discovery execution vanished')
  // Idempotency receipts carry only the id; compare the request to the current row here so
  // a same-key retry with a different manifest/executor/expiry is a 409, not a silent replay.
  if (
    execution.sourceManifestDigest !== input.sourceManifestDigest ||
    execution.executorDigest !== requestedExecutorDigest ||
    execution.expiresAt.toISOString() !== requestedExpiry
  )
    throw new ApiError(409, 'CONFLICT', 'a different discovery execution is already authorized', {
      code: 'DISCOVERY_EXECUTION_EXISTS',
    })
  const stored = storedSourceView(
    await listDiscoveryExecutionSources(deps.database.db, execution.id),
  )
  const basis = await deps.database.transaction((tx) =>
    loadBasis(tx, actorUserId, projectId, applicationId, now, false),
  )
  if (inserted)
    deps.log?.({
      component: 'hub.discovery',
      action: 'discovery.execution.authorized',
      executionId: execution.id,
      applicationId,
      sourceCount: stored.length,
    })
  return toView(applicationId, basis, execution, stored, now)
}

export async function revokeDiscoveryExecutionByPrincipal(
  deps: { database: Database; now?: () => Date },
  actorUserId: string,
  projectId: string,
  applicationId: string,
): Promise<DiscoveryExecutionView> {
  const now = nowOf(deps)
  return deps.database.transaction(async (tx) => {
    const basis = await loadBasis(tx, actorUserId, projectId, applicationId, now, true)
    const execution = await getDiscoveryExecutionForUpdate(tx, applicationId)
    if (!execution) notFoundExecution()
    await revokeDiscoveryExecution(tx, execution.id, 'principal_revoked', now)
    const [updated] = await tx
      .select()
      .from(schema.discoveryExecutions)
      .where(eq(schema.discoveryExecutions.id, execution.id))
    const sources = storedSourceView(await listDiscoveryExecutionSources(tx, execution.id))
    return toView(applicationId, basis, updated, sources, now)
  })
}
