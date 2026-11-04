import { randomBytes } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import {
  configureRouter,
  countChargedRouterFailuresForWork,
  countFailedMachineRunsForWork,
  countMachineRunsForWork,
  findQueuedRouterEvaluationForUpdate,
  findRouterEvaluationByDigest,
  getEvaluation,
  getEvaluationForUpdate,
  getRouterConfig,
  getTeam,
  getProject,
  ensureCoordinatorState,
  getCoordinatorStateForUpdate,
  hasRunningCoordinationEvaluation,
  insertEvaluation,
  listQueuedRouterEvaluations,
  listUnsettledCoordinationUsage,
  reserveCoordinationUsage,
  schema,
  settleCoordinationUsage,
  transactCommand,
  updateEvaluation,
  type CoordinationEvaluationRow,
  type Database,
  type RouterConfigRow,
  type Tx,
} from '@whalepod/db'
import {
  CoordinationCredentialSlotSchema,
  CoordinationInputEntrySchema,
  ConfigureProjectRouterRequestSchema,
  CoordinationRequestPayloadSchema,
  RouterProposalSchema,
  coordinationUsageCost,
  type ConfigureProjectRouterRequest,
  type CoordinationHeartbeat,
  type CoordinationRequest,
  type CoordinationResult,
  type CoordinationResultAck,
  type NodeDownstream,
} from '@whalepod/protocol'
import type { ArtifactStore } from '../artifact/store.js'
import { nodeConnections } from '../device/connection-registry.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { requireAssignee } from '../work/context.js'
import { loadWorkSource } from '../work/admission.js'
import {
  loadRouterInput,
  lockRouterContext,
  ROUTER_PROMPT_VERSION,
  ROUTER_RULES_VERSION,
  type RouterTrigger,
} from './input.js'

export interface RouterDeps {
  database: Database
  store?: ArtifactStore
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}
type Actor = { userId: string; role: 'owner' | 'admin' | 'member' }
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped', 'stale'])
const nowOf = (deps: RouterDeps): Date => deps.now?.() ?? new Date()
function event(
  deps: RouterDeps,
  action: string,
  row: CoordinationEvaluationRow,
  reason?: string,
): void {
  deps.log?.({
    component: 'hub.router',
    action,
    evaluationId: row.id,
    workKey: row.workKey,
    attempt: row.attempt,
    status: row.status,
    ...(reason ? { reason } : {}),
  })
}
export function routerEvaluationView(row: CoordinationEvaluationRow) {
  return {
    id: row.id,
    purpose: row.purpose,
    workKey: row.workKey,
    evaluationDigest: row.evaluationDigest,
    attempt: row.attempt,
    status: row.status,
    manifest: row.inputManifest.entries ?? [],
    readEntryIds: row.readEntryIds,
    proposal: row.routerProposal,
    failureCode: row.failureCode,
    usage: row.usage,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

export async function configureRouterForActor(
  deps: RouterDeps,
  actor: Actor,
  projectId: string,
  input: ConfigureProjectRouterRequest,
  key: string,
) {
  if (actor.role === 'member')
    throw new ApiError(403, 'FORBIDDEN', 'router configuration requires administrator')
  if (input.operatorUserId !== actor.userId || input.billingUserId !== actor.userId)
    throw new ApiError(403, 'FORBIDDEN', 'router requires explicit operator and billing owner')
  return transactCommand(
    deps.database,
    `router.config:${projectId}:${actor.userId}:${key}`,
    async (tx) => {
      if (!(await getProject(tx, projectId)))
        throw new ApiError(404, 'NOT_FOUND', 'project not found')
      // Serialize an absent config without taking Project before the coordinator state lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`router.config:${projectId}`},0))`,
      )
      await ensureCoordinatorState(tx, {
        projectId,
        rulesVersion: 'pc04a.v1',
        processorVersion: 'pc04a.v1',
      })
      await getCoordinatorStateForUpdate(tx, projectId)
      const [device] = await tx
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, input.deviceId))
      if (!device || device.revokedAt !== null || device.ownerUserId !== actor.userId)
        throw new ApiError(403, 'FORBIDDEN', 'coordination device is not owned by operator')
      const previous = await getRouterConfig(tx, projectId)
      const team = await getTeam(tx)
      if (!team) throw new ApiError(409, 'CONFLICT', 'team not initialized')
      const row = await configureRouter(tx, {
        ...input,
        teamId: team.id,
        projectId,
        configVersion: (previous?.configVersion ?? 0) + 1,
        configuredByUserId: actor.userId,
      })
      // Do not lock evaluation rows while holding Project: enqueue holds Task/Work first.
      // Rebuild fences reject the old config immediately; the production tick cancels old rows.
      return { projectId, enabled: row.enabled, configVersion: row.configVersion }
    },
  )
}

async function enqueueInTransaction(
  tx: Tx,
  deps: RouterDeps,
  workKey: string,
  trigger: RouterTrigger,
  actor?: Actor,
) {
  const { work, task } = await lockRouterContext(tx, workKey)
  if (actor) await requireAssignee(tx, task, actor.userId)
  const cfg = await getRouterConfig(tx, work.projectId)
  if (!cfg?.enabled)
    throw new ApiError(409, 'CONFLICT', 'router model configuration is missing or disabled')
  if (cfg.operatorUserId !== task.assigneeUserId || cfg.billingUserId !== task.assigneeUserId)
    throw new ApiError(409, 'CONFLICT', 'router cannot act across principals')
  const input = await loadRouterInput(tx, workKey, trigger, cfg, nowOf(deps), deps.store)
  const previous = await findRouterEvaluationByDigest(tx, work.projectId, input.evaluationDigest)
  if (previous && previous.status !== 'failed') return previous
  if (previous && previous.attempt > cfg.maxRetries)
    throw new ApiError(409, 'CONFLICT', 'router retry limit exhausted')
  const queued = await findQueuedRouterEvaluationForUpdate(tx, work.projectId, workKey)
  if (queued)
    await updateEvaluation(tx, queued.id, {
      status: 'cancelled',
      failureCode: 'input_superseded',
      finishedAt: nowOf(deps),
    })
  // Save config without endpoints/secrets. Source bodies are rebuilt and reauthorized on demand.
  const snapshot = ConfigureProjectRouterRequestSchema.parse(
    Object.fromEntries(
      Object.keys(ConfigureProjectRouterRequestSchema.shape).map((k) => [
        k,
        cfg[k as keyof RouterConfigRow],
      ]),
    ),
  )
  return insertEvaluation(tx, {
    id: uuidv7(),
    projectId: work.projectId,
    purpose: 'router',
    workId: work.id,
    workKey,
    taskId: task.id,
    principalUserId: task.assigneeUserId,
    mandateId: input.mandate.id,
    mandateVersion: input.mandate.version,
    evaluationDigest: input.evaluationDigest,
    inputDigest: input.evaluationDigest,
    deviceId: cfg.deviceId,
    configVersion: cfg.configVersion,
    configSnapshot: snapshot,
    routerContext: trigger,
    inputManifest: { entries: input.manifest },
    inputTokensEstimate: input.inputTokensEstimate,
    attempt: (previous?.attempt ?? 0) + 1,
    status: 'queued',
    rulesVersion: ROUTER_RULES_VERSION,
    processorVersion: ROUTER_PROMPT_VERSION,
    queuedAt: nowOf(deps),
    queueExpiresAt: new Date(nowOf(deps).getTime() + 600_000),
  })
}

export async function requestRouterEvaluation(
  deps: RouterDeps,
  actor: Actor,
  workKey: string,
  trigger: RouterTrigger,
  key: string,
) {
  const row = await transactCommand(
    deps.database,
    `router.evaluate:${workKey}:${actor.userId}:${key}`,
    (tx) => enqueueInTransaction(tx, deps, workKey, trigger, actor),
  )
  // Receipt hits skip the command callback. Authorize the current read while holding
  // Task before Work so reassignment cannot expose the former principal's proposal.
  return deps.database.transaction(async (tx) => {
    const { task } = await lockRouterContext(tx, workKey)
    await requireAssignee(tx, task, actor.userId)
    const current = await getEvaluation(tx, row.id)
    if (!current || current.principalUserId !== actor.userId)
      throw new ApiError(403, 'FORBIDDEN', 'evaluation belongs to another principal')
    return routerEvaluationView(current)
  })
}

function requestFor(row: CoordinationEvaluationRow): CoordinationRequest {
  if (
    !row.configSnapshot ||
    row.configVersion === null ||
    !row.workKey ||
    !row.taskId ||
    !row.principalUserId ||
    !row.evaluationDigest ||
    !row.leaseToken ||
    !row.leaseExpiresAt ||
    !row.deadlineAt ||
    !row.inputTokensEstimate
  )
    throw new Error('incomplete router evaluation binding')
  const cfg = row.configSnapshot
  return CoordinationRequestPayloadSchema.parse({
    evaluationId: row.id,
    attempt: row.attempt,
    leaseToken: row.leaseToken,
    evaluationDigest: row.evaluationDigest,
    projectId: row.projectId,
    workKey: row.workKey,
    taskId: row.taskId,
    principalUserId: row.principalUserId,
    billingUserId: cfg.billingUserId,
    provider: cfg.provider,
    model: cfg.model,
    credentialSlot: cfg.credentialSlot,
    credentialConfigRevision: cfg.credentialConfigRevision,
    configVersion: row.configVersion,
    manifest: row.inputManifest.entries,
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
function send(deviceId: string, type: NodeDownstream['type'], payload: unknown): void {
  nodeConnections.send(deviceId, {
    protocolVersion: 1,
    messageId: uuidv7(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  } as NodeDownstream)
}
async function rebuild(tx: Tx, deps: RouterDeps, row: CoordinationEvaluationRow) {
  if (!row.workKey || !row.routerContext)
    throw new ApiError(409, 'CONFLICT', 'missing evaluation context')
  await lockRouterContext(tx, row.workKey)
  const cfg = await getRouterConfig(tx, row.projectId)
  if (!cfg || cfg.configVersion !== row.configVersion)
    throw new ApiError(409, 'CONFLICT', 'configuration changed')
  const [device] = await tx
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, cfg.deviceId))
    .for('share')
  if (
    !device ||
    device.revokedAt !== null ||
    device.ownerUserId !== row.principalUserId ||
    !supportsConfiguration(device.capabilities, cfg)
  )
    throw new ApiError(409, 'CONFLICT', 'coordination device authority changed')
  const input = await loadRouterInput(
    tx,
    row.workKey,
    row.routerContext,
    cfg,
    nowOf(deps),
    deps.store,
  )
  if (input.evaluationDigest !== row.evaluationDigest || input.mandate.id !== row.mandateId)
    throw new ApiError(409, 'CONFLICT', 'evaluation input changed')
  return { cfg, input }
}

function supportsConfiguration(capabilities: unknown, cfg: RouterConfigRow): boolean {
  const caps = capabilities as
    | { coordinationCapabilities?: string[]; coordinationCredentialSlots?: unknown[] }
    | undefined
  return (
    caps?.coordinationCapabilities?.includes('coordination.v1') === true &&
    (caps.coordinationCredentialSlots ?? []).some((slot) => {
      const parsed = CoordinationCredentialSlotSchema.safeParse(slot)
      return (
        parsed.success &&
        parsed.data.provider === cfg.provider &&
        parsed.data.model === cfg.model &&
        parsed.data.slot === cfg.credentialSlot &&
        parsed.data.ownerUserId === cfg.operatorUserId &&
        parsed.data.billingUserId === cfg.billingUserId &&
        parsed.data.configRevision === cfg.credentialConfigRevision
      )
    })
  )
}

function bound(
  row: CoordinationEvaluationRow,
  deviceId: string,
  payload: { attempt: number; leaseToken: string },
) {
  return (
    row.purpose === 'router' &&
    row.deviceId === deviceId &&
    row.attempt === payload.attempt &&
    row.leaseToken === payload.leaseToken
  )
}
function live(row: CoordinationEvaluationRow, now: Date) {
  return (
    ['dispatched', 'running'].includes(row.status) &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > now &&
    row.deadlineAt !== null &&
    row.deadlineAt > now
  )
}

export async function downloadRouterInput(
  deps: RouterDeps,
  deviceId: string,
  evaluationId: string,
  entryId: string,
  attempt: number,
  leaseToken: string,
) {
  return deps.database.transaction(async (tx) => {
    const row = await getEvaluation(tx, evaluationId)
    if (!row || !bound(row, deviceId, { attempt, leaseToken }) || !live(row, nowOf(deps)))
      throw new ApiError(404, 'NOT_FOUND', 'evaluation input not available')
    const { input } = await rebuild(tx, deps, row)
    // Rebuild may have waited behind an authorization change or an expired lease.
    const current = await getEvaluationForUpdate(tx, evaluationId)
    if (
      !current ||
      !bound(current, deviceId, { attempt, leaseToken }) ||
      !live(current, nowOf(deps))
    )
      throw new ApiError(404, 'NOT_FOUND', 'evaluation input not available')
    const entry = input.manifest.find((e) => e.id === entryId)
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'input not in evaluation manifest')
    return {
      ...entry,
      bodyBase64: Buffer.from(input.bodies.get(entry.id) ?? '').toString('base64'),
    }
  })
}

export async function acceptRouterHeartbeat(
  deps: RouterDeps,
  deviceId: string,
  payload: CoordinationHeartbeat,
) {
  await deps.database.transaction(async (tx) => {
    const snapshot = await getEvaluation(tx, payload.evaluationId)
    if (!snapshot || !bound(snapshot, deviceId, payload) || !live(snapshot, nowOf(deps))) return
    await rebuild(tx, deps, snapshot)
    const row = await getEvaluationForUpdate(tx, snapshot.id)
    if (!row || !live(row, nowOf(deps))) return
    const manifest = CoordinationInputEntrySchema.array().parse(row.inputManifest.entries)
    if (
      new Set(payload.readEntryIds).size !== payload.readEntryIds.length ||
      payload.readEntryIds.some((id) => !manifest.some((e) => e.id === id)) ||
      (payload.modelStartedAt !== undefined &&
        manifest.some((e) => ![...row.readEntryIds, ...payload.readEntryIds].includes(e.id)))
    )
      throw new ApiError(409, 'CONFLICT', 'unknown router read receipt')
    await updateEvaluation(tx, row.id, {
      status: 'running',
      startedAt: row.startedAt ?? nowOf(deps),
      modelStartedAt: row.modelStartedAt ?? (payload.modelStartedAt ? nowOf(deps) : null),
      readEntryIds: [...new Set([...row.readEntryIds, ...payload.readEntryIds])],
      leaseExpiresAt: new Date(
        Math.min(nowOf(deps).getTime() + 120_000, row.deadlineAt?.getTime() ?? 0),
      ),
    })
  })
}

export async function acceptRouterResult(
  deps: RouterDeps,
  deviceId: string,
  payload: CoordinationResult,
): Promise<CoordinationResultAck> {
  const ack: CoordinationResultAck = {
    evaluationId: payload.evaluationId,
    attempt: payload.attempt,
    leaseToken: payload.leaseToken,
    status: 'rejected',
  }
  const result = await deps.database.transaction(async (tx) => {
    const snapshot = await getEvaluation(tx, payload.evaluationId)
    if (!snapshot || !bound(snapshot, deviceId, payload)) return undefined
    if (TERMINAL.has(snapshot.status)) {
      ack.status = snapshot.status === 'completed' ? 'duplicate' : 'late'
      return snapshot
    }
    let rejection: string | undefined
    let waitDeadlineAt: number | undefined
    try {
      const current = await rebuild(tx, deps, snapshot)
      waitDeadlineAt = Math.min(
        current.input.mandate.expiresAt.getTime(),
        nowOf(deps).getTime() + current.input.mandate.waitDeadlineSeconds * 1000,
      )
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      rejection = 'input_or_authority_changed'
    }
    const row = await getEvaluationForUpdate(tx, snapshot.id)
    if (!row || !bound(row, deviceId, payload)) return undefined
    if (TERMINAL.has(row.status)) {
      ack.status = row.status === 'completed' ? 'duplicate' : 'late'
      return row
    }
    if (!live(row, nowOf(deps))) rejection = 'lease_or_deadline_expired'
    if (payload.evaluationDigest !== row.evaluationDigest) rejection = 'evaluation_digest_mismatch'
    const cfg = row.configSnapshot
    const usage = payload.usage
    let usageValid = true
    let expectedCost: number | undefined
    try {
      if (usage && cfg) expectedCost = coordinationUsageCost({ ...usage, ...cfg })
      if (
        usage &&
        cfg &&
        (usage.provider !== cfg.provider ||
          usage.model !== cfg.model ||
          usage.inputTokens > (row.inputTokensEstimate ?? 0) ||
          usage.outputTokens > cfg.maxOutputTokens ||
          usage.inputTokens + usage.outputTokens > (row.reservedTokens ?? 0) ||
          usage.costMicros !== expectedCost ||
          usage.costMicros > (row.reservedCostMicros ?? 0))
      )
        usageValid = false
    } catch {
      usageValid = false
    }
    if (!usageValid) rejection = 'over_budget'
    if (payload.status === 'completed' && !usage) rejection = 'usage_missing'
    if (payload.status === 'completed' && row.modelStartedAt === null)
      rejection = 'model_start_missing'
    const manifest = CoordinationInputEntrySchema.array().parse(row.inputManifest.entries)
    if (payload.readEntryIds.some((id) => !row.readEntryIds.includes(id)))
      rejection = 'read_receipt_missing'
    if (payload.status === 'completed') {
      const proposal = RouterProposalSchema.parse(payload.proposal)
      const refs = [
        ...proposal.citations,
        ...proposal.coverage.flatMap((c) => [c.inputId, ...c.evidenceIds]),
      ]
      if (
        new Set(payload.readEntryIds).size !== payload.readEntryIds.length ||
        refs.some((id) => !row.readEntryIds.includes(id) || !manifest.some((e) => e.id === id)) ||
        proposal.coverage.some(
          (c) =>
            !manifest.some((e) => e.id === c.inputId && e.kind === 'source') ||
            c.evidenceIds.some((id) => !manifest.some((e) => e.id === id && e.kind === 'evidence')),
        )
      )
        rejection = 'invalid_citation'
      const sources = manifest.filter((e) => e.kind === 'source').map((e) => e.id)
      if (
        proposal.coverage.length !== sources.length ||
        new Set(proposal.coverage.map((c) => c.inputId)).size !== sources.length ||
        sources.some((id) => !proposal.coverage.some((c) => c.inputId === id))
      )
        rejection = 'coverage_missing'
      if (
        proposal.decision === 'dispatch' &&
        (proposal.workKey !== row.workKey ||
          proposal.coverage.some((c) => c.status === 'unknown') ||
          !proposal.coverage.some((c) => c.status === 'uncovered'))
      )
        rejection = 'unsupported_dispatch'
      if (proposal.decision === 'ignore' && proposal.coverage.some((c) => c.status === 'unknown'))
        rejection = 'unsupported_ignore'
      if (
        proposal.decision === 'wait' &&
        (new Date(proposal.deadlineAt) <= nowOf(deps) ||
          new Date(proposal.deadlineAt).getTime() > (waitDeadlineAt ?? 0))
      )
        rejection = 'invalid_wait_deadline'
      if (sha256Hex(canonicalJson(proposal)) !== payload.resultDigest)
        rejection = 'result_digest_mismatch'
    }
    const status = rejection ? 'stale' : payload.status === 'completed' ? 'completed' : 'failed'
    const updated = await updateEvaluation(tx, row.id, {
      status,
      finishedAt: nowOf(deps),
      failureCode: rejection ?? (payload.status === 'failed' ? payload.failureCode : null),
      // Invalid usage must not reduce a reservation; genuine reported overspend is still recorded.
      usage:
        usage &&
        cfg &&
        usage.provider === cfg.provider &&
        usage.model === cfg.model &&
        expectedCost !== undefined &&
        usage.costMicros >= expectedCost
          ? usage
          : null,
      preModelFailureConfirmed:
        !rejection &&
        payload.status === 'failed' &&
        row.modelStartedAt === null &&
        [
          'input_digest_mismatch',
          'input_too_large',
          'credential_unavailable',
          'source_unavailable',
        ].includes(payload.failureCode) &&
        (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.costMicros === 0)),
      routerProposal: !rejection && payload.status === 'completed' ? payload.proposal : null,
      resultDigest: !rejection && payload.status === 'completed' ? payload.resultDigest : null,
    })
    ack.status = status === 'completed' ? 'accepted' : 'rejected'
    return updated
  })
  if (result) {
    await settleRouterEvaluation(deps, result)
    event(deps, 'router.result', result, result.failureCode ?? undefined)
  }
  return ack
}

async function settleRouterEvaluation(deps: RouterDeps, row: CoordinationEvaluationRow) {
  if (!TERMINAL.has(row.status)) return
  const zeroCharge =
    row.preModelFailureConfirmed &&
    row.modelStartedAt === null &&
    [
      'input_digest_mismatch',
      'input_too_large',
      'credential_unavailable',
      'source_unavailable',
    ].includes(row.failureCode ?? '')
  const settled = await deps.database.transaction((tx) =>
    settleCoordinationUsage(tx, {
      evaluationId: row.id,
      attempt: row.attempt,
      ...(row.usage ? { usage: row.usage } : {}),
      zeroCharge,
    }),
  )
  if (settled)
    event(
      deps,
      'router.usage_settled',
      row,
      zeroCharge ? 'zero' : row.usage ? 'actual' : 'reserved',
    )
}

async function dispatchQueued(
  deps: RouterDeps,
  id: string,
): Promise<CoordinationEvaluationRow | undefined> {
  return deps.database.transaction(async (tx) => {
    const snapshot = await getEvaluation(tx, id)
    if (!snapshot || snapshot.status !== 'queued') return
    let current: Awaited<ReturnType<typeof rebuild>>
    try {
      current = await rebuild(tx, deps, snapshot)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const current = await getEvaluationForUpdate(tx, id)
      if (!current || current.status !== 'queued') return
      return updateEvaluation(tx, id, {
        status: 'cancelled',
        failureCode: 'input_or_authority_changed',
        finishedAt: nowOf(deps),
      })
    }
    // Rebuild holds the shared coordinator state lock across all model purposes.
    if (await hasRunningCoordinationEvaluation(tx, snapshot.projectId)) return
    const row = await getEvaluationForUpdate(tx, id)
    if (!row || row.status !== 'queued') return
    if (row.queueExpiresAt <= nowOf(deps))
      return updateEvaluation(tx, id, {
        status: 'skipped',
        failureCode: 'stale_queue',
        finishedAt: nowOf(deps),
      })
    const { cfg, input } = current
    const failedRouter = await countChargedRouterFailuresForWork(tx, input.work.workKey)
    const failedExecutor = await countFailedMachineRunsForWork(tx, input.work.workKey)
    if (failedRouter + failedExecutor >= input.mandate.maxAttempts || failedRouter > cfg.maxRetries)
      return updateEvaluation(tx, id, {
        status: 'skipped',
        failureCode: 'max_attempts_exhausted',
        finishedAt: nowOf(deps),
      })
    // Executor usage has no ledger yet. #520 must provide one before mixed spending
    // can be admitted; an unknown prior spend must never be treated as zero.
    if ((await countMachineRunsForWork(tx, input.work.workKey)) > 0)
      return updateEvaluation(tx, id, {
        status: 'skipped',
        failureCode: 'executor_usage_unavailable',
        finishedAt: nowOf(deps),
      })
    const [device] = await tx
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, cfg.deviceId))
    const capabilities = device?.capabilities as
      | { coordinationCapabilities?: string[]; coordinationCredentialSlots?: unknown[] }
      | undefined
    const slots = (capabilities?.coordinationCredentialSlots ?? []).map((s) =>
      CoordinationCredentialSlotSchema.safeParse(s),
    )
    if (
      !device ||
      device.revokedAt !== null ||
      device.ownerUserId !== input.task.assigneeUserId ||
      !nodeConnections.isOnline(device.id) ||
      !capabilities?.coordinationCapabilities?.includes('coordination.v1') ||
      !slots.some(
        (s) =>
          s.success &&
          s.data.provider === cfg.provider &&
          s.data.model === cfg.model &&
          s.data.slot === cfg.credentialSlot &&
          s.data.ownerUserId === cfg.operatorUserId &&
          s.data.billingUserId === cfg.billingUserId &&
          s.data.configRevision === cfg.credentialConfigRevision,
      )
    )
      return
    const reservedTokens = input.inputTokensEstimate + cfg.maxOutputTokens
    const reservedCostMicros = coordinationUsageCost({
      inputTokens: input.inputTokensEstimate,
      outputTokens: cfg.maxOutputTokens,
      ...cfg,
    })
    if (reservedCostMicros > cfg.maxCostMicros)
      return updateEvaluation(tx, id, {
        status: 'skipped',
        failureCode: 'budget_exhausted',
        finishedAt: nowOf(deps),
      })
    const reserved = await reserveCoordinationUsage(tx, {
      evaluationId: id,
      attempt: row.attempt,
      projectId: row.projectId,
      teamId: input.teamId,
      workKey: input.work.workKey,
      utcDate: nowOf(deps).toISOString().slice(0, 10),
      reservedTokens,
      reservedCostMicros,
      teamLimits: {
        calls: cfg.teamDailyCallLimit,
        tokens: cfg.teamDailyTokenLimit,
        costMicros: cfg.teamDailyCostMicrosLimit,
      },
      projectLimits: {
        calls: cfg.projectDailyCallLimit,
        tokens: cfg.projectDailyTokenLimit,
        costMicros: cfg.projectDailyCostMicrosLimit,
      },
      workLimits: {
        tokens: input.mandate.maxTokens,
        costMicros: input.mandate.maxCostMicros,
        maxAttempts: input.mandate.maxAttempts,
      },
      retry: row.attempt > 1,
      executorFailedAttempts: failedExecutor,
    })
    if (!reserved)
      return updateEvaluation(tx, id, {
        status: 'skipped',
        failureCode: 'budget_exhausted',
        finishedAt: nowOf(deps),
      })
    return updateEvaluation(tx, id, {
      status: 'dispatched',
      leaseToken: randomBytes(32).toString('hex'),
      leaseExpiresAt: new Date(nowOf(deps).getTime() + 120_000),
      deadlineAt: new Date(nowOf(deps).getTime() + cfg.timeoutSeconds * 1000),
      reservedTokens,
      reservedCostMicros,
    })
  })
}

/** Durable evaluation rows drive redelivery; the Node journal prevents a second model launch. */
export async function runRouterTick(deps: RouterDeps) {
  const calls = await deps.database.db
    .select({ call: schema.workEntryRouterCalls })
    .from(schema.workEntryRouterCalls)
    .innerJoin(
      schema.routerConfigurations,
      and(
        eq(schema.routerConfigurations.projectId, schema.workEntryRouterCalls.projectId),
        eq(schema.routerConfigurations.enabled, true),
        gte(schema.workEntryRouterCalls.createdAt, schema.routerConfigurations.createdAt),
      ),
    )
    .where(isNull(schema.workEntryRouterCalls.resolvedAt))
    .orderBy(asc(schema.workEntryRouterCalls.createdAt))
    .limit(20)
  for (const { call } of calls) {
    const cfg = await getRouterConfig(deps.database.db, call.projectId)
    if (!cfg?.enabled || call.createdAt < cfg.createdAt) continue
    try {
      await deps.database.transaction(async (tx) => {
        const { work } = await lockRouterContext(tx, call.workKey)
        const current = await loadWorkSource(tx, work, call.sourceType, call.sourceId)
        if (
          current.ignored ||
          current.sourceVersion !== call.sourceVersion ||
          current.sourceDigest !== call.sourceDigest ||
          current.authorizationGeneration !== call.authorizationGeneration
        ) {
          await tx
            .update(schema.workEntryRouterCalls)
            .set({ resolvedAt: nowOf(deps), resolutionReason: 'source_superseded' })
            .where(eq(schema.workEntryRouterCalls.id, call.id))
          return
        }
        const row = await enqueueInTransaction(tx, deps, call.workKey, {
          sourceType: call.sourceType,
          sourceId: call.sourceId,
          triggerKey: `entry:${call.id}`,
        })
        await tx
          .update(schema.workEntryRouterCalls)
          .set({
            evaluationId: row.id,
            resolvedAt: nowOf(deps),
            resolutionReason: 'evaluation_queued',
          })
          .where(eq(schema.workEntryRouterCalls.id, call.id))
      })
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      // The rejected trigger is auditable, and cannot indefinitely occupy the queue head.
      await deps.database.db
        .update(schema.workEntryRouterCalls)
        .set({ resolvedAt: nowOf(deps), resolutionReason: 'admission_rejected' })
        .where(
          and(
            eq(schema.workEntryRouterCalls.id, call.id),
            isNull(schema.workEntryRouterCalls.resolvedAt),
          ),
        )
    }
  }
  for (const queued of await listQueuedRouterEvaluations(deps.database.db)) {
    const row = await dispatchQueued(deps, queued.id)
    if (row) event(deps, 'router.evaluation', row, row.failureCode ?? undefined)
  }
  const active = await deps.database.db
    .select()
    .from(schema.coordinationEvaluations)
    .where(
      and(
        eq(schema.coordinationEvaluations.purpose, 'router'),
        inArray(schema.coordinationEvaluations.status, ['dispatched', 'running']),
      ),
    )
    .orderBy(asc(schema.coordinationEvaluations.id))
    .limit(100)
  for (const row of active) {
    let reason: string | undefined
    if (!live(row, nowOf(deps)))
      reason = row.deadlineAt && row.deadlineAt <= nowOf(deps) ? 'timeout' : 'node_lost'
    else
      try {
        await deps.database.transaction((tx) => rebuild(tx, deps, row))
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        reason = 'source_unavailable'
      }
    if (reason) {
      const ended = await deps.database.transaction(async (tx) => {
        const locked = await getEvaluationForUpdate(tx, row.id)
        if (!locked || !['dispatched', 'running'].includes(locked.status)) return
        return updateEvaluation(tx, row.id, {
          status: reason === 'source_unavailable' ? 'cancelled' : 'failed',
          failureCode: reason,
          finishedAt: nowOf(deps),
        })
      })
      if (ended) await settleRouterEvaluation(deps, ended)
      try {
        send(row.deviceId ?? '', 'coordination.cancel', {
          evaluationId: row.id,
          attempt: row.attempt,
          leaseToken: row.leaseToken,
          reason,
        })
      } catch {
        /* durable terminal state refuses late results */
      }
    } else if (row.status === 'dispatched') {
      try {
        send(row.deviceId ?? '', 'coordination.request', requestFor(row))
      } catch {
        /* retry until lease/deadline */
      }
    }
  }
  for (const ledger of await listUnsettledCoordinationUsage(deps.database.db)) {
    const row = await getEvaluation(deps.database.db, ledger.evaluationId)
    if (row) await settleRouterEvaluation(deps, row)
  }
}
