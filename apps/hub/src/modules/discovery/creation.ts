/**
 * ADR-0030 RD-04b：事实门 + 槽位门 + 一次预授权立项事务。
 *
 * 顺序固定为：Project 行锁 → 许可/槽位行 → 目录与核对 → 来源与核实 → 单事务物化。
 * 人工创建（task/commands.ts）使用同一把 Project 锁与同一张槽位占用表；两种入口
 * 谁先提交谁占用，后来者只看到占用，不会长出第二个 Task。
 *
 * 本切片只立项：不创建 Work Mandate、派工意图、Run 或 Executor 预留。派生约定
 * status='derived'，普通 resolver 只认 'confirmed'，因此不会被当成正式确认。
 */
import { eq } from 'drizzle-orm'
import {
  advanceDiscoveryCatalogGeneration,
  appendTeamEvent,
  countDiscoveryApplicationsForPermit,
  getActiveDiscoveryPermit,
  getCurrentSlotVerification,
  getCoordinatorStateForUpdate,
  getDiscoveryApplicationByEvaluation,
  getDiscoveryCandidateById,
  getDiscoveryCandidateForUpdate,
  getDiscoveryPermitForUpdate,
  getDiscoverySlot,
  getDiscoverySlotForUpdate,
  getDiscoverySlotOccupation,
  getEnabledMember,
  getEvaluation,
  getTask,
  getTaskForUpdate,
  getTaskMessage,
  getTeam,
  insertDerivedSpec,
  insertDiscoveryApplication,
  insertDiscoverySlotOccupation,
  insertDiscoverySourceBinding,
  insertTask,
  insertWork,
  listCandidatesAwaitingCreation,
  listCurrentDiscoveryReceipts,
  markCandidateCreation,
  schema,
  upsertDiscoverySlotVerification,
  type DiscoveryApplicationVerification,
  type DiscoveryPermitRow,
  type DiscoverySlotRow,
  type TaskMessageRow,
  type Tx,
} from '@whalepod/db'
import { TaskSpecContentSchema, type DiscoverySlotVerificationRequest } from '@whalepod/protocol'
import type { RouterDeps } from '../router/service.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { available, discoveryAdmission, discoveryConfig, templateFor } from './admission.js'
import { loadDiscoveryCatalog, renderDiscoveryTemplate } from './catalog.js'
import { loadDiscoveryInput } from './input.js'

type CreationDeps = RouterDeps

export interface ApplyOutcome {
  readonly status: 'applied' | 'already_applied' | 'skipped' | 'rejected'
  readonly reason?: string
  readonly applicationId?: string
  readonly taskId?: string
  readonly workId?: string
  readonly specRevisionId?: string
}

const nowOf = (deps: CreationDeps) => deps.now?.() ?? new Date()

function outcome(status: ApplyOutcome['status'], reason?: string): ApplyOutcome {
  return { status, ...(reason === undefined ? {} : { reason }) }
}

function rejectReason(
  reason: string,
  terminal: boolean,
): { value: ApplyOutcome; terminal: boolean } {
  return { value: outcome('rejected', reason), terminal }
}

async function lockProject(tx: Tx, projectId: string) {
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .for('update')
  return project
}

function taskChangedPayload(task: {
  readonly id: string
  readonly projectId: string
  readonly status: string
  readonly assignmentStatus: string
  readonly assigneeUserId: string
  readonly assigneeAgentId: string | null
  readonly approvalPolicy: string | null
  readonly agreementEnabled: boolean
}) {
  return {
    taskId: task.id,
    projectId: task.projectId,
    status: task.status,
    assignmentStatus: task.assignmentStatus,
    assigneeUserId: task.assigneeUserId,
    assigneeAgentId: task.assigneeAgentId,
    approvalPolicy: task.approvalPolicy,
    agreementEnabled: task.agreementEnabled,
  }
}

function ensurePermit(
  permit: DiscoveryPermitRow,
  slot: DiscoverySlotRow,
  now: Date,
): string | null {
  if (permit.revokedAt !== null) return 'permit_revoked'
  if (permit.expiresAt.getTime() <= now.getTime()) return 'permit_expired'
  if (permit.tier === 'discover') return 'tier_disabled'
  if (permit.slotId !== slot.id) return 'slot_changed'
  return null
}

/** 独立核实：发布佐证或专门回执，且核实人不是来源作者。 */
async function factVerification(
  tx: Tx,
  input: Awaited<ReturnType<typeof loadDiscoveryInput>>,
  permit: DiscoveryPermitRow,
  source: TaskMessageRow,
  proposal: { readonly source: string; readonly citations: readonly string[] },
): Promise<DiscoveryApplicationVerification | string> {
  const team = await getTeam(tx)
  if (!team) return 'verifier_ineligible'
  const authorId = source.authorUserId
  const verifierIds = new Set(permit.verifierUserIds.filter((id) => id !== authorId))
  if (verifierIds.size === 0) return 'verifier_ineligible'
  const eligible = new Set<string>()
  for (const verifier of verifierIds) {
    if (await getEnabledMember(tx, team.id, verifier)) eligible.add(verifier)
  }
  if (eligible.size === 0) return 'verifier_ineligible'

  const evidence: { artifactId: string; sha256: string; verifierUserId: string }[] = []
  for (const citation of proposal.citations) {
    const entry = input.manifest.find((candidate) => candidate.id === citation)
    if (entry?.kind !== 'evidence') continue
    const [artifact] = await tx
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, entry.sourceId))
    if (
      !artifact ||
      artifact.status !== 'published' ||
      artifact.publishedAt === null ||
      artifact.ownerUserId === authorId ||
      !eligible.has(artifact.ownerUserId) ||
      artifact.sha256 !== entry.version ||
      artifact.sha256 !== entry.digest
    )
      continue
    const task = await getTask(tx, artifact.taskId)
    if (!task || task.projectId !== permit.projectId) continue
    evidence.push({
      artifactId: artifact.id,
      sha256: artifact.sha256,
      verifierUserId: artifact.ownerUserId,
    })
  }

  const receipts = await listCurrentDiscoveryReceipts(tx, {
    sourceId: source.id,
    slotId: permit.slotId,
    permitId: permit.id,
  })
  const validReceipts = receipts.filter(
    (receipt) =>
      receipt.verifierUserId !== authorId &&
      eligible.has(receipt.verifierUserId) &&
      receipt.sourceVersion === input.admission.sourceVersion &&
      receipt.sourceDigest === input.admission.sourceDigest,
  )
  if (evidence.length === 0 && validReceipts.length === 0) return 'independent_support_missing'
  const verifierUserIds = [
    ...new Set([
      ...evidence.map((item) => item.verifierUserId),
      ...validReceipts.map((receipt) => receipt.verifierUserId),
    ]),
  ]
  return {
    kind:
      evidence.length > 0 && validReceipts.length > 0
        ? 'mixed'
        : evidence.length > 0
          ? 'published_evidence'
          : 'receipt',
    evidence,
    receiptIds: validReceipts.map((receipt) => receipt.id),
    verifierUserIds,
  }
}

export interface SlotVerificationView {
  readonly slotId: string
  readonly generation: number
  readonly catalogDigest: string
  readonly verifiedAt: string
  readonly eligibleEmpty: boolean
  readonly coveredCount: number
}

export async function verifyDiscoverySlot(
  deps: CreationDeps,
  actorUserId: string,
  projectId: string,
  slotId: string,
  input: DiscoverySlotVerificationRequest,
): Promise<SlotVerificationView> {
  return deps.database.transaction(async (tx) => {
    const project = await lockProject(tx, projectId)
    if (!project || project.archivedAt !== null)
      throw new ApiError(404, 'NOT_FOUND', 'discovery project not found')
    const now = nowOf(deps)
    const cfg = await discoveryConfig(tx, projectId)
    if (!available(cfg, now)) throw new ApiError(404, 'NOT_FOUND', 'discovery is not active')
    const activePermit = await getActiveDiscoveryPermit(tx, projectId, actorUserId, cfg.version)
    const permit = activePermit ? await getDiscoveryPermitForUpdate(tx, activePermit.id) : undefined
    if (!permit || permit.principalUserId !== actorUserId || permit.revokedAt !== null)
      throw new ApiError(403, 'FORBIDDEN', 'only the named slot principal can verify the catalog')
    const team = await getTeam(tx)
    if (!team || !(await getEnabledMember(tx, team.id, actorUserId)))
      throw new ApiError(403, 'FORBIDDEN', 'the slot principal is not an active member')
    const slot = await getDiscoverySlotForUpdate(tx, slotId)
    if (!slot || slot.projectId !== projectId || permit.slotId !== slot.id)
      throw new ApiError(404, 'NOT_FOUND', 'discovery slot not found')
    if (permit.tier === 'discover')
      throw new ApiError(409, 'CONFLICT', 'the permit does not allow task creation')
    if (now.getTime() >= permit.expiresAt.getTime())
      throw new ApiError(409, 'CONFLICT', 'the permit has expired')
    const catalog = await loadDiscoveryCatalog(tx, projectId)
    if (!catalog.complete)
      throw new ApiError(
        409,
        'CONFLICT',
        'the task catalog is truncated; verify in a smaller project',
      )
    if (catalog.digest !== input.catalogDigest)
      throw new ApiError(409, 'CONFLICT', 'the task catalog changed; refresh before verifying')
    const expected = new Set(catalog.entries.map((entry) => entry.taskId))
    if (
      input.entries.length !== expected.size ||
      new Set(input.entries.map((entry) => entry.taskId)).size !== input.entries.length ||
      input.entries.some((entry) => !expected.has(entry.taskId))
    )
      throw new ApiError(
        409,
        'CONFLICT',
        'every current project task must be classified exactly once',
      )
    const coveredCount = input.entries.filter((entry) => entry.coverage === 'covered').length
    const row = await upsertDiscoverySlotVerification(tx, {
      id: uuidv7(now.getTime()),
      slotId: slot.id,
      projectId,
      generation: slot.generation,
      catalogDigest: catalog.digest,
      entries: input.entries.map((entry) => ({
        taskId: entry.taskId,
        coverage: entry.coverage,
      })),
      verifiedBy: actorUserId,
      permitId: permit.id,
      permitVersion: permit.version,
      verifiedAt: now,
    })
    return {
      slotId: slot.id,
      generation: row.generation,
      catalogDigest: row.catalogDigest,
      verifiedAt: row.verifiedAt.toISOString(),
      eligibleEmpty: coveredCount === 0,
      coveredCount,
    }
  })
}

export interface SlotView {
  readonly slotId: string
  readonly activity: string
  readonly slot: string
  readonly generation: number
  readonly catalog: {
    readonly digest: string
    readonly complete: boolean
    readonly entries: readonly {
      readonly taskId: string
      readonly status: string
      readonly assignmentStatus: string
      readonly workState: string | null
      readonly publishedArtifactCount: number
    }[]
  }
  readonly permit: {
    readonly id: string
    readonly tier: string
    readonly version: number
    readonly expiresAt: string
    readonly templateDigest: string
  } | null
  readonly verification: {
    readonly id: string
    readonly generation: number
    readonly verifiedBy: string
    readonly verifiedAt: string
    readonly current: boolean
    readonly eligibleEmpty: boolean
    readonly coveredCount: number
  } | null
  readonly occupation: {
    readonly taskId: string
    readonly workId: string | null
    readonly source: string
    readonly createdAt: string
  } | null
}

export async function getDiscoverySlotView(
  deps: CreationDeps,
  actorUserId: string,
  projectId: string,
  slotId: string,
): Promise<SlotView> {
  return deps.database.transaction(async (tx) => {
    const slot = await getDiscoverySlot(tx, slotId)
    if (!slot || slot.projectId !== projectId)
      throw new ApiError(404, 'NOT_FOUND', 'discovery slot not found')
    const cfg = await discoveryConfig(tx, projectId)
    const permit = cfg
      ? await getActiveDiscoveryPermit(tx, projectId, cfg.settings.principalUserId, cfg.version)
      : undefined
    const catalog = await loadDiscoveryCatalog(tx, projectId)
    const verification = await getCurrentSlotVerification(tx, slot.id)
    const occupation = await getDiscoverySlotOccupation(tx, slot.id)
    const current =
      verification !== undefined &&
      verification.generation === slot.generation &&
      verification.catalogDigest === catalog.digest
    return {
      slotId: slot.id,
      activity: slot.activity,
      slot: slot.slot,
      generation: slot.generation,
      catalog: {
        digest: catalog.digest,
        complete: catalog.complete,
        entries: catalog.entries.map((entry) => ({
          taskId: entry.taskId,
          status: entry.status,
          assignmentStatus: entry.assignmentStatus,
          workState: entry.workState,
          publishedArtifactCount: entry.publishedArtifacts.length,
        })),
      },
      permit:
        permit && permit.principalUserId === actorUserId
          ? {
              id: permit.id,
              tier: permit.tier,
              version: permit.version,
              expiresAt: permit.expiresAt.toISOString(),
              templateDigest: permit.templateDigest,
            }
          : null,
      verification:
        verification === undefined
          ? null
          : {
              id: verification.id,
              generation: verification.generation,
              verifiedBy: verification.verifiedBy,
              verifiedAt: verification.verifiedAt.toISOString(),
              current,
              eligibleEmpty:
                current &&
                occupation === undefined &&
                verification.entries.every((entry) => entry.coverage === 'not_covered'),
              coveredCount: verification.entries.filter((entry) => entry.coverage === 'covered')
                .length,
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

/**
 * 幂等应用一个候选。Project 行锁与人工 createTask 共用；任何预期失败都只记录在
 * 候选的 creation_* 水位上，不留下半份 Task/约定/Work。
 */
export async function applyDiscoveryCandidate(
  deps: CreationDeps,
  candidateId: string,
): Promise<ApplyOutcome> {
  let audit: Record<string, unknown> | undefined
  const result = await deps.database.transaction(async (tx) => {
    let candidate = await getDiscoveryCandidateById(tx, candidateId)
    if (!candidate) return outcome('skipped', 'candidate_missing')
    const project = await lockProject(tx, candidate.projectId)
    const now = nowOf(deps)
    if (!project || project.archivedAt !== null)
      return markAndReturn(tx, candidate.id, rejectReason('project_archived', true), now)
    // Lock order matches comment admission / configure: entry Task → coordinator → discovery rows.
    // Project is already held (same as createTask), so manual and automatic creation serialize here.
    const admission = await discoveryAdmission(tx, candidate.sourceId)
    if (!admission)
      return markAndReturn(tx, candidate.id, rejectReason('source_missing', true), now)
    const entryTask = await getTaskForUpdate(tx, admission.entryTaskId)
    if (!entryTask)
      return markAndReturn(tx, candidate.id, rejectReason('source_missing', true), now)
    await getCoordinatorStateForUpdate(tx, candidate.projectId)
    // Re-read under lock: revoke/correction/cleanup may have deleted the row while we queued.
    candidate = await getDiscoveryCandidateForUpdate(tx, candidateId)
    if (!candidate) return outcome('skipped', 'candidate_missing')
    const existing = await getDiscoveryApplicationByEvaluation(tx, candidate.evaluationId)
    if (existing)
      return {
        status: 'already_applied' as const,
        applicationId: existing.id,
        taskId: existing.taskId,
        workId: existing.workId,
        specRevisionId: existing.specRevisionId,
      }
    if (candidate.expiresAt.getTime() <= now.getTime())
      return markAndReturn(tx, candidate.id, rejectReason('candidate_expired', true), now)
    const evaluation = await getEvaluation(tx, candidate.evaluationId)
    if (!evaluation || evaluation.status !== 'completed')
      return markAndReturn(tx, candidate.id, rejectReason('evaluation_incomplete', false), now)
    if (evaluation.purpose !== 'discovery')
      return markAndReturn(tx, candidate.id, rejectReason('evaluation_purpose', true), now)
    if (candidate.proposal.classification !== 'independent_gap')
      return markAndReturn(tx, candidate.id, rejectReason('not_independent_gap', true), now)

    const cfg = await discoveryConfig(tx, candidate.projectId)
    if (!available(cfg, now))
      return markAndReturn(tx, candidate.id, rejectReason('discovery_disabled', true), now)
    if (cfg.version !== evaluation.configVersion)
      return markAndReturn(tx, candidate.id, rejectReason('config_changed', true), now)
    if (cfg.settings.principalUserId !== candidate.principalUserId)
      return markAndReturn(tx, candidate.id, rejectReason('principal_changed', true), now)
    const activePermit = await getActiveDiscoveryPermit(
      tx,
      candidate.projectId,
      candidate.principalUserId,
      cfg.version,
    )
    // Serialize with revoke/re-confirm: a permit revoked after the read must not authorize a task.
    const permit = activePermit ? await getDiscoveryPermitForUpdate(tx, activePermit.id) : undefined
    if (!permit) return markAndReturn(tx, candidate.id, rejectReason('permit_inactive', true), now)
    const slot = await getDiscoverySlotForUpdate(tx, permit.slotId)
    if (!slot || slot.projectId !== candidate.projectId)
      return markAndReturn(tx, candidate.id, rejectReason('slot_missing', true), now)
    const permitProblem = ensurePermit(permit, slot, now)
    if (permitProblem)
      return markAndReturn(tx, candidate.id, rejectReason(permitProblem, true), now)
    if (slot.activity !== cfg.settings.activity || slot.slot !== cfg.settings.slot)
      return markAndReturn(tx, candidate.id, rejectReason('slot_changed', true), now)
    if (await getDiscoverySlotOccupation(tx, slot.id))
      return markAndReturn(tx, candidate.id, rejectReason('slot_occupied', true), now)
    if ((await countDiscoveryApplicationsForPermit(tx, permit.id)) >= permit.maxCreations)
      return markAndReturn(tx, candidate.id, rejectReason('creation_quota_exhausted', true), now)

    const catalog = await loadDiscoveryCatalog(tx, candidate.projectId)
    if (!catalog.complete)
      return markAndReturn(tx, candidate.id, rejectReason('catalog_incomplete', false), now)
    const verification = await getCurrentSlotVerification(tx, slot.id)
    if (
      !verification ||
      verification.generation !== slot.generation ||
      verification.permitId !== permit.id ||
      verification.catalogDigest !== catalog.digest
    )
      return markAndReturn(tx, candidate.id, rejectReason('slot_unverified', false), now)
    if (verification.entries.some((entry) => entry.coverage === 'covered'))
      return markAndReturn(tx, candidate.id, rejectReason('slot_covered', true), now)

    let input: Awaited<ReturnType<typeof loadDiscoveryInput>>
    try {
      input = await loadDiscoveryInput(tx, candidate.sourceId, now, deps.store)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      return markAndReturn(tx, candidate.id, rejectReason('source_or_authority_changed', true), now)
    }
    if (
      input.evaluationDigest !== evaluation.evaluationDigest ||
      input.admission.sourceVersion !== candidate.sourceVersion
    )
      return markAndReturn(tx, candidate.id, rejectReason('stale_evaluation', true), now)
    const sourceEntry = input.manifest.find((entry) => entry.kind === 'source')
    const slotEntry = input.manifest.find((entry) => entry.kind === 'slot')
    if (
      !sourceEntry ||
      sourceEntry.id !== candidate.proposal.source ||
      !slotEntry ||
      slotEntry.id !== candidate.proposal.slot
    )
      return markAndReturn(tx, candidate.id, rejectReason('invalid_citation', true), now)

    const source = await getTaskMessage(tx, candidate.sourceId)
    if (!source) return markAndReturn(tx, candidate.id, rejectReason('source_missing', true), now)
    const fact = await factVerification(tx, input, permit, source, candidate.proposal)
    if (typeof fact === 'string')
      return markAndReturn(tx, candidate.id, rejectReason(fact, true), now)

    const template = templateFor(cfg.settings)
    const render = (text: string) =>
      renderDiscoveryTemplate(text, {
        activity: slot.activity,
        slot: slot.slot,
        sourceId: candidate.sourceId,
        sourceVersion: input.admission.sourceVersion,
      })
    const content = TaskSpecContentSchema.parse({
      goal: render(template.goal),
      constraints: render(template.constraints),
      acceptance: render(template.acceptance),
      openQuestions: render(template.openQuestions),
    })
    if (content.goal.trim() === '' || content.acceptance.trim() === '')
      return markAndReturn(tx, candidate.id, rejectReason('template_invalid', true), now)

    const taskId = uuidv7(now.getTime())
    const specRevisionId = uuidv7(now.getTime())
    const workId = uuidv7(now.getTime())
    const workKey = uuidv7(now.getTime())
    const applicationId = uuidv7(now.getTime())
    const task = await insertTask(tx, {
      id: taskId,
      projectId: candidate.projectId,
      title: `${slot.activity} · ${slot.slot}`.slice(0, 200),
      description: content.goal.slice(0, 20000),
      assigneeUserId: permit.principalUserId,
      assignmentStatus: 'accepted',
      acceptedAt: permit.confirmedAt,
      createdBy: permit.principalUserId,
      agreementEnabled: true,
    })
    await insertDerivedSpec(tx, {
      id: specRevisionId,
      taskId,
      content,
      createdBy: permit.principalUserId,
      createdAt: now,
    })
    const work = await insertWork(tx, {
      id: workId,
      projectId: candidate.projectId,
      taskId,
      workKey,
      humanOwnerUserId: permit.principalUserId,
      goal: content.goal.slice(0, 1000),
      state: 'active',
      createdAt: now,
      updatedAt: now,
    })
    const application = await insertDiscoveryApplication(tx, {
      id: applicationId,
      candidateId: candidate.id,
      evaluationId: candidate.evaluationId,
      projectId: candidate.projectId,
      slotId: slot.id,
      permitId: permit.id,
      permitVersion: permit.version,
      sourceId: candidate.sourceId,
      sourceVersion: input.admission.sourceVersion,
      sourceDigest: input.admission.sourceDigest,
      verification: fact,
      taskId,
      workId,
      specRevisionId,
      status: 'applied',
      reason: null,
      appliedAt: now,
    })
    await insertDiscoverySlotOccupation(tx, {
      id: uuidv7(now.getTime()),
      projectId: candidate.projectId,
      slotId: slot.id,
      taskId,
      workId,
      applicationId,
      source: 'auto',
      createdAt: now,
    })
    await insertDiscoverySourceBinding(tx, {
      id: uuidv7(now.getTime()),
      applicationId,
      projectId: candidate.projectId,
      workId,
      taskId,
      slotId: slot.id,
      sourceId: candidate.sourceId,
      sourceVersion: input.admission.sourceVersion,
      sourceDigest: input.admission.sourceDigest,
      verification: fact,
      createdAt: now,
    })
    await appendTeamEvent(tx, {
      type: 'task.changed',
      payload: taskChangedPayload(task),
    })
    await advanceDiscoveryCatalogGeneration(tx, candidate.projectId, now)
    await markCandidateCreation(tx, {
      id: candidate.id,
      reason: 'applied',
      terminal: true,
      now,
    })
    audit = {
      component: 'hub.discovery',
      action: 'discovery.application',
      projectId: candidate.projectId,
      evaluationId: candidate.evaluationId,
      candidateId: candidate.id,
      slotId: slot.id,
      taskId,
      workId,
      applicationId,
      status: 'applied',
    }
    return {
      status: 'applied' as const,
      applicationId: application.id,
      taskId: task.id,
      workId: work.id,
      specRevisionId,
    }
  })
  // Only a committed application may leave an "applied" audit line.
  if (audit !== undefined) deps.log?.(audit)
  return result
}

async function markAndReturn(
  tx: Tx,
  candidateId: string,
  decision: { value: ApplyOutcome; terminal: boolean },
  now: Date,
): Promise<ApplyOutcome> {
  await markCandidateCreation(tx, {
    id: candidateId,
    reason: decision.value.reason ?? 'rejected',
    terminal: decision.terminal,
    now,
  })
  return decision.value
}

/** Tick 补偿：候选已落库但进程在应用前退出时，按同一幂等事务重试。 */
export async function applyPendingDiscoveryCandidates(deps: CreationDeps, limit = 10) {
  const now = nowOf(deps)
  const retryBefore = new Date(now.getTime() - 60_000)
  const candidates = await listCandidatesAwaitingCreation(deps.database.db, now, retryBefore, limit)
  const results: ApplyOutcome[] = []
  for (const candidate of candidates) {
    results.push(await applyDiscoveryCandidate(deps, candidate.id))
  }
  return results
}

export { taskChangedPayload }
