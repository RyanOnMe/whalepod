/**
 * ADR-0028 §17（RD-03r2）：已接受 Router 提案的 Hub 应用端口。
 *
 * 第一次裁决（结果接受）由 router/service.ts 完成；本模块承担第二次裁决：
 * 用 evaluationId 做幂等凭据，在 Task→Work 锁序下按当前事实重建评估输入，
 * 复核 Current 责任人/Mandate/约定/来源/成果/消费/回答水位与配置版本，再把
 * dispatch/wait/ask/ignore 写成已有的意图、问题、wait 或仅留决定记录。
 *
 * 模型输出不是执行权限：dispatch 只生成 `proposed` 意图，业务 Run 仍只由
 * dispatch 端口创建；autoDispatch='existing_task' 的事后派工由组合根注入的
 * 回调触发，保持 router → run 的静态边界。
 */
import { and, eq } from 'drizzle-orm'
import {
  closeWorkWait,
  getEvaluation,
  getEvaluationForUpdate,
  getOpenWorkWait,
  getRouterApplication,
  getRetractedInboxItemForSource,
  getWorkInboxItemByIdentity,
  getWorkQuestionByDecision,
  getWorkWaitByEvaluation,
  insertDispatchIntent,
  insertRouterApplication,
  insertWorkInboxItem,
  insertWorkQuestion,
  insertWorkWait,
  listActiveRunsByTask,
  schema,
  supersedePendingInboxItems,
  updateWork,
  type CoordinationEvaluationRow,
  type Database,
  type TaskRow,
  type Tx,
  type WorkInboxItemRow,
  type WorkMandateRow,
  type WorkRow,
} from '@whalepod/db'
import {
  CoordinationInputEntrySchema,
  RouterApplicationViewSchema,
  RouterProposalSchema,
  type CoordinationInputEntry,
  type RouterApplicationView,
  type RouterProposal,
} from '@whalepod/protocol'
import type { ArtifactStore } from '../artifact/store.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { WORK_ADMISSION_RULES_VERSION, loadWorkSource } from '../work/admission.js'
import { clampWorkTitle } from '../work/text.js'
import { lockRouterContext, rebuildRouterEvaluation } from './input.js'

export interface RouterApplicationDeps {
  readonly database: Database
  readonly store?: ArtifactStore
  readonly now?: () => Date
}
export type RouterAutoDispatch = (
  workKey: string,
  intentId: string,
  actorUserId: string,
) => Promise<{ readonly runId: string | null } | null>

const nowOf = (deps: RouterApplicationDeps): Date => deps.now?.() ?? new Date()

function sourceIdentity(
  value: string,
): { sourceType: 'task_message' | 'context_entry'; sourceId: string } | undefined {
  const separator = value.indexOf(':')
  if (separator <= 0) return undefined
  const sourceType = value.slice(0, separator)
  const sourceId = value.slice(separator + 1)
  if (sourceType !== 'task_message' && sourceType !== 'context_entry') return undefined
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sourceId))
    return undefined
  return { sourceType, sourceId }
}

export function toRouterApplicationView(
  row: typeof schema.routerApplications.$inferSelect,
): RouterApplicationView {
  return RouterApplicationViewSchema.parse({
    evaluationId: row.evaluationId,
    workKey: row.workKey,
    decision: row.decision,
    status: row.status,
    reason: row.reason ?? null,
    evaluationDigest: row.evaluationDigest,
    mandateId: row.mandateId,
    mandateVersion: row.mandateVersion,
    decisionId: row.decisionRowId ?? null,
    intentId: row.intentId ?? null,
    questionId: row.questionId ?? null,
    waitId: row.waitId ?? null,
    runId: row.runId ?? null,
    appliedAt: row.appliedAt.toISOString(),
  })
}

interface ApplicationResult {
  readonly status: 'applied' | 'stale' | 'rejected'
  readonly reason?: string
  readonly decisionRowId?: string | null
  readonly intentId?: string | null
  readonly questionId?: string | null
  readonly waitId?: string | null
  readonly runId?: string | null
  readonly refs?: Record<string, unknown>
}

function stale(reason: string): ApplicationResult {
  return { status: 'stale', reason }
}

function boundedSummary(value: string, fallback: string): string {
  const trimmed = value.trim()
  return (trimmed.length === 0 ? fallback : trimmed).slice(0, 500)
}

/**
 * refs 只存可回放的有界投影：完整提案仍在 evaluation 行；应用/问题/wait 的
 * DB check 分别只有 8192/4096 字节。citation 去重，coverage 只留计数，避免
 * 合法但引用密集的提案在插入时永久失败。
 */
function proposalRefs(
  row: CoordinationEvaluationRow,
  proposal: RouterProposal,
): Record<string, unknown> {
  return {
    resultDigest: row.resultDigest,
    actionClass: proposal.decision === 'dispatch' ? proposal.actionClass : null,
    summary: boundedSummary(proposal.summary, 'router proposal'),
    citations: [...new Set(proposal.citations)].slice(0, 8),
    coverage: proposal.coverage.slice(0, 8).map((entry) => ({
      inputId: entry.inputId,
      status: entry.status,
      evidenceCount: entry.evidenceIds.length,
    })),
  }
}

function fitRefs(refs: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(refs)) <= maxBytes) return refs
  const { citations: _citations, coverage: _coverage, ...withoutRefs } = refs
  if (Buffer.byteLength(JSON.stringify(withoutRefs)) <= maxBytes) return withoutRefs
  const { summary: _summary, ...minimal } = withoutRefs
  return minimal
}

/**
 * 幂等应用；重复调用返回同一行。并发调用在评估行 FOR UPDATE 上串行化。
 */
export async function applyRouterEvaluation(
  deps: RouterApplicationDeps,
  evaluationId: string,
): Promise<typeof schema.routerApplications.$inferSelect> {
  return deps.database.transaction(async (tx) => {
    const snapshot = await getEvaluation(tx, evaluationId)
    if (!snapshot || snapshot.purpose !== 'router' || snapshot.workKey === null)
      throw new ApiError(404, 'NOT_FOUND', 'router evaluation not found')
    // 锁序固定 Task → Work，与接受/拒绝、重评与派工端口一致。
    const { work, task } = await lockRouterContext(tx, snapshot.workKey)
    const row = await getEvaluationForUpdate(tx, evaluationId)
    if (!row || row.purpose !== 'router' || row.workKey !== work.workKey)
      throw new ApiError(409, 'CONFLICT', 'router evaluation changed')
    const existing = await getRouterApplication(tx, evaluationId)
    if (existing !== undefined) return existing
    if (row.status !== 'completed' || row.routerProposal === null || row.resultDigest === null)
      throw new ApiError(409, 'CONFLICT', 'router proposal was not accepted')

    const proposal = RouterProposalSchema.parse(row.routerProposal)
    const now = nowOf(deps)
    const application = await decide(tx, deps, row, proposal, work, task, now)
    const inserted = await insertRouterApplication(tx, {
      evaluationId: row.id,
      projectId: row.projectId,
      workId: work.id,
      taskId: task.id,
      workKey: work.workKey,
      decision: proposal.decision,
      status: application.status,
      reason: application.reason ?? null,
      evaluationDigest: row.evaluationDigest ?? row.inputDigest,
      mandateId: row.mandateId!,
      mandateVersion: row.mandateVersion!,
      decisionRowId: application.decisionRowId ?? null,
      intentId: application.intentId ?? null,
      questionId: application.questionId ?? null,
      waitId: application.waitId ?? null,
      runId: application.runId ?? null,
      refs: application.refs ?? {},
      appliedAt: now,
    })
    if (inserted === undefined)
      throw new ApiError(409, 'CONFLICT', 'router application was created concurrently')
    return inserted
  })
}

async function decide(
  tx: Tx,
  deps: RouterApplicationDeps,
  row: CoordinationEvaluationRow,
  proposal: RouterProposal,
  work: WorkRow,
  task: TaskRow,
  now: Date,
): Promise<ApplicationResult> {
  let rebuilt: Awaited<ReturnType<typeof rebuildRouterEvaluation>>
  try {
    rebuilt = await rebuildRouterEvaluation(tx, row, now, deps.store)
  } catch (error) {
    // reason 是稳定契约：不能把 ApiError 的自由文案直接写进应用记录。
    if (error instanceof ApiError) return stale('input_or_authority_changed')
    throw error
  }
  if (rebuilt.input.work.id !== work.id || rebuilt.input.task.id !== task.id)
    return stale('work_binding_changed')
  if (task.assignmentStatus !== 'accepted') return stale('assignment_not_accepted')
  if (task.status === 'done' || task.status === 'cancelled') return stale('task_terminal')
  const mandate = rebuilt.input.mandate
  if (mandate.status !== 'active' || mandate.expiresAt.getTime() <= now.getTime())
    return stale('mandate_inactive')
  if (proposal.decision === 'dispatch' && proposal.workKey !== work.workKey)
    return stale('work_key_mismatch')
  const refs = proposalRefs(row, proposal)
  switch (proposal.decision) {
    case 'dispatch':
      return applyDispatch(tx, row, proposal, work, task, mandate, now, refs)
    case 'wait':
      return applyWait(tx, row, proposal, work, task, mandate, now, refs)
    case 'ask':
      return applyAsk(tx, row, proposal, work, task, mandate, now, refs)
    case 'ignore':
      // 新的评估已经给出「无需行动」的结论；旧 wait 的恢复条件随之失效，
      // 否则它会一直挂到 deadline 并再触发一次评估。重复应用由应用行幂等拦截。
      await supersedeOpenRouterWait(tx, work, now)
      return {
        status: 'applied',
        reason: proposal.reason,
        refs: fitRefs(refs, 8192),
      }
  }
}

interface PreparedInputs {
  readonly triggerRefs: {
    readonly sourceType: 'task_message' | 'context_entry'
    readonly sourceId: string
    readonly sourceVersion: string
    readonly sourceDigest: string
    readonly authorizationGeneration: string
  }[]
  readonly inboxItemIds: string[]
}

async function prepareInboxInputs(
  tx: Tx,
  row: CoordinationEvaluationRow,
  proposal: Extract<RouterProposal, { decision: 'dispatch' }>,
  work: WorkRow,
  now: Date,
): Promise<PreparedInputs | ApplicationResult> {
  const manifest = CoordinationInputEntrySchema.array().parse(
    (row.inputManifest as { entries?: unknown }).entries ?? [],
  )
  const uncovered = new Set(
    proposal.coverage.filter((entry) => entry.status === 'uncovered').map((entry) => entry.inputId),
  )
  const selected = manifest.filter((entry) => entry.kind === 'source' && uncovered.has(entry.id))
  if (selected.length === 0) return stale('no_uncovered_source')
  // 先完成全部来源校验，再写收件箱：后面的来源失效时不能留下前一条的副作用。
  const loaded: Array<{
    readonly entry: CoordinationInputEntry
    readonly source: Awaited<ReturnType<typeof loadWorkSource>>
    readonly existing: WorkInboxItemRow | undefined
  }> = []
  for (const entry of selected) {
    const identity = sourceIdentity(entry.sourceId)
    if (identity === undefined) return stale('source_identity_invalid')
    const retracted = await getRetractedInboxItemForSource(
      tx,
      work.id,
      identity.sourceType,
      identity.sourceId,
    )
    if (retracted !== undefined) return stale('source_retracted')
    let source
    try {
      source = await loadWorkSource(tx, work, identity.sourceType, identity.sourceId)
    } catch {
      return stale('source_unavailable')
    }
    if (
      source.ignored !== undefined ||
      source.sourceVersion !== entry.version ||
      sha256Hex(source.body) !== entry.digest ||
      source.authorizationGeneration !== entry.authorizationGeneration
    )
      return stale('source_changed')
    const existing = await getWorkInboxItemByIdentity(tx, {
      workId: work.id,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceVersion: source.sourceVersion,
      sourceDigest: source.sourceDigest,
    })
    if (existing !== undefined && existing.status !== 'pending' && existing.status !== 'returned')
      return stale('input_not_pending')
    loaded.push({ entry, source, existing })
  }
  const triggerRefs: PreparedInputs['triggerRefs'] = []
  const inboxItemIds: string[] = []
  for (const { entry, source, existing } of loaded) {
    if (existing !== undefined) {
      inboxItemIds.push(existing.id)
    } else {
      const superseded = await supersedePendingInboxItems(tx, {
        workId: work.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        now,
      })
      const inserted = await insertWorkInboxItem(tx, {
        id: uuidv7(now.getTime()),
        workId: work.id,
        workKey: work.workKey,
        taskId: work.taskId,
        projectId: work.projectId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        sourceDigest: source.sourceDigest,
        authorizationGeneration: source.authorizationGeneration,
        title: clampWorkTitle(source.title, '工作输入'),
        body: source.body,
        bodyDigest: sha256Hex(source.body),
        refs: source.refs,
        ...(source.businessRef === undefined ? {} : { businessRef: source.businessRef }),
        sourceKind: source.sourceKind,
        supersedesId: superseded.at(-1)?.id ?? null,
        autoAdmitted: true,
        status: 'pending',
        statusAt: now,
        createdAt: now,
        updatedAt: now,
      })
      const item: WorkInboxItemRow | undefined =
        inserted ??
        (await getWorkInboxItemByIdentity(tx, {
          workId: work.id,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceVersion: source.sourceVersion,
          sourceDigest: source.sourceDigest,
        }))
      if (item === undefined) return stale('inbox_item_missing')
      inboxItemIds.push(item.id)
    }
    triggerRefs.push({
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceVersion: entry.version,
      sourceDigest: source.sourceDigest,
      authorizationGeneration: entry.authorizationGeneration,
    })
  }
  return { triggerRefs, inboxItemIds }
}

async function releaseOpenRouterWait(tx: Tx, work: WorkRow, now: Date): Promise<WorkRow> {
  const open = await getOpenWorkWait(tx, work.id)
  if (open === undefined) return work
  if (
    work.state !== 'waiting' ||
    work.resumeMode !== 'auto' ||
    work.resumeCondition === null ||
    !work.resumeCondition.startsWith('router:')
  )
    return work
  await closeWorkWait(tx, open.id, 'superseded', now)
  await updateWork(tx, work.id, {
    state: 'active',
    resumeMode: null,
    resumeCondition: null,
    updatedAt: now,
  })
  return { ...work, state: 'active', resumeMode: null, resumeCondition: null }
}

async function applyDispatch(
  tx: Tx,
  row: CoordinationEvaluationRow,
  proposal: Extract<RouterProposal, { decision: 'dispatch' }>,
  work: WorkRow,
  task: TaskRow,
  mandate: WorkMandateRow,
  now: Date,
  refs: Record<string, unknown>,
): Promise<ApplicationResult> {
  if ((await listActiveRunsByTask(tx, task.id)).length > 0) return stale('active_run')
  // 新的 dispatch 决定可以取代本工作自己的 router wait；先恢复 active 再判
  // work 状态，否则 wait 会把所有后续 dispatch 永久挡在 work_not_active。
  const currentWork = await releaseOpenRouterWait(tx, work, now)
  if (currentWork.state !== 'active') return stale('work_not_active')
  if (task.approvalPolicy === 'full_access') return stale('full_access_task')
  if (!mandate.allowedActionClasses.includes(proposal.actionClass))
    return stale('action_class_forbidden')
  const prepared = await prepareInboxInputs(tx, row, proposal, currentWork, now)
  if ('status' in prepared) return prepared
  const inputDigest = sha256Hex(
    canonicalJson({
      workKey: currentWork.workKey,
      rulesVersion: WORK_ADMISSION_RULES_VERSION,
      workAuthorizationVersion: mandate.version,
      items: prepared.triggerRefs,
    }),
  )
  const intent = await insertDispatchIntent(tx, {
    id: uuidv7(now.getTime()),
    workId: currentWork.id,
    workKey: currentWork.workKey,
    taskId: task.id,
    projectId: currentWork.projectId,
    decisionId: null,
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    status: 'proposed',
    approvalBasis: null,
    authorizedByUserId: task.assigneeUserId,
    onBehalfOfUserId: task.assigneeUserId,
    inputDigest,
    triggerRefs: prepared.triggerRefs,
    candidates: [],
    exclusionReasons: [],
    // 模型摘要留在 principal-bound 的 application/refs，不写进改派后新责任人
    // 也能读到的 Intent reason。
    reason: 'router_dispatch',
    runId: null,
    expiresAt: new Date(
      Math.min(now.getTime() + mandate.waitDeadlineSeconds * 1000, mandate.expiresAt.getTime()),
    ),
    approvedAt: null,
    dispatchedAt: null,
    cancelledAt: null,
    rejectedAt: null,
    createdAt: now,
    updatedAt: now,
  })
  // 新的 dispatch 取代旧 wait；work 只在它正等待本工作自己的 router wait 时恢复。
  await supersedeOpenRouterWait(tx, currentWork, now)
  return {
    status: 'applied',
    intentId: intent.id,
    refs: fitRefs(
      {
        ...refs,
        inboxItemIds: prepared.inboxItemIds,
        triggerRefs: prepared.triggerRefs,
        inputDigest,
      },
      8192,
    ),
  }
}

async function applyWait(
  tx: Tx,
  row: CoordinationEvaluationRow,
  proposal: Extract<RouterProposal, { decision: 'wait' }>,
  work: WorkRow,
  task: TaskRow,
  mandate: WorkMandateRow,
  now: Date,
  refs: Record<string, unknown>,
): Promise<ApplicationResult> {
  const deadline = new Date(proposal.deadlineAt)
  const latestAllowed = Math.min(
    mandate.expiresAt.getTime(),
    now.getTime() + mandate.waitDeadlineSeconds * 1000,
  )
  if (deadline.getTime() <= now.getTime() || deadline.getTime() > latestAllowed)
    return stale('invalid_wait_deadline')
  const open = await getOpenWorkWait(tx, work.id)
  if (open !== undefined) {
    if (open.evaluationId === row.id) {
      const existing = await getRouterApplication(tx, row.id)
      if (existing !== undefined) return { status: 'applied', waitId: open.id, refs }
    }
    await closeWorkWait(tx, open.id, 'superseded', now)
  }
  const waitRefs = fitRefs(refs, 4096)
  const wait = await insertWorkWait(tx, {
    id: uuidv7(now.getTime()),
    evaluationId: row.id,
    projectId: work.projectId,
    workId: work.id,
    taskId: task.id,
    workKey: work.workKey,
    status: 'open',
    reason: proposal.reason,
    summary: boundedSummary(proposal.summary, 'Router wait'),
    resumeCondition: `router:${row.id}`,
    sourceType: row.routerContext!.sourceType,
    sourceId: row.routerContext!.sourceId,
    triggerKey: row.routerContext!.triggerKey,
    generation: 1,
    deadlineAt: deadline,
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    principalUserId: task.assigneeUserId,
    refs: waitRefs,
    createdAt: now,
    updatedAt: now,
  })
  const alreadyWaitingOnRouter =
    work.state === 'waiting' &&
    work.resumeMode === 'auto' &&
    work.resumeCondition !== null &&
    work.resumeCondition.startsWith('router:')
  if (alreadyWaitingOnRouter) {
    // 旧 wait 被新 wait 取代时，work 的恢复条件必须跟着换代；否则唯一 open
    // wait 已关闭而 work 永远指向旧 evaluation，后续重评无法恢复。
    await updateWork(tx, work.id, {
      state: 'waiting',
      resumeMode: 'auto',
      resumeCondition: `router:${row.id}`,
      updatedAt: now,
    })
  } else if (work.state === 'active' && (await listActiveRunsByTask(tx, task.id)).length === 0) {
    await updateWork(tx, work.id, {
      state: 'waiting',
      resumeMode: 'auto',
      resumeCondition: `router:${row.id}`,
      updatedAt: now,
    })
  }
  if (wait !== undefined) return { status: 'applied', waitId: wait.id, refs: waitRefs }
  const existingWait = await getWorkWaitByEvaluation(tx, row.id)
  if (existingWait === undefined) return stale('wait_insert_lost')
  return { status: 'applied', waitId: existingWait.id, refs: waitRefs }
}

function routerDecisionId(input: {
  readonly workKey: string
  readonly blockedDecision: string
  readonly inputDigest: string
  readonly mandateVersion: number
  readonly questionType: 'choose_option' | 'authorize_scope'
}): string {
  return sha256Hex(
    canonicalJson({
      workKey: input.workKey,
      blockedDecision: input.blockedDecision,
      inputDigest: input.inputDigest,
      mandateVersion: input.mandateVersion,
      questionType: input.questionType,
    }),
  )
}

async function applyAsk(
  tx: Tx,
  row: CoordinationEvaluationRow,
  proposal: Extract<RouterProposal, { decision: 'ask' }>,
  work: WorkRow,
  task: TaskRow,
  mandate: WorkMandateRow,
  now: Date,
  refs: Record<string, unknown>,
): Promise<ApplicationResult> {
  // 先完成提案校验与问题落库，再收口旧 wait：非法 blockedDecision 只落 stale，
  // 不能把仍有效的 wait/恢复条件一起毁掉。同一评估的重复应用由 application 行幂等拦截。
  const blockedDecision = proposal.blockedDecision.trim()
  if (blockedDecision.length === 0 || blockedDecision.length > 64)
    return stale('invalid_blocked_decision')
  const questionRefs = fitRefs(
    {
      ...refs,
      evaluationId: row.id,
      evaluationDigest: row.evaluationDigest,
      questionType: proposal.questionType,
    },
    4096,
  )
  const decisionId = routerDecisionId({
    workKey: work.workKey,
    blockedDecision,
    inputDigest: row.evaluationDigest ?? row.inputDigest,
    mandateVersion: mandate.version,
    questionType: proposal.questionType,
  })
  const existing = await getWorkQuestionByDecision(tx, decisionId)
  if (existing !== undefined) {
    await supersedeOpenRouterWait(tx, work, now)
    return { status: 'applied', questionId: existing.id, refs: questionRefs }
  }
  const question = await insertWorkQuestion(tx, {
    id: uuidv7(now.getTime()),
    workId: work.id,
    taskId: task.id,
    projectId: work.projectId,
    decisionId,
    questionType: proposal.questionType,
    blockedDecision,
    summary: boundedSummary(proposal.summary, 'Router question'),
    options: proposal.options.map((option) => ({ id: option.id, label: option.label })),
    recommendedOptionId: proposal.recommendedOptionId,
    refs: questionRefs,
    inputDigest: row.evaluationDigest ?? row.inputDigest,
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    principalUserId: task.assigneeUserId,
    dispatchIntentId: null,
    status: 'open',
    answeredAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  })
  if (question !== undefined) {
    await supersedeOpenRouterWait(tx, work, now)
    return { status: 'applied', questionId: question.id, refs: questionRefs }
  }
  const raced = await getWorkQuestionByDecision(tx, decisionId)
  if (raced === undefined) return stale('question_insert_lost')
  await supersedeOpenRouterWait(tx, work, now)
  return { status: 'applied', questionId: raced.id, refs: questionRefs }
}

async function supersedeOpenRouterWait(tx: Tx, work: WorkRow, now: Date): Promise<void> {
  const open = await getOpenWorkWait(tx, work.id)
  if (open === undefined) return
  await closeWorkWait(tx, open.id, 'superseded', now)
  if (
    work.state === 'waiting' &&
    work.resumeMode === 'auto' &&
    work.resumeCondition !== null &&
    work.resumeCondition.startsWith('router:')
  ) {
    await updateWork(tx, work.id, {
      state: 'active',
      resumeMode: null,
      resumeCondition: null,
      updatedAt: now,
    })
  }
}

/**
 * 应用后可选触发既有自动派工端口。组合根注入；未注入时意图保持 proposed，
 * 负责人仍可按既有人工链确认。返回 Run id 用于回填应用记录。
 */
export async function autoDispatchAppliedIntent(
  deps: RouterApplicationDeps,
  onAutoDispatch: RouterAutoDispatch | undefined,
  workKey: string,
  intentId: string,
  actorUserId: string,
): Promise<string | null> {
  if (onAutoDispatch === undefined) return null
  const result = await onAutoDispatch(workKey, intentId, actorUserId)
  const runId = result?.runId ?? null
  if (runId !== null) {
    await deps.database.db
      .update(schema.routerApplications)
      .set({ runId })
      .where(
        and(
          eq(schema.routerApplications.intentId, intentId),
          eq(schema.routerApplications.workKey, workKey),
        ),
      )
  }
  return runId
}
