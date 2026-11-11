import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNull, lte, notExists } from 'drizzle-orm'
import {
  getDiscoveryApplicationByCandidate,
  getEvaluation,
  getEvaluationForUpdate,
  hasRunningCoordinationEvaluation,
  insertEvaluation,
  listUnsettledCoordinationUsage,
  reserveCoordinationUsage,
  schema,
  settleCoordinationUsage,
  updateEvaluation,
  type CoordinationEvaluationRow,
  type RouterConfigRow,
  type Tx,
} from '@whalepod/db'
import {
  ConfigureProjectRouterRequestSchema,
  coordinationUsageCost,
  DiscoveryProposalSchema,
  DiscoveryRequestPayloadSchema,
  type DiscoveryHeartbeat,
  type DiscoveryRequest,
  type DiscoveryResult,
  type DiscoveryResultAck,
  type NodeDownstream,
} from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { nodeConnections } from '../device/connection-registry.js'
import type { RouterDeps } from '../router/service.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { activeConsent, available, discoveryAdmission, discoveryConfig } from './admission.js'
import { applyDiscoveryCandidate, applyPendingDiscoveryCandidates } from './creation.js'
import {
  DISCOVERY_PROMPT_VERSION,
  DISCOVERY_RULES_VERSION,
  fenceDiscoveryAuthority,
  loadDiscoveryInput,
  supportsDiscovery,
  unavailable,
} from './input.js'

type Binding = { purpose: 'discovery'; evaluationId: string; attempt: number; leaseToken: string }
const QUEUE_TTL_MS = 10 * 60_000
const CANDIDATE_TTL_MS = 24 * 60 * 60_000
const PENDING_PROJECT_BATCH = 20
const pendingProjectCursor = new WeakMap<RouterDeps['database'], string>()
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'skipped', 'stale'])
const PRE_MODEL_FAILURES = new Set([
  'input_digest_mismatch',
  'input_too_large',
  'credential_unavailable',
  'source_unavailable',
])
// Device frames are authenticated but their free text cannot enter shared logs or the ledger.
const DEVICE_FAILURE_CODES = new Set([
  ...PRE_MODEL_FAILURES,
  'isolation_unavailable',
  'invalid_provider_endpoint',
  'input_download_failed',
  'runtime_start_failed',
  'runtime_protocol_failed',
  'runtime_lost',
  'node_lost',
  'unsupported_tool_call',
  'usage_missing',
  'incomplete_model_result',
  'output_too_large',
  'provider_request_failed',
  'invalid_model_result',
  'invalid_model_request',
  'invalid_citation',
  'invalid_coverage',
  'over_budget',
  'timeout',
  'cancelled',
])
const nowOf = (deps: RouterDeps) => deps.now?.() ?? new Date()

function bound(row: CoordinationEvaluationRow, deviceId: string, value: Binding): boolean {
  return (
    row.purpose === 'discovery' &&
    value.purpose === 'discovery' &&
    row.id === value.evaluationId &&
    row.deviceId === deviceId &&
    row.attempt === value.attempt &&
    row.leaseToken === value.leaseToken
  )
}
function live(row: CoordinationEvaluationRow, now: Date): boolean {
  return (
    ['dispatched', 'running'].includes(row.status) &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > now &&
    row.deadlineAt !== null &&
    row.deadlineAt > now
  )
}
function binding(row: CoordinationEvaluationRow): Binding {
  if (row.leaseToken === null) throw new Error('discovery lease missing')
  return {
    purpose: 'discovery',
    evaluationId: row.id,
    attempt: row.attempt,
    leaseToken: row.leaseToken,
  }
}
function emit(deps: RouterDeps, action: string, row: CoordinationEvaluationRow, reason?: string) {
  deps.log?.({
    component: 'hub.discovery',
    action,
    projectId: row.projectId,
    evaluationId: row.id,
    sourceId: row.discoverySourceId,
    attempt: row.attempt,
    status: row.status,
    ...(reason === undefined ? {} : { reason }),
  })
}
type DiscoveryMessage =
  | Pick<Extract<NodeDownstream, { type: 'discovery.request' }>, 'type' | 'payload'>
  | Pick<Extract<NodeDownstream, { type: 'discovery.cancel' }>, 'type' | 'payload'>

function send(deviceId: string | null, message: DiscoveryMessage) {
  if (!deviceId) return
  nodeConnections.sendDiscovery(deviceId, {
    protocolVersion: 1,
    messageId: uuidv7(),
    sentAt: new Date().toISOString(),
    ...message,
  })
}

async function rebuild(tx: Tx, row: CoordinationEvaluationRow, deps: RouterDeps) {
  if (row.purpose !== 'discovery' || !row.discoverySourceId) throw unavailable()
  const input = await loadDiscoveryInput(tx, row.discoverySourceId, nowOf(deps), deps.store)
  if (
    input.evaluationDigest !== row.evaluationDigest ||
    input.admission.evaluationId !== row.id ||
    input.cfg.version !== row.configVersion ||
    input.cfg.settings.principalUserId !== row.principalUserId ||
    input.model.deviceId !== row.deviceId ||
    !supportsDiscovery(input.device.capabilities, input.model) ||
    !available(input.cfg, nowOf(deps))
  )
    throw unavailable()
  return input
}

function requestFor(row: CoordinationEvaluationRow): DiscoveryRequest {
  const cfg = row.configSnapshot
  if (!cfg || row.leaseExpiresAt === null || row.deadlineAt === null)
    throw new Error('discovery request incomplete')
  return DiscoveryRequestPayloadSchema.parse({
    ...binding(row),
    projectId: row.projectId,
    evaluationDigest: row.evaluationDigest,
    principalUserId: row.principalUserId,
    operatorUserId: cfg.operatorUserId,
    billingUserId: cfg.billingUserId,
    permitVersion: row.inputManifest['permitVersion'],
    promptVersion: DISCOVERY_PROMPT_VERSION,
    provider: cfg.provider,
    model: cfg.model,
    credentialSlot: cfg.credentialSlot,
    credentialConfigRevision: cfg.credentialConfigRevision,
    configVersion: row.configVersion,
    manifest: row.inputManifest['entries'],
    coverageComplete: row.inputManifest['coverageComplete'],
    inputTokensEstimate: row.inputTokensEstimate,
    maxInputTokens: cfg.maxInputTokens,
    maxOutputTokens: cfg.maxOutputTokens,
    maxCostMicros: row.reservedCostMicros,
    inputPriceMicrosPerMillionTokens: cfg.inputPriceMicrosPerMillionTokens,
    outputPriceMicrosPerMillionTokens: cfg.outputPriceMicrosPerMillionTokens,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
  })
}

async function dispatch(deps: RouterDeps, sourceId: string) {
  return deps.database.transaction(async (tx) => {
    const a = schema.discoveryAdmissions
    const initial = await discoveryAdmission(tx, sourceId)
    if (!initial || initial.processedAt !== null || initial.route !== 'discovery') return
    const now = nowOf(deps)
    let input: Awaited<ReturnType<typeof loadDiscoveryInput>>
    try {
      input = await loadDiscoveryInput(tx, sourceId, now, deps.store)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      await tx
        .update(a)
        .set({ processedAt: now, processingReason: 'input_or_authority_changed' })
        .where(and(eq(a.sourceId, sourceId), isNull(a.processedAt)))
      return
    }
    if (input.admission.processedAt !== null) return
    const expires = input.admission.createdAt.getTime() + QUEUE_TTL_MS
    if (expires <= now.getTime()) {
      await tx
        .update(a)
        .set({ processedAt: now, processingReason: 'stale_queue' })
        .where(eq(a.sourceId, sourceId))
      return
    }
    if (
      (await hasRunningCoordinationEvaluation(tx, input.admission.projectId)) ||
      !nodeConnections.canDispatchDiscovery(input.device.id, input.model) ||
      !supportsDiscovery(input.device.capabilities, input.model)
    )
      return
    const cfg = input.cfg.settings
    const model = input.model
    const snapshot = ConfigureProjectRouterRequestSchema.parse(
      Object.fromEntries(
        Object.keys(ConfigureProjectRouterRequestSchema.shape).map((key) => [
          key,
          model[key as keyof typeof model],
        ]),
      ),
    )
    const reservedTokens = input.inputTokensEstimate + model.maxOutputTokens
    const reservedCostMicros = coordinationUsageCost({
      inputTokens: input.inputTokensEstimate,
      outputTokens: model.maxOutputTokens,
      ...model,
    })
    const row = await insertEvaluation(tx, {
      id: uuidv7(),
      projectId: input.admission.projectId,
      purpose: 'discovery',
      discoverySourceId: sourceId,
      principalUserId: cfg.principalUserId,
      deviceId: model.deviceId,
      configVersion: input.cfg.version,
      configSnapshot: snapshot,
      inputDigest: input.evaluationDigest,
      evaluationDigest: input.evaluationDigest,
      inputManifest: {
        entries: input.manifest,
        omissions: input.omissions,
        coverageComplete: input.coverageComplete,
        permitVersion: input.permit.version,
      },
      inputTokensEstimate: input.inputTokensEstimate,
      rulesVersion: DISCOVERY_RULES_VERSION,
      processorVersion: DISCOVERY_PROMPT_VERSION,
      status: 'queued',
      queuedAt: input.admission.createdAt,
      queueExpiresAt: new Date(expires),
    })
    const reserved =
      reservedCostMicros <= model.maxCostMicros &&
      (await reserveCoordinationUsage(tx, {
        evaluationId: row.id,
        attempt: row.attempt,
        projectId: row.projectId,
        teamId: input.teamId,
        workKey: null,
        utcDate: now.toISOString().slice(0, 10),
        reservedTokens,
        reservedCostMicros,
        retry: false,
        teamLimits: {
          calls: model.teamDailyCallLimit,
          tokens: model.teamDailyTokenLimit,
          costMicros: model.teamDailyCostMicrosLimit,
        },
        projectLimits: {
          calls: model.projectDailyCallLimit,
          tokens: model.projectDailyTokenLimit,
          costMicros: model.projectDailyCostMicrosLimit,
        },
        discoveryLimits: {
          calls: cfg.maxCalls,
          tokens: cfg.maxTokens,
          costMicros: cfg.maxCostMicros,
        },
      }))
    await tx
      .update(a)
      .set({
        processedAt: now,
        evaluationId: row.id,
        processingReason: reserved ? 'dispatched' : 'budget_exhausted',
      })
      .where(eq(a.sourceId, sourceId))
    if (!reserved)
      return updateEvaluation(tx, row.id, {
        status: 'skipped',
        failureCode: 'budget_exhausted',
        finishedAt: now,
      })
    const deadlineAt = new Date(
      Math.min(now.getTime() + model.timeoutSeconds * 1_000, Date.parse(cfg.expiresAt)),
    )
    return updateEvaluation(tx, row.id, {
      status: 'dispatched',
      leaseToken: randomBytes(32).toString('hex'),
      leaseExpiresAt: deadlineAt,
      deadlineAt,
      reservedTokens,
      reservedCostMicros,
    })
  })
}

export async function downloadDiscoveryInput(
  deps: RouterDeps,
  deviceId: string,
  value: Binding,
  entryId: string,
) {
  return deps.database.transaction(async (tx) => {
    const row = await getEvaluation(tx, value.evaluationId)
    if (!row || !bound(row, deviceId, value) || !live(row, nowOf(deps))) throw unavailable()
    const input = await rebuild(tx, row, deps)
    const current = await getEvaluationForUpdate(tx, row.id)
    if (!current || !bound(current, deviceId, value) || !live(current, nowOf(deps)))
      throw unavailable()
    const entry = input.manifest.find((e) => e.id === entryId)
    const body = input.bodies.get(entryId)
    if (!entry || body === undefined || !(await fenceDiscoveryAuthority(tx, input)))
      throw unavailable()
    if (!live(current, nowOf(deps)) || !available(input.cfg, nowOf(deps))) throw unavailable()
    // A Node receipt by itself does not prove the Hub ever served the frozen bytes.
    if (!current.discoveryDownloadedIds.includes(entry.id))
      await updateEvaluation(tx, current.id, {
        discoveryDownloadedIds: [...current.discoveryDownloadedIds, entry.id],
      })
    return { ...entry, bodyBase64: Buffer.from(body).toString('base64') }
  })
}

export async function acceptDiscoveryHeartbeat(
  deps: RouterDeps,
  deviceId: string,
  value: DiscoveryHeartbeat,
  canStartOnCurrentConnection: (model: RouterConfigRow) => boolean,
) {
  const wantsModelStart = value.modelStartedAt !== undefined
  const row = await deps.database.transaction(async (tx) => {
    const snapshot = await getEvaluation(tx, value.evaluationId)
    if (!snapshot || !bound(snapshot, deviceId, value) || !live(snapshot, nowOf(deps))) return
    let input: Awaited<ReturnType<typeof rebuild>>
    try {
      input = await rebuild(tx, snapshot, deps)
    } catch (error) {
      // Normal source/permit revocation is an evaluation boundary, not a socket violation.
      if (error instanceof ApiError) return
      throw error
    }
    const row = await getEvaluationForUpdate(tx, snapshot.id)
    if (!row || !bound(row, deviceId, value) || !live(row, nowOf(deps))) return
    // A lost ACK fails closed. Replaying this lease must not authorize a second Provider call.
    if (wantsModelStart && row.modelStartedAt !== null) return
    const readEntryIds = [...new Set([...row.readEntryIds, ...value.readEntryIds])]
    if (
      new Set(value.readEntryIds).size !== value.readEntryIds.length ||
      value.readEntryIds.some(
        (id) =>
          !row.discoveryDownloadedIds.includes(id) || !input.manifest.some((e) => e.id === id),
      ) ||
      (wantsModelStart && readEntryIds.length !== input.manifest.length)
    )
      return
    if (wantsModelStart && !(await fenceDiscoveryAuthority(tx, input))) return
    const now = nowOf(deps)
    if (
      !live(row, now) ||
      !available(input.cfg, now) ||
      (wantsModelStart && !canStartOnCurrentConnection(input.model))
    )
      return
    return updateEvaluation(tx, row.id, {
      status: 'running',
      startedAt: row.startedAt ?? now,
      readEntryIds,
      modelStartedAt: row.modelStartedAt ?? (wantsModelStart ? now : null),
    })
  })
  if (row) emit(deps, wantsModelStart ? 'discovery.model_start' : 'discovery.read', row)
  return row && wantsModelStart ? binding(row) : undefined
}

export async function acceptDiscoveryResult(
  deps: RouterDeps,
  deviceId: string,
  value: DiscoveryResult,
): Promise<DiscoveryResultAck> {
  const ack: DiscoveryResultAck = {
    purpose: 'discovery',
    evaluationId: value.evaluationId,
    attempt: value.attempt,
    leaseToken: value.leaseToken,
    status: 'rejected',
  }
  const updated = await deps.database.transaction(async (tx) => {
    const snapshot = await getEvaluation(tx, value.evaluationId)
    if (!snapshot || !bound(snapshot, deviceId, value)) return
    if (TERMINAL.has(snapshot.status)) {
      ack.status =
        snapshot.status === 'completed' &&
        value.status === 'completed' &&
        value.resultDigest === snapshot.resultDigest &&
        value.evaluationDigest === snapshot.evaluationDigest
          ? 'duplicate'
          : 'late'
      return snapshot
    }
    let input: Awaited<ReturnType<typeof rebuild>> | undefined
    try {
      input = await rebuild(tx, snapshot, deps)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
    }
    const row = await getEvaluationForUpdate(tx, snapshot.id)
    if (!row || !bound(row, deviceId, value)) return
    if (TERMINAL.has(row.status)) {
      ack.status =
        row.status === 'completed' &&
        value.status === 'completed' &&
        value.resultDigest === row.resultDigest &&
        value.evaluationDigest === row.evaluationDigest
          ? 'duplicate'
          : 'late'
      return row
    }
    if (input && value.status === 'completed' && !(await fenceDiscoveryAuthority(tx, input)))
      input = undefined
    const now = nowOf(deps)
    let reject =
      !input || !available(input.cfg, now)
        ? 'input_or_authority_changed'
        : !live(row, now)
          ? 'lease_or_deadline_expired'
          : value.evaluationDigest !== row.evaluationDigest
            ? 'evaluation_digest_mismatch'
            : undefined
    const cfg = row.configSnapshot
    const usage = value.usage
    let validUsage = false
    if (cfg && usage && usage.provider === cfg.provider && usage.model === cfg.model) {
      try {
        validUsage = usage.costMicros >= coordinationUsageCost({ ...cfg, ...usage })
      } catch {
        validUsage = false
      }
    }
    if (
      usage &&
      (!validUsage ||
        usage.inputTokens > (row.inputTokensEstimate ?? 0) ||
        usage.outputTokens > (cfg?.maxOutputTokens ?? 0) ||
        usage.costMicros > (row.reservedCostMicros ?? 0))
    )
      reject ??= 'over_budget'
    if (
      new Set(value.readEntryIds).size !== value.readEntryIds.length ||
      value.readEntryIds.some((id) => !row.readEntryIds.includes(id))
    )
      reject ??= 'read_receipt_missing'
    if (value.status === 'completed') {
      if (
        !usage ||
        row.modelStartedAt === null ||
        value.readEntryIds.length !== input?.manifest.length
      )
        reject ??= 'required_receipt_missing'
      if (sha256Hex(canonicalJson(value.proposal)) !== value.resultDigest)
        reject ??= 'result_digest_mismatch'
      if (input && !validDiscoveryReferences(value.proposal, input)) reject ??= 'invalid_citation'
      if (
        !reject &&
        input &&
        (value.proposal.classification === 'independent_gap' ||
          value.proposal.classification === 'insufficient')
      ) {
        await tx.insert(schema.discoveryCandidates).values({
          id: uuidv7(),
          evaluationId: row.id,
          projectId: row.projectId,
          sourceId: input.admission.sourceId,
          sourceVersion: input.admission.sourceVersion,
          principalUserId: input.cfg.settings.principalUserId,
          proposal: value.proposal,
          createdAt: now,
          checkedAt: now,
          expiresAt: new Date(
            Math.min(now.getTime() + CANDIDATE_TTL_MS, Date.parse(input.cfg.settings.expiresAt)),
          ),
        })
      }
    }
    const status = reject ? 'stale' : value.status === 'completed' ? 'completed' : 'failed'
    const failureCode =
      reject ??
      (value.status === 'failed'
        ? DEVICE_FAILURE_CODES.has(value.failureCode)
          ? value.failureCode
          : 'invalid_result'
        : null)
    ack.status = status === 'completed' ? 'accepted' : 'rejected'
    return updateEvaluation(tx, row.id, {
      status,
      failureCode,
      finishedAt: now,
      usage: validUsage ? (usage ?? null) : null,
      resultDigest: !reject && value.status === 'completed' ? value.resultDigest : null,
      discoveryObservation:
        !reject && value.status === 'completed'
          ? {
              classification: value.proposal.classification,
              source: value.proposal.source,
              slot: value.proposal.slot,
              citations: value.proposal.citations,
            }
          : null,
      preModelFailureConfirmed:
        !reject &&
        value.status === 'failed' &&
        row.modelStartedAt === null &&
        PRE_MODEL_FAILURES.has(value.failureCode) &&
        (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.costMicros === 0)),
    })
  })
  if (updated) {
    await settle(deps, updated)
    emit(deps, 'discovery.result', updated, updated.failureCode ?? undefined)
    // RD-04b：模型接受与业务应用分两次裁决；候选落库后在同一次调用内尝试立项，
    // 失败只写候选水位，tick 会按同一幂等事务补偿。
    if (updated.status === 'completed') {
      const [candidate] = await deps.database.db
        .select({ id: schema.discoveryCandidates.id })
        .from(schema.discoveryCandidates)
        .where(eq(schema.discoveryCandidates.evaluationId, updated.id))
        .limit(1)
      if (candidate) {
        try {
          await applyDiscoveryCandidate(deps, candidate.id)
        } catch {
          // The tick retries the same idempotent application; the ack itself must not fail.
          deps.log?.({
            component: 'hub.discovery',
            action: 'discovery.application_failed',
            evaluationId: updated.id,
            candidateId: candidate.id,
          })
        }
      }
    }
  }
  return ack
}

function validDiscoveryReferences(
  proposal: ReturnType<typeof DiscoveryProposalSchema.parse>,
  input: Awaited<ReturnType<typeof rebuild>>,
) {
  const references = proposal.citations.map((id) => input.manifest.find((e) => e.id === id))
  if (
    !input.manifest.some((e) => e.kind === 'source' && e.id === proposal.source) ||
    references.some((ref) => ref === undefined || ref.kind === 'source' || ref.kind === 'slot') ||
    new Set(proposal.citations).size !== proposal.citations.length
  )
    return false
  if (proposal.classification === 'independent_gap')
    return (
      input.coverageComplete &&
      input.manifest.some((e) => e.kind === 'slot' && e.id === proposal.slot) &&
      references.some((e) => e?.kind === 'agreement' || e?.kind === 'evidence') &&
      references.some((e) => e?.kind === 'work')
    )
  if (proposal.classification === 'covered')
    return (
      proposal.slot === null &&
      references.some((e) => e?.kind === 'agreement' || e?.kind === 'evidence')
    )
  return proposal.slot === null
}

async function settle(deps: RouterDeps, row: CoordinationEvaluationRow) {
  if (!TERMINAL.has(row.status)) return
  const zeroCharge =
    row.preModelFailureConfirmed &&
    row.modelStartedAt === null &&
    PRE_MODEL_FAILURES.has(row.failureCode ?? '')
  const settled = await deps.database.transaction((tx) =>
    settleCoordinationUsage(tx, {
      evaluationId: row.id,
      attempt: row.attempt,
      zeroCharge,
      ...(row.usage === null ? {} : { usage: row.usage }),
    }),
  )
  if (settled)
    emit(
      deps,
      'discovery.usage_settled',
      row,
      zeroCharge ? 'zero' : row.usage ? 'actual' : 'reserved',
    )
}

export async function listDiscoveryCandidates(
  deps: RouterDeps,
  projectId: string,
  actorUserId: string,
) {
  return deps.database.transaction(async (tx) => {
    const now = nowOf(deps)
    const cfg = await discoveryConfig(tx, projectId)
    if (
      !available(cfg, now) ||
      cfg.settings.principalUserId !== actorUserId ||
      !(await activeConsent(tx, cfg, actorUserId, 'permit'))
    )
      throw unavailable()
    const t = schema.discoveryCandidates
    const e = schema.coordinationEvaluations
    const candidates = await tx
      .select({ candidate: t, evaluation: e })
      .from(t)
      .innerJoin(e, eq(e.id, t.evaluationId))
      .where(
        and(
          eq(t.projectId, projectId),
          eq(t.principalUserId, actorUserId),
          eq(e.configVersion, cfg.version),
          eq(e.status, 'completed'),
          gt(t.expiresAt, now),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(20)
    const view = []
    for (const { candidate, evaluation } of candidates) {
      try {
        const application = await getDiscoveryApplicationByCandidate(tx, candidate.id)
        let manifest: {
          id: string
          kind: string
          sourceId: string
          version: string
          digest: string
        }[]
        let omissions: string[]
        if (application !== undefined) {
          // An applied candidate predates the task it created; rebuilding would compare
          // against a catalog that now includes that task. Use the frozen evaluation input.
          const frozen = evaluation.inputManifest['entries']
          if (!Array.isArray(frozen)) continue
          manifest = frozen as typeof manifest
          const frozenOmissions = evaluation.inputManifest['omissions']
          omissions = Array.isArray(frozenOmissions) ? (frozenOmissions as string[]) : []
        } else {
          const current = await rebuild(tx, evaluation, deps)
          if (
            current.cfg.settings.principalUserId !== actorUserId ||
            !(await fenceDiscoveryAuthority(tx, current)) ||
            !available(current.cfg, nowOf(deps)) ||
            candidate.expiresAt <= nowOf(deps)
          )
            continue
          manifest = current.manifest
          omissions = current.omissions
        }
        const { proposal } = candidate
        const citations = manifest
          .filter(
            (entry) =>
              entry.id === proposal.source ||
              entry.id === proposal.slot ||
              proposal.citations.includes(entry.id),
          )
          .map(({ id, kind, sourceId, version, digest }) => ({
            id,
            kind,
            sourceId,
            version,
            digest,
          }))
        view.push({
          id: candidate.id,
          evaluationId: candidate.evaluationId,
          sourceId: candidate.sourceId,
          sourceVersion: candidate.sourceVersion,
          classification: proposal.classification,
          reason: proposal.reason,
          citations,
          omissions,
          application: application
            ? {
                id: application.id,
                status: application.status,
                taskId: application.taskId,
                workId: application.workId,
                appliedAt: application.appliedAt.toISOString(),
              }
            : null,
          createdAt: candidate.createdAt.toISOString(),
          expiresAt: candidate.expiresAt.toISOString(),
        })
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
      }
    }
    return view
  })
}

/** Sample the oldest admission per project, rotating the bounded window across ticks. */
async function takePendingProjects(deps: RouterDeps) {
  const a = schema.discoveryAdmissions
  const cursor = pendingProjectCursor.get(deps.database)
  const batch = (after: boolean, limit: number) =>
    deps.database.db
      .selectDistinctOn([a.projectId], { sourceId: a.sourceId, projectId: a.projectId })
      .from(a)
      .where(
        and(
          eq(a.route, 'discovery'),
          isNull(a.processedAt),
          cursor === undefined
            ? undefined
            : after
              ? gt(a.projectId, cursor)
              : lte(a.projectId, cursor),
        ),
      )
      .orderBy(asc(a.projectId), asc(a.createdAt), asc(a.sourceId))
      .limit(limit)
  const pending = await batch(true, PENDING_PROJECT_BATCH)
  if (cursor !== undefined && pending.length < PENDING_PROJECT_BATCH)
    pending.push(...(await batch(false, PENDING_PROJECT_BATCH - pending.length)))
  const last = pending.at(-1)
  if (last) pendingProjectCursor.set(deps.database, last.projectId)
  return pending
}

export async function runDiscoveryTick(deps: RouterDeps) {
  const e = schema.coordinationEvaluations
  const now = nowOf(deps)
  const active = await deps.database.db
    .select()
    .from(e)
    .where(and(eq(e.purpose, 'discovery'), inArray(e.status, ['dispatched', 'running'])))
    .orderBy(asc(e.startedAt), asc(e.id))
    .limit(100)
  for (const row of active) {
    let reason = !live(row, now) ? 'lease_or_deadline_expired' : undefined
    if (!reason) {
      try {
        await deps.database.transaction((tx) => rebuild(tx, row, deps))
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        reason = 'input_or_authority_changed'
      }
    }
    if (reason) {
      const ended = await deps.database.transaction(async (tx) => {
        const locked = await getEvaluationForUpdate(tx, row.id)
        if (!locked || TERMINAL.has(locked.status)) return
        return updateEvaluation(tx, row.id, {
          status: 'cancelled',
          failureCode: reason ?? null,
          finishedAt: now,
        })
      })
      if (ended) {
        send(ended.deviceId, { type: 'discovery.cancel', payload: { ...binding(ended), reason } })
        await settle(deps, ended)
        emit(deps, 'discovery.cancel', ended, reason)
      }
    } else if (row.status === 'dispatched') {
      send(row.deviceId, { type: 'discovery.request', payload: requestFor(row) })
    }
  }
  for (const { sourceId } of await takePendingProjects(deps)) {
    const dispatched = await dispatch(deps, sourceId)
    if (!dispatched) continue
    emit(deps, 'discovery.evaluation', dispatched, dispatched.failureCode ?? undefined)
    if (dispatched.status === 'dispatched')
      send(dispatched.deviceId, { type: 'discovery.request', payload: requestFor(dispatched) })
  }
  for (const ledger of await listUnsettledCoordinationUsage(deps.database.db, 100, 'discovery')) {
    const row = await getEvaluation(deps.database.db, ledger.evaluationId)
    if (row) await settle(deps, row)
  }
  await cleanDiscoveryCandidates(deps, now)
  await applyPendingDiscoveryCandidates(deps, 10)
}

/** Revalidate bounded batches so a revoked excerpt does not survive in Hub candidate storage. */
async function cleanDiscoveryCandidates(deps: RouterDeps, now: Date) {
  const t = schema.discoveryCandidates
  await deps.database.db
    .delete(t)
    .where(
      and(
        lte(t.expiresAt, now),
        notExists(
          deps.database.db
            .select({ one: schema.discoveryApplications.id })
            .from(schema.discoveryApplications)
            .where(eq(schema.discoveryApplications.candidateId, t.id)),
        ),
      ),
    )
  const staleChecks = await deps.database.db
    .select({ id: t.id, evaluationId: t.evaluationId })
    .from(t)
    .where(lte(t.checkedAt, new Date(now.getTime() - 60_000)))
    .orderBy(asc(t.checkedAt), asc(t.id))
    .limit(10)
  for (const candidate of staleChecks) {
    await deps.database.transaction(async (tx) => {
      const evaluation = await getEvaluation(tx, candidate.evaluationId)
      try {
        if (!evaluation) throw unavailable()
        await rebuild(tx, evaluation, deps)
        await tx.update(t).set({ checkedAt: now }).where(eq(t.id, candidate.id))
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        await tx.delete(t).where(eq(t.id, candidate.id))
      }
    })
  }
}
