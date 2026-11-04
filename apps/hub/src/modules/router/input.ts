import { and, asc, desc, eq } from 'drizzle-orm'
import {
  getCoordinatorState,
  getCoordinatorStateForUpdate,
  getTaskForUpdate,
  getWorkByKey,
  getWorkByKeyForUpdate,
  getEnabledMember,
  getLatestConfirmedSpec,
  getLatestWorkMandate,
  getTeam,
  schema,
  type Tx,
} from '@whalepod/db'
import type {
  ConfigureProjectRouterRequest,
  CoordinationInputEntry,
  WorkSourceType,
} from '@whalepod/protocol'
import { coordinationInputTokenEstimate } from '@whalepod/protocol'
import type { ArtifactStore } from '../artifact/store.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { loadWorkSource, effectiveMandate } from '../work/admission.js'
import { ApiError } from '../shared/http-error.js'

export const ROUTER_RULES_VERSION = 'rd03r1.v1'
export const ROUTER_PROMPT_VERSION = 'router.v1'
export interface RouterTrigger {
  sourceType: WorkSourceType
  sourceId: string
  triggerKey: string
}
export type RouterConfiguration = ConfigureProjectRouterRequest & { configVersion: number }
export interface RouterInput {
  manifest: CoordinationInputEntry[]
  bodies: Map<string, string>
  evaluationDigest: string
  inputTokensEstimate: number
  work: typeof schema.works.$inferSelect
  task: typeof schema.tasks.$inferSelect
  mandate: typeof schema.workMandates.$inferSelect
  teamId: string
}

/** Task facts use Task→state; standalone corrections use entry→state→Work. */
export async function lockRouterContext(tx: Tx, workKey: string) {
  const snapshot = await getWorkByKey(tx, workKey)
  if (!snapshot) throw new ApiError(404, 'NOT_FOUND', 'work not found')
  const task = await getTaskForUpdate(tx, snapshot.taskId)
  if (!task) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  await getCoordinatorStateForUpdate(tx, snapshot.projectId)
  const work = await getWorkByKeyForUpdate(tx, workKey)
  if (!work || work.taskId !== task.id) throw new ApiError(409, 'CONFLICT', 'work binding changed')
  return { work, task }
}

function entryId(kind: string, identity: string): string {
  const h = sha256Hex(`${kind}:${identity}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Rebuilt for every download and result: current read authority, never a frozen authorization. */
export async function loadRouterInput(
  tx: Tx,
  workKey: string,
  trigger: RouterTrigger,
  config: RouterConfiguration,
  now: Date,
  store?: ArtifactStore,
): Promise<RouterInput> {
  const { work, task } = await lockRouterContext(tx, workKey)
  const team = await getTeam(tx)
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, work.projectId))
    .for('share')
  const active = effectiveMandate(await getLatestWorkMandate(tx, work.id), now).active
  const state = await getCoordinatorState(tx, work.projectId)
  if (
    !config.enabled ||
    !state?.enabled ||
    state.pausedAt !== null ||
    team === undefined ||
    project === undefined ||
    project.archivedAt !== null ||
    work.state === 'retired' ||
    work.resumeMode === 'owner_confirmation' ||
    work.humanOwnerUserId !== task.assigneeUserId ||
    task.assignmentStatus !== 'accepted' ||
    task.status === 'done' ||
    task.status === 'cancelled' ||
    active === undefined ||
    work.mandateId !== active.id ||
    active.principalUserId !== task.assigneeUserId ||
    active.onBehalfOfUserId !== task.assigneeUserId ||
    active.humanOwnerUserId !== task.assigneeUserId ||
    !(await getEnabledMember(tx, team.id, task.assigneeUserId)) ||
    !active.allowedSourceTypes.includes(trigger.sourceType)
  ) {
    throw new ApiError(409, 'CONFLICT', 'router authority is not current')
  }
  const source = await loadWorkSource(tx, work, trigger.sourceType, trigger.sourceId)
  if (source.ignored !== undefined) throw new ApiError(409, 'CONFLICT', 'router source unavailable')
  const manifest: CoordinationInputEntry[] = []
  const bodies = new Map<string, string>()
  const omitted: Record<string, unknown>[] = []
  const add = (
    kind: CoordinationInputEntry['kind'],
    identity: string,
    version: string,
    body: string,
    authorizationGeneration: string,
  ): void => {
    const id = entryId(kind, identity)
    if (bodies.has(id)) return
    const byteSize = Buffer.byteLength(body)
    if (
      manifest.length >= 31 ||
      byteSize > 65_536 ||
      manifest.reduce((n, e) => n + e.byteSize, 0) + byteSize > 196_608
    ) {
      omitted.push({
        kind,
        sourceId: identity,
        version,
        digest: sha256Hex(body),
        reason: 'input_limit',
      })
      return
    }
    bodies.set(id, body)
    manifest.push({
      id,
      kind,
      sourceId: identity,
      version,
      digest: sha256Hex(body),
      byteSize,
      authorizationGeneration,
    })
  }
  add(
    'source',
    `${source.sourceType}:${source.sourceId}`,
    source.sourceVersion,
    source.body,
    source.authorizationGeneration,
  )
  // A too-large triggering source cannot quietly disappear from an otherwise accepted evaluation.
  if (manifest.length === 0) throw new ApiError(409, 'CONFLICT', 'router input exceeds limits')
  const spec = await getLatestConfirmedSpec(tx, task.id)
  add(
    'agreement',
    task.id,
    spec?.id ?? 'missing',
    canonicalJson({ revisionId: spec?.id ?? null, content: spec?.content ?? null }),
    `mandate:${active.version}`,
  )

  const inbox = await tx
    .select()
    .from(schema.workInboxItems)
    .where(eq(schema.workInboxItems.workId, work.id))
    .orderBy(asc(schema.workInboxItems.id))
  for (const item of inbox) {
    if (!['pending', 'returned', 'unconfirmed'].includes(item.status)) continue
    if (!active.allowedSourceTypes.includes(item.sourceType)) continue
    const current = await loadWorkSource(tx, work, item.sourceType, item.sourceId)
    if (current.ignored !== undefined) {
      omitted.push({
        kind: 'source',
        sourceId: item.sourceId,
        version: item.sourceVersion,
        reason: 'source_unavailable',
      })
      continue
    }
    add(
      'source',
      `${current.sourceType}:${current.sourceId}`,
      current.sourceVersion,
      current.body,
      current.authorizationGeneration,
    )
  }
  if (omitted.some((entry) => entry.kind === 'source' || entry.kind === 'agreement'))
    throw new ApiError(409, 'CONFLICT', 'required router input is unavailable or exceeds limits')
  // Metadata only: consumption is evidence of reading, never evidence of fulfilled requirements.
  add(
    'consumption',
    work.workKey,
    'current',
    canonicalJson(
      inbox.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        version: item.sourceVersion,
        digest: item.sourceDigest,
        status: item.status,
        runId: item.deliveryRunId,
        consumedAt: item.consumedAt?.toISOString() ?? null,
        updatedAt: item.updatedAt.toISOString(),
      })),
    ),
    `mandate:${active.version}`,
  )
  const answers = await tx
    .select()
    .from(schema.workQuestionAnswers)
    .innerJoin(
      schema.workQuestions,
      eq(schema.workQuestions.id, schema.workQuestionAnswers.questionId),
    )
    .where(
      and(
        eq(schema.workQuestions.workId, work.id),
        eq(schema.workQuestionAnswers.binding, true),
        eq(schema.workQuestions.principalUserId, task.assigneeUserId),
        eq(schema.workQuestions.mandateId, active.id),
        eq(schema.workQuestionAnswers.mandateId, active.id),
      ),
    )
    .orderBy(asc(schema.workQuestionAnswers.id))
  add(
    'answer',
    work.workKey,
    'current',
    canonicalJson(
      answers.map((row) => ({
        id: row.work_question_answer.id,
        decisionId: row.work_question.decisionId,
        mandateId: row.work_question.mandateId,
        mandateVersion: row.work_question.mandateVersion,
        principalUserId: row.work_question.principalUserId,
        answerType: row.work_question_answer.answerType,
        optionId: row.work_question_answer.optionId,
        createdAt: row.work_question_answer.createdAt.toISOString(),
      })),
    ),
    `mandate:${active.version}`,
  )

  const artifacts = await tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.taskId, task.id), eq(schema.artifacts.status, 'published')))
    .orderBy(desc(schema.artifacts.publishedAt), asc(schema.artifacts.id))
  for (const artifact of artifacts) {
    if (
      store === undefined ||
      artifact.byteSize > 65_536 ||
      !/^(text\/|application\/(json|xml)(;|$))/.test(artifact.mediaType) ||
      manifest.filter((e) => e.kind === 'evidence').length >= 8
    ) {
      omitted.push({
        sourceId: artifact.id,
        version: artifact.sha256,
        reason: 'evidence_not_readable',
      })
      continue
    }
    let bytes: Buffer
    let body: string
    try {
      bytes = await store.readVerified(artifact.storageKey, artifact.sha256)
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      omitted.push({
        sourceId: artifact.id,
        version: artifact.sha256,
        reason: 'evidence_not_readable',
      })
      continue
    }
    if (bytes.byteLength !== artifact.byteSize)
      throw new ApiError(409, 'CONFLICT', 'evidence size mismatch')
    add(
      'evidence',
      artifact.id,
      artifact.sha256,
      body,
      `published:${artifact.publishedAt?.toISOString()}`,
    )
  }
  // The bounded manifest explicitly identifies omissions; private candidates are never enumerated.
  add(
    'work',
    work.workKey,
    String(active.version),
    canonicalJson({
      goal: work.goal,
      taskId: task.id,
      taskStatus: task.status,
      assignmentStatus: task.assignmentStatus,
      approvalPolicy: task.approvalPolicy,
      workState: work.state,
      resumeMode: work.resumeMode,
      mandate: {
        id: active.id,
        version: active.version,
        allowedActionClasses: active.allowedActionClasses,
        allowedSourceTypes: active.allowedSourceTypes,
        allowedAgentIds: active.allowedAgentIds,
        allowedToolNames: active.allowedToolNames,
        autoDispatch: active.autoDispatch,
        expiresAt: active.expiresAt.toISOString(),
        waitDeadlineSeconds: active.waitDeadlineSeconds,
      },
      omitted,
    }),
    `mandate:${active.version}`,
  )
  if (!manifest.some((entry) => entry.kind === 'work'))
    throw new ApiError(409, 'CONFLICT', 'router input too large')
  manifest.sort((a, b) => a.id.localeCompare(b.id))
  const evaluationDigest = sha256Hex(
    canonicalJson({
      purpose: 'router',
      projectId: work.projectId,
      workKey,
      taskId: task.id,
      principalUserId: task.assigneeUserId,
      mandateId: active.id,
      mandateVersion: active.version,
      manifest,
      config,
      trigger,
      rulesVersion: ROUTER_RULES_VERSION,
      promptVersion: ROUTER_PROMPT_VERSION,
    }),
  )
  const inputTokensEstimate = coordinationInputTokenEstimate(manifest)
  if (inputTokensEstimate > config.maxInputTokens)
    throw new ApiError(409, 'CONFLICT', 'router input token limit exceeded')
  return {
    manifest,
    bodies,
    evaluationDigest,
    inputTokensEstimate,
    work,
    task,
    mandate: active,
    teamId: team.id,
  }
}
