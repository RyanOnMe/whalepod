/**
 * ADR-0030 RD-04c1（Issue #540）：发现执行授权与精确来源包。
 *
 * 这里只写责任人的第二次授权：父许可必须已到 execute 档，来源逐件固定版本/摘要/
 * 授权代次，Executor 路由身份固定到该件执行。不创建 Mandate、派工意图或 Run；
 * RD-04c2 只能在同一条授权仍有效时继续。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  getDiscoveryApplicationById,
  getDiscoveryExecutionByApplication,
  getDiscoveryExecutionForUpdate,
  getDiscoveryPermitForUpdate,
  getDiscoverySlot,
  getDiscoverySourceBindingByApplication,
  getEnabledMember,
  getTask,
  getTaskMessage,
  getTeam,
  getWorkByIdForUpdate,
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
import { available, discoveryConfig, sourceIdentity, sourceConsent } from './admission.js'

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
    readonly status: 'authorized' | 'revoked'
    readonly purpose: 'private_draft'
    readonly executor: {
      readonly provider: string
      readonly model: string
      readonly endpoint: string
      readonly account: string
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

function sourceDigest(sources: readonly DiscoveryExecutionSourceView[]): string {
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
    }),
  )
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'discovery application not found')
}

/**
 * Rebuild the exact source package the application was materialized from, re-checking
 * every authority now. A single drifted source makes the whole authorization ineligible.
 */
async function loadBasis(
  tx: Tx,
  actorUserId: string,
  projectId: string,
  applicationId: string,
  now: Date,
): Promise<Basis> {
  const application = await getDiscoveryApplicationById(tx, applicationId)
  if (!application || application.projectId !== projectId) notFound()
  const permit = await getDiscoveryPermitForUpdate(tx, application.permitId)
  if (!permit || permit.principalUserId !== actorUserId) notFound()
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
    permit.principalUserId !== actorUserId ||
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
  const work = await getWorkByIdForUpdate(tx, application.workId)
  if (
    !task ||
    task.projectId !== projectId ||
    task.assigneeUserId !== actorUserId ||
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

  for (const evidence of application.verification.evidence) {
    const [artifact] = await tx
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, evidence.artifactId))
    const consent = artifact ? await sourceConsent(tx, cfg, artifact.ownerUserId) : undefined
    const publishedAt = artifact?.publishedAt?.toISOString()
    if (
      !artifact ||
      artifact.status !== 'published' ||
      artifact.sha256 !== evidence.sha256 ||
      artifact.ownerUserId === message.authorUserId ||
      !consent ||
      !publishedAt
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
      authorizationGeneration: `published:${publishedAt}:consent:${consent.version}:permit:${permit.version}`,
    })
  }

  for (const receipt of await listDiscoveryVerificationsByIds(
    tx,
    application.verification.receiptIds,
  )) {
    const consent = await sourceConsent(tx, cfg, receipt.verifierUserId)
    if (
      receipt.revokedAt !== null ||
      receipt.verifierUserId === message.authorUserId ||
      receipt.sourceVersion !== application.sourceVersion ||
      receipt.sourceDigest !== application.sourceDigest ||
      receipt.permitId !== permit.id ||
      !consent
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
      authorizationGeneration: `receipt:${receipt.createdAt.toISOString()}:consent:${consent.version}:permit:${permit.version}`,
    })
  }

  const missingReceipts =
    sources.filter((source) => source.kind === 'receipt').length !==
    new Set(application.verification.receiptIds).size
  if (missingReceipts)
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'receipt_changed',
    }
  if (
    application.verification.evidence.length === 0 &&
    application.verification.receiptIds.length === 0
  )
    return {
      application,
      sources: [],
      manifestDigest: '',
      eligible: false,
      reason: 'authority_changed',
    }

  sources.sort((left, right) =>
    left.kind === right.kind
      ? left.sourceId.localeCompare(right.sourceId)
      : left.kind.localeCompare(right.kind),
  )
  return {
    application,
    sources,
    manifestDigest: sourceDigest(sources),
    eligible: true,
  }
}

function toView(
  applicationId: string,
  basis: Basis,
  execution: DiscoveryExecutionRow | undefined,
  sources: readonly DiscoveryExecutionSourceView[],
): DiscoveryExecutionView {
  return {
    applicationId,
    eligible: basis.eligible,
    ...(basis.reason === undefined ? {} : { reason: basis.reason }),
    sourceManifestDigest: basis.manifestDigest === '' ? null : basis.manifestDigest,
    sources,
    execution: execution
      ? {
          id: execution.id,
          status: execution.revokedAt === null ? 'authorized' : 'revoked',
          purpose: 'private_draft',
          executor: {
            provider: execution.executorProvider,
            model: execution.executorModel,
            endpoint: execution.executorEndpoint,
            account: execution.executorAccount,
          },
          executorDigest: execution.executorDigest,
          sourceManifestDigest: execution.sourceManifestDigest,
          expiresAt: execution.expiresAt.toISOString(),
          authorizedAt: execution.authorizedAt.toISOString(),
          revokedAt: execution.revokedAt?.toISOString() ?? null,
          revokedReason: execution.revokedReason,
        }
      : null,
  }
}

export async function discoveryExecutionBasis(
  deps: { database: Database; now?: () => Date },
  actorUserId: string,
  projectId: string,
  applicationId: string,
): Promise<DiscoveryExecutionView> {
  return deps.database.transaction(async (tx) => {
    const basis = await loadBasis(tx, actorUserId, projectId, applicationId, nowOf(deps))
    const execution = await getDiscoveryExecutionByApplication(tx, applicationId)
    const stored = execution ? await listDiscoveryExecutionSources(tx, execution.id) : basis.sources
    return toView(applicationId, basis, execution, stored)
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
  let created:
    | { execution: DiscoveryExecutionRow; sources: readonly DiscoveryExecutionSourceView[] }
    | undefined
  const result = await transactCommand(
    deps.database,
    `discovery.execution:${actorUserId}:${projectId}:${applicationId}:${idempotencyKey}`,
    async (tx) => {
      const now = nowOf(deps)
      const basis = await loadBasis(tx, actorUserId, projectId, applicationId, now)
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
      const permitBound = basis.application.permitVersion
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
      if (!permit || permit.version !== permitBound || permit.revokedAt !== null)
        throw new ApiError(409, 'CONFLICT', 'discovery permit changed; refresh and confirm again')
      if (expiresAt.getTime() > permit.expiresAt.getTime())
        throw new ApiError(
          400,
          'VALIDATION_FAILED',
          'discovery execution expiry exceeds the parent permit',
        )

      const existing = await getDiscoveryExecutionForUpdate(tx, applicationId)
      if (existing) {
        if (existing.revokedAt !== null)
          throw new ApiError(409, 'CONFLICT', 'discovery execution was revoked', {
            code: 'DISCOVERY_EXECUTION_REVOKED',
          })
        const same =
          existing.sourceManifestDigest === basis.manifestDigest &&
          existing.executorDigest === executorDigest(input.executor) &&
          existing.expiresAt.toISOString() === expiresAt.toISOString()
        if (!same)
          throw new ApiError(
            409,
            'CONFLICT',
            'a different discovery execution is already authorized',
            {
              code: 'DISCOVERY_EXECUTION_EXISTS',
            },
          )
        const stored = await listDiscoveryExecutionSources(tx, existing.id)
        return { execution: existing, sources: stored }
      }

      const executionId = uuidv7(now.getTime())
      const execution = await insertDiscoveryExecution(tx, {
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
        executorDigest: executorDigest(input.executor),
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
      created = { execution, sources: basis.sources }
      return { execution, sources: basis.sources }
    },
  )
  if (created)
    deps.log?.({
      component: 'hub.discovery',
      action: 'discovery.execution.authorized',
      executionId: created.execution.id,
      applicationId,
      sourceCount: created.sources.length,
    })
  const basis = await deps.database.transaction((tx) =>
    loadBasis(tx, actorUserId, projectId, applicationId, nowOf(deps)),
  )
  const stored = await listDiscoveryExecutionSources(deps.database.db, result.execution.id)
  return toView(applicationId, basis, result.execution, stored)
}

export async function revokeDiscoveryExecutionByPrincipal(
  deps: { database: Database; now?: () => Date },
  actorUserId: string,
  projectId: string,
  applicationId: string,
): Promise<DiscoveryExecutionView> {
  return deps.database.transaction(async (tx) => {
    const basis = await loadBasis(tx, actorUserId, projectId, applicationId, nowOf(deps))
    const execution = await getDiscoveryExecutionForUpdate(tx, applicationId)
    if (!execution) notFound()
    await revokeDiscoveryExecution(tx, execution.id, 'principal_revoked', nowOf(deps))
    const [updated] = await tx
      .select()
      .from(schema.discoveryExecutions)
      .where(eq(schema.discoveryExecutions.id, execution.id))
    const sources = await listDiscoveryExecutionSources(tx, execution.id)
    return toView(applicationId, basis, updated, sources)
  })
}

/** Revoke authorization when the parent permit/config changes or the source drifts. */
export async function revokeDiscoveryExecutionsForApplication(
  tx: Tx,
  applicationId: string,
  reason: string,
  now: Date,
): Promise<void> {
  const execution = await getDiscoveryExecutionForUpdate(tx, applicationId)
  if (!execution) return
  await revokeDiscoveryExecution(tx, execution.id, reason, now)
}

export async function revokeDiscoveryExecutionsForApplications(
  tx: Tx,
  applicationIds: readonly string[],
  reason: string,
  now: Date,
): Promise<void> {
  if (applicationIds.length === 0) return
  const rows = await tx
    .select({ id: schema.discoveryExecutions.id })
    .from(schema.discoveryExecutions)
    .where(
      and(
        isNull(schema.discoveryExecutions.revokedAt),
        inArray(schema.discoveryExecutions.applicationId, [...applicationIds]),
      ),
    )
  for (const row of rows) await revokeDiscoveryExecution(tx, row.id, reason, now)
}
