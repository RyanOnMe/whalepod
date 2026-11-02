import {
  getArtifact,
  getContextEntry,
  getDispatchIntent,
  getDispatchIntentByDecision,
  getEnabledMember,
  getLatestWorkMandate,
  getRouterDecisionById,
  getRouterDecisionBySource,
  getRun,
  getTaskMessage,
  getTeam,
  insertDispatchIntent,
  insertRouterDecision,
  transactCommandWithOrigin,
  type Database,
  type RouterDecisionRow,
  type Tx,
  type WorkMandateRow,
  type WorkRow,
} from '@whalepod/db'
import type { RouterDecisionKind, WorkSourceType } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { lockWorkContext, requireAssignee } from './context.js'
import { toDispatchIntentView, toWorkDecisionView } from './queries.js'

// ADR-0028 §4（RD-01 影子版）：入口程序准入。只处理可验证事实；所有「是否相关」的
// 语义判断留给后续 Router，本切片只落 propose(needs_semantic) 的 proposed 意图。
// 这里没有模型调用、没有 Run/outbox/team_event 写入，也没有业务事实写入。

export const WORK_ADMISSION_RULES_VERSION = 'rd01.v1'

export type WorkIgnoreReason =
  | 'no_mandate'
  | 'mandate_expired'
  | 'work_state'
  | 'owner_changed'
  | 'source_inactive'
  | 'system_produced'
  | 'already_directed'
  | 'source_not_allowed'
  | 'source_out_of_scope'

export interface AdmissionSource {
  readonly sourceType: WorkSourceType
  readonly sourceId: string
  readonly sourceVersion: string
  readonly sourceDigest: string
  readonly authorizationGeneration: string
  readonly sourceKind: string
  /** 私有的正文快照；只进收件箱，不进公开投影。 */
  readonly title: string
  readonly body: string
  /** 已能确定必须忽略时的原因；仍待语义判断时为 undefined。 */
  readonly ignored?: {
    readonly reason: WorkIgnoreReason
    readonly summary: string
    readonly detail?: string
  }
  /** 仅用于读面定位，不复制正文。 */
  readonly refs: Record<string, unknown>
}

function parseBusinessId(value: string | null): string | undefined {
  if (value === null) return undefined
  const id = value.slice(value.indexOf(':') + 1)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined
}

async function taskIdOfBusinessRef(
  tx: Tx,
  businessRef: string | null,
): Promise<string | undefined> {
  if (businessRef === null) return undefined
  if (businessRef.startsWith('taskSpec:')) return parseBusinessId(businessRef)
  const id = parseBusinessId(businessRef)
  if (id === undefined) return undefined
  if (businessRef.startsWith('run:')) return (await getRun(tx, id))?.taskId
  if (businessRef.startsWith('artifact:')) return (await getArtifact(tx, id))?.taskId
  return undefined
}

async function loadTaskMessageSource(
  tx: Tx,
  work: WorkRow,
  sourceId: string,
): Promise<AdmissionSource> {
  const message = await getTaskMessage(tx, sourceId)
  if (message === undefined) throw new ApiError(404, 'NOT_FOUND', 'task message not found')
  if (message.taskId !== work.taskId) {
    throw new ApiError(409, 'CONFLICT', 'message does not belong to the work task', {
      reason: 'source_out_of_scope',
      detail: 'task_mismatch',
    })
  }
  const sourceVersion = (message.editedAt ?? message.createdAt).toISOString()
  const sourceDigest = sha256Hex(
    canonicalJson({
      sourceType: 'task_message',
      sourceId: message.id,
      taskId: message.taskId,
      authorUserId: message.authorUserId,
      kind: message.kind,
      origin: message.origin,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
    }),
  )
  let ignored: AdmissionSource['ignored']
  if (message.kind !== 'discussion') {
    ignored = {
      reason: 'already_directed',
      summary: '来源是已定向到 Agent 的指令/追问，不作为新的工作候选',
    }
  } else {
    const team = await getTeam(tx)
    if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
    const author = await getEnabledMember(tx, team.id, message.authorUserId)
    if (author === undefined) {
      ignored = {
        reason: 'source_inactive',
        summary: '来源作者已不是启用中的成员',
        detail: 'author_not_member',
      }
    }
  }
  return {
    sourceType: 'task_message',
    sourceId: message.id,
    sourceVersion,
    sourceDigest,
    authorizationGeneration: 'member',
    sourceKind: message.kind,
    title: 'Task 讨论消息',
    body: message.body,
    ...(ignored === undefined ? {} : { ignored }),
    refs: { messageKind: message.kind },
  }
}

async function loadContextEntrySource(
  tx: Tx,
  work: WorkRow,
  sourceId: string,
): Promise<AdmissionSource> {
  const entry = await getContextEntry(tx, sourceId)
  if (entry === undefined) throw new ApiError(404, 'NOT_FOUND', 'context entry not found')
  if (entry.projectId !== work.projectId) {
    throw new ApiError(409, 'CONFLICT', 'context entry does not belong to the work project', {
      reason: 'source_out_of_scope',
      detail: 'project_mismatch',
    })
  }
  const sourceVersion = entry.updatedAt.toISOString()
  const sourceDigest = sha256Hex(
    canonicalJson({
      entryId: entry.id,
      kind: entry.kind,
      status: entry.status,
      correctedAt: entry.correctedAt?.toISOString() ?? null,
      title: entry.title,
      body: entry.body,
      payload: entry.payload,
      businessRef: entry.businessRef,
      businessVersion: entry.businessVersion,
      targetEntryId: entry.targetEntryId,
      sourceId: entry.sourceId,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    }),
  )
  const refs: Record<string, unknown> = {
    entryKind: entry.kind,
    ...(entry.businessRef === null ? {} : { businessRef: entry.businessRef }),
  }
  let ignored: AdmissionSource['ignored']
  if (entry.sourceId !== null) {
    // 外部来源的权限代次由 ADR-0024 绑定链复核；RD-01 没有该链，不能把未复核条目
    // 当成有效候选（fail-closed，不是按关键词丢弃）。
    ignored = {
      reason: 'source_inactive',
      summary: '外部来源条目的授权代次尚未复核',
      detail: 'source_permission_unverified',
    }
  } else if (entry.status !== 'active' || entry.correctedAt !== null) {
    ignored = {
      reason: 'source_inactive',
      summary: '来源已失效或被纠正',
      detail: entry.correctedAt !== null ? 'corrected' : 'inactive',
    }
  } else if (entry.kind === 'inference') {
    ignored = {
      reason: 'system_produced',
      summary: '系统推导不是新的工作输入',
      detail: 'inference',
    }
  } else if (entry.createdBy !== null) {
    const team = await getTeam(tx)
    if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
    const creator = await getEnabledMember(tx, team.id, entry.createdBy)
    if (creator === undefined) {
      ignored = {
        reason: 'source_inactive',
        summary: '来源创建者已不是启用中的成员',
        detail: 'creator_not_member',
      }
    }
  }
  if (ignored === undefined) {
    const associationRef =
      entry.kind === 'correction' && entry.targetEntryId !== null
        ? ((await getContextEntry(tx, entry.targetEntryId))?.businessRef ?? null)
        : entry.businessRef
    if (associationRef === null) {
      ignored = {
        reason: 'source_out_of_scope',
        summary: '条目没有可归属到本工作的 Task 引用',
      }
    } else {
      const associatedTaskId = await taskIdOfBusinessRef(tx, associationRef)
      if (associatedTaskId !== work.taskId) {
        ignored = {
          reason: 'source_out_of_scope',
          summary: '条目的业务归属不是本工作关联的 Task',
        }
      }
    }
  }
  return {
    sourceType: 'context_entry',
    sourceId: entry.id,
    sourceVersion,
    sourceDigest,
    authorizationGeneration: entry.sourceId === null ? 'internal' : 'source.unverified',
    sourceKind: entry.kind,
    title: entry.title,
    body: entry.body,
    ...(ignored === undefined ? {} : { ignored }),
    refs,
  }
}

/** 收件箱与准入共用同一份来源校验；调用方负责已锁定的 work。 */
export async function loadWorkSource(
  tx: Tx,
  work: WorkRow,
  sourceType: WorkSourceType,
  sourceId: string,
): Promise<AdmissionSource> {
  return sourceType === 'task_message'
    ? loadTaskMessageSource(tx, work, sourceId)
    : loadContextEntrySource(tx, work, sourceId)
}

export interface AdmissionCheckInput {
  readonly sourceType: WorkSourceType
  readonly sourceId: string
}

export interface AdmissionCheckResult {
  readonly decision: ReturnType<typeof toWorkDecisionView>
  readonly proposedIntent: ReturnType<typeof toDispatchIntentView> | null
  readonly duplicate: boolean
}

export interface AdmissionDeps {
  readonly database: Database
  readonly now: () => Date
}

function decisionSummary(decision: RouterDecisionKind, reason: string): string {
  if (decision === 'propose') return '影子提案：来源需要语义判断，尚未派发'
  if (decision === 'wait') return `暂缓：${reason}`
  return `忽略：${reason}`
}

function effectiveMandate(
  mandate: WorkMandateRow | undefined,
  now: Date,
): { active: WorkMandateRow | undefined; reason?: 'no_mandate' | 'mandate_expired' } {
  if (mandate === undefined) return { active: undefined, reason: 'no_mandate' }
  if (mandate.status === 'expired') return { active: undefined, reason: 'mandate_expired' }
  if (mandate.status !== 'active') return { active: undefined, reason: 'no_mandate' }
  if (mandate.expiresAt.getTime() <= now.getTime()) {
    return { active: undefined, reason: 'mandate_expired' }
  }
  return { active: mandate }
}

/**
 * 成员显式触发的影子准入。所有分支都只追加 `router_decision`；只有 `propose` 分支
 * 追加一条 `dispatch_intent(status='proposed')`。返回 `executed=false` 表示同 key 重放，
 * 调用方据此只对真实执行写观测日志。
 */
export async function checkWorkAdmission(
  deps: AdmissionDeps,
  actorUserId: string,
  workKey: string,
  input: AdmissionCheckInput,
  idempotencyKey: string,
): Promise<{ readonly value: AdmissionCheckResult; readonly executed: boolean }> {
  return await transactCommandWithOrigin(
    deps.database,
    `work.admission:${workKey}:${actorUserId}:${input.sourceType}:${input.sourceId}:${idempotencyKey}`,
    async (tx) => {
      const { work, task } = await lockWorkContext(tx, workKey)
      await requireAssignee(tx, task, actorUserId)
      const source = await loadWorkSource(tx, work, input.sourceType, input.sourceId)

      // 同一来源版本只裁决一次由 router_decision 唯一索引兜底；并发/重复插入
      // 走 insertRouterDecision 的 onConflictDoNothing + 回读既有决定。
      const now = deps.now()
      const latest = await getLatestWorkMandate(tx, work.id)
      const mandate = effectiveMandate(latest, now)

      let decision: RouterDecisionKind = 'propose'
      let reason = 'needs_semantic'
      let refs: Record<string, unknown> = source.refs
      if (task.status === 'done' || task.status === 'cancelled') {
        // 终态优先：即使之后又改派，成员看到的仍是「Task 已终态」。
        decision = 'wait'
        reason = 'work_state'
        refs = { ...source.refs, detail: 'task_terminal' }
      } else if (work.humanOwnerUserId !== task.assigneeUserId) {
        // 责任变更优先于一般 waiting 原因：正常改派已把 work 转
        // waiting(owner_confirmation)，这里给成员一个明确的 owner_changed 归因。
        decision = 'wait'
        reason = 'owner_changed'
        refs = {
          ...source.refs,
          detail: 'task assignee changed; new assignee must confirm work',
          deadlineAt: new Date(
            now.getTime() + (latest?.waitDeadlineSeconds ?? 900) * 1000,
          ).toISOString(),
        }
      } else if (work.state !== 'active') {
        decision = 'wait'
        reason = 'work_state'
        refs = {
          ...source.refs,
          workState: work.state,
          deadlineAt: new Date(
            now.getTime() + (latest?.waitDeadlineSeconds ?? 900) * 1000,
          ).toISOString(),
        }
      } else if (task.approvalPolicy === 'full_access') {
        // ADR-0028 §13：full_access Task 只能 ask/wait，不能进入自主派工候选。
        decision = 'wait'
        reason = 'full_access_task'
        refs = { ...source.refs, detail: 'task_approval_policy_full_access' }
      } else if (task.assignmentStatus !== 'accepted') {
        decision = 'wait'
        reason = 'assignment_pending'
        refs = { ...source.refs, detail: 'task_assignment_not_accepted' }
      } else if (mandate.active === undefined) {
        decision = 'ignore'
        reason = mandate.reason ?? 'no_mandate'
        refs = {
          ...source.refs,
          ...(latest === undefined ? {} : { mandateStatus: latest.status }),
        }
      } else if (!mandate.active.allowedSourceTypes.includes(source.sourceType)) {
        decision = 'ignore'
        reason = 'source_not_allowed'
        refs = { ...source.refs, sourceType: source.sourceType }
      } else if (source.ignored !== undefined) {
        decision = 'ignore'
        reason = source.ignored.reason
        refs = {
          ...source.refs,
          ...(source.ignored.detail === undefined ? {} : { detail: source.ignored.detail }),
        }
      }

      const inputDigest = sha256Hex(
        canonicalJson({
          workKey: work.workKey,
          rulesVersion: WORK_ADMISSION_RULES_VERSION,
          workAuthorizationVersion: mandate.active?.version ?? null,
          items: [
            {
              sourceType: source.sourceType,
              sourceId: source.sourceId,
              sourceVersion: source.sourceVersion,
              sourceDigest: source.sourceDigest,
              authorizationGeneration: source.authorizationGeneration,
            },
          ],
        }),
      )
      const summary =
        decision === 'ignore' && source.ignored !== undefined
          ? source.ignored.summary
          : decisionSummary(decision, reason)
      const inserted = await insertRouterDecision(tx, {
        id: uuidv7(now.getTime()),
        workId: work.id,
        taskId: work.taskId,
        projectId: work.projectId,
        decision,
        reason,
        summary,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        sourceDigest: source.sourceDigest,
        inputDigest,
        mandateId: latest?.id ?? null,
        mandateVersion: latest?.version ?? null,
        rulesVersion: WORK_ADMISSION_RULES_VERSION,
        refs,
        createdAt: now,
      })
      if (inserted === undefined) {
        const raced = await getRouterDecisionBySource(
          tx,
          work.id,
          source.sourceType,
          source.sourceId,
          source.sourceVersion,
          source.sourceDigest,
        )
        if (raced === undefined) {
          throw new ApiError(500, 'INTERNAL_ERROR', 'router decision insert lost without row')
        }
        return duplicateResult(tx, raced, now)
      }

      if (decision !== 'propose' || mandate.active === undefined) {
        return {
          decision: toWorkDecisionView(inserted),
          proposedIntent: null,
          duplicate: false,
        }
      }

      const intent = await insertDispatchIntent(tx, {
        id: uuidv7(now.getTime()),
        workId: work.id,
        taskId: work.taskId,
        projectId: work.projectId,
        decisionId: inserted.id,
        mandateId: mandate.active.id,
        mandateVersion: mandate.active.version,
        status: 'proposed',
        approvalBasis: null,
        authorizedByUserId: actorUserId,
        onBehalfOfUserId: actorUserId,
        inputDigest,
        triggerRefs: [
          {
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            sourceVersion: source.sourceVersion,
            sourceDigest: source.sourceDigest,
            authorizationGeneration: source.authorizationGeneration,
          },
        ],
        candidates: [],
        exclusionReasons: [],
        reason,
        runId: null,
        expiresAt: new Date(
          Math.min(
            now.getTime() + mandate.active.waitDeadlineSeconds * 1000,
            mandate.active.expiresAt.getTime(),
          ),
        ),
        approvedAt: null,
        dispatchedAt: null,
        cancelledAt: null,
        rejectedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      return {
        decision: toWorkDecisionView(inserted),
        proposedIntent: toDispatchIntentView(intent, now),
        duplicate: false,
      }
    },
  )
}

/**
 * 同一 Idempotency-Key 重放时，命令回执里缓存的是首次视图；决定/意图可能已被撤销或退休。
 * 重放返回前按 id 回读当前状态，避免客户端把已失效的 proposed 当成仍可确认。
 */
export async function refreshAdmissionResult(
  database: Database,
  cached: AdmissionCheckResult,
): Promise<AdmissionCheckResult> {
  const decision = await getRouterDecisionById(database.db, cached.decision.id)
  if (decision === undefined) return cached
  const intent =
    cached.proposedIntent === null
      ? undefined
      : await getDispatchIntent(database.db, cached.proposedIntent.id)
  const now = new Date()
  return {
    decision: toWorkDecisionView(decision),
    proposedIntent: intent === undefined ? null : toDispatchIntentView(intent, now),
    duplicate: true,
  }
}

async function duplicateResult(
  tx: Tx,
  existing: RouterDecisionRow,
  now: Date,
): Promise<AdmissionCheckResult> {
  const intent =
    existing.decision === 'propose' ? await getDispatchIntentByDecision(tx, existing.id) : undefined
  return {
    decision: toWorkDecisionView(existing),
    proposedIntent: intent === undefined ? null : toDispatchIntentView(intent, now),
    duplicate: true,
  }
}
