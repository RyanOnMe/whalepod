import {
  expireWorkSubscriptionsAndRetract,
  findActiveWorkSubscription,
  getCurrentWorkByTask,
  getEnabledMember,
  getLatestWorkMandate,
  getTask,
  getTeam,
  getWorkByIdForUpdate,
  getWorkEntryAdmissionByKey,
  getWorkEntryRouterCallByKey,
  getWorkInboxItemByIdentity,
  getLatestPendingInboxItemForBusinessRef,
  getLatestPendingInboxItemForSource,
  getRetractedInboxItemForSource,
  insertWorkEntryAdmission,
  insertWorkEntryRouterCall,
  insertWorkInboxItem,
  retractAutoAdmittedInboxItemsForWork,
  retractInboxItemsForSubscription,
  supersedePendingInboxItems,
  supersedePendingInboxItemsForBusinessRef,
  updateWorkSubscription,
  type ContextEntryRow,
  type TaskMessageRow,
  type TaskRow,
  type Tx,
  type WorkEntryAdmissionRow,
  type WorkInboxItemRow,
  type WorkMandateRow,
  type WorkRow,
  type WorkSubscriptionRow,
} from '@whalepod/db'
import type { WorkEntryAdmissionOutcome, WorkSourceType } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import {
  loadWorkSource,
  effectiveMandate,
  taskIdOfBusinessRef,
  type AdmissionSource,
} from './admission.js'
import { clampWorkTitle, WORK_INBOX_BODY_MAX_BYTES } from './text.js'

// ADR-0028 §4（RD-02b）：入口程序准入。快路径只在「有效订阅 + 工作关联 + 权限仍有效」
// 时直接入收件箱，不调用 Router；其余可验证状态输出 drop/wait/route_router。
// 本模块不建 Run、不写 outbox/team_event，也不调用模型。

export const WORK_ENTRY_RULES_VERSION = 'rd02b.v1'
const MAX_BODY_BYTES = WORK_INBOX_BODY_MAX_BYTES

export interface WorkEntryRouteInput {
  readonly work: WorkRow
  readonly task: TaskRow
  readonly mandate: WorkMandateRow | undefined
  readonly source: AdmissionSource
  readonly reason: string
  readonly dedupeKey: string
}

export interface WorkEntryRouteResult {
  readonly callId: string
  readonly reason: string
}

/** Router 端口：RD-02b 只记录调用（尚无模型决定），不写 RD-01 的 router_decision。 */
export interface WorkEntryRouter {
  route(input: WorkEntryRouteInput): Promise<WorkEntryRouteResult>
}

function routerInputDigest(
  work: WorkRow,
  mandate: WorkMandateRow | undefined,
  source: AdmissionSource,
): string {
  return sha256Hex(
    canonicalJson({
      workKey: work.workKey,
      rulesVersion: WORK_ENTRY_RULES_VERSION,
      workAuthorizationVersion: mandate?.version ?? null,
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
}

export function createEntryRouter(tx: Tx, now: Date): WorkEntryRouter {
  return {
    async route(input) {
      const call = await insertWorkEntryRouterCall(tx, {
        id: uuidv7(now.getTime()),
        projectId: input.work.projectId,
        taskId: input.work.taskId,
        workId: input.work.id,
        workKey: input.work.workKey,
        reason: input.reason.slice(0, 500),
        rulesVersion: WORK_ENTRY_RULES_VERSION,
        inputDigest: routerInputDigest(input.work, input.mandate, input.source),
        sourceType: input.source.sourceType,
        sourceId: input.source.sourceId,
        sourceVersion: input.source.sourceVersion,
        sourceDigest: input.source.sourceDigest,
        authorizationGeneration: input.source.authorizationGeneration,
        dedupeKey: input.dedupeKey,
        createdAt: now,
      })
      if (call !== undefined) return { callId: call.id, reason: input.reason }
      // 并发同一入口事件：Router 调用记录也只保留一条。
      const raced = await getWorkEntryRouterCallByKey(tx, input.dedupeKey)
      if (raced === undefined) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'router call insert lost without row')
      }
      return { callId: raced.id, reason: input.reason }
    },
  }
}

export interface WorkEntryDeps {
  readonly now: Date
  readonly router: WorkEntryRouter
}

/** 生产装配：路由端口只记录真实调用，不写 RD-01 的影子决定。 */
export function workEntryDeps(tx: Tx, now: Date = new Date()): WorkEntryDeps {
  return { now, router: createEntryRouter(tx, now) }
}

interface WorkEntryEvent {
  readonly trigger: 'source' | 'return'
  readonly taskId: string
  /** 退回必须绑定条目自身的工作，不能重新推导 Task 当前工作。 */
  readonly workId?: string
  readonly sourceType: WorkSourceType
  readonly sourceId: string
  readonly matchTargetType: 'task' | 'business_ref'
  readonly matchTargetRef: string
  /** 业务引用新版本只替换同 identity/kind 的 pending；correction 不参与。 */
  readonly supersedeSourceKinds?: readonly string[]
  /** 纠正只替换被纠正条目的 pending，不碰同 businessRef 的更新版本。 */
  readonly supersedeExactSource?: {
    readonly sourceType: WorkSourceType
    readonly sourceId: string
  }
  readonly returnReason?: string
  readonly inboxItemId?: string
}

function dedupeKey(event: WorkEntryEvent, work: WorkRow, source: AdmissionSource): string {
  return [
    work.workKey,
    event.trigger,
    event.sourceType,
    source.sourceId,
    source.sourceVersion,
    source.sourceDigest,
    event.inboxItemId ?? 'none',
  ].join(':')
}

async function persistAdmission(
  tx: Tx,
  input: {
    readonly event: WorkEntryEvent
    readonly work: WorkRow
    readonly source: AdmissionSource
    readonly outcome: WorkEntryAdmissionOutcome
    readonly reason: string
    readonly subscriptionId: string | null
    readonly inboxItemId: string | null
    readonly routerInvoked: boolean
    readonly routerCallId: string | null
    readonly deadlineAt?: Date | null
    readonly now: Date
  },
): Promise<WorkEntryAdmissionRow> {
  const key = dedupeKey(input.event, input.work, input.source)
  const inserted = await insertWorkEntryAdmission(tx, {
    id: uuidv7(input.now.getTime()),
    projectId: input.work.projectId,
    taskId: input.work.taskId,
    workId: input.work.id,
    workKey: input.work.workKey,
    trigger: input.event.trigger,
    outcome: input.outcome,
    reason: input.reason,
    sourceType: input.source.sourceType,
    sourceId: input.source.sourceId,
    sourceVersion: input.source.sourceVersion,
    sourceDigest: input.source.sourceDigest,
    authorizationGeneration: input.source.authorizationGeneration,
    subscriptionId: input.subscriptionId,
    inboxItemId: input.inboxItemId,
    routerInvoked: input.routerInvoked,
    routerCallId: input.routerCallId,
    deadlineAt: input.deadlineAt ?? null,
    dedupeKey: key,
    createdAt: input.now,
  })
  if (inserted !== undefined) return inserted
  const raced = await getWorkEntryAdmissionByKey(tx, key)
  if (raced === undefined) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'entry admission insert lost without row')
  }
  return raced
}

async function waitReason(
  tx: Tx,
  work: WorkRow,
  task: TaskRow,
): Promise<{ reason: string } | undefined> {
  if (task.status === 'done' || task.status === 'cancelled') return { reason: 'work_state' }
  if (work.humanOwnerUserId !== task.assigneeUserId) return { reason: 'owner_changed' }
  if (work.state !== 'active') return { reason: 'work_state' }
  if (task.approvalPolicy === 'full_access') return { reason: 'full_access_task' }
  if (task.assignmentStatus !== 'accepted') return { reason: 'assignment_pending' }
  // 责任人停用后，快路径不能再投到其私有收件箱；订阅由 wait 分支统一转 stale。
  const team = await getTeam(tx)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  if ((await getEnabledMember(tx, team.id, task.assigneeUserId)) === undefined) {
    return { reason: 'assignee_inactive' }
  }
  return undefined
}

interface SubscriptionValidity {
  readonly valid: boolean
  readonly reason?:
    | 'mandate_inactive'
    | 'mandate_expired'
    | 'mandate_version_changed'
    | 'source_type_not_allowed'
    | 'source_generation_changed'
}

function validateSubscription(
  subscription: WorkSubscriptionRow,
  mandate: WorkMandateRow | undefined,
  mandateMissReason: 'mandate_inactive' | 'mandate_expired',
  source: AdmissionSource,
  now: Date,
): SubscriptionValidity {
  if (mandate === undefined) return { valid: false, reason: mandateMissReason }
  if (mandate.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'mandate_expired' }
  }
  if (mandate.id !== subscription.mandateId || mandate.version !== subscription.mandateVersion) {
    return { valid: false, reason: 'mandate_version_changed' }
  }
  if (!mandate.allowedSourceTypes.includes(source.sourceType)) {
    return { valid: false, reason: 'source_type_not_allowed' }
  }
  if (subscription.authorizationGeneration !== source.authorizationGeneration) {
    return { valid: false, reason: 'source_generation_changed' }
  }
  return { valid: true }
}

async function invalidateSubscription(
  tx: Tx,
  subscription: WorkSubscriptionRow,
  reason: string,
  now: Date,
): Promise<void> {
  await updateWorkSubscription(tx, subscription.id, {
    status: 'stale',
    endedAt: now,
    endedByUserId: null,
    statusReason: reason,
    updatedAt: now,
  })
  await retractInboxItemsForSubscription(tx, subscription.id, reason, now)
}

async function ensurePendingItemForWait(
  tx: Tx,
  event: WorkEntryEvent,
  work: WorkRow,
  source: AdmissionSource,
  now: Date,
): Promise<WorkInboxItemRow | undefined> {
  if (Buffer.byteLength(source.body, 'utf8') > MAX_BODY_BYTES) return undefined
  const existing = await getWorkInboxItemByIdentity(tx, {
    workId: work.id,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    sourceDigest: source.sourceDigest,
  })
  if (existing !== undefined) return existing
  // 同一 sourceId 的新版本在 wait 期间也必须先收口旧 pending，否则会撞
  // work_inbox_item_source_pending_unique 并回滚整条业务事务。
  const previous = await getLatestPendingInboxItemForSource(
    tx,
    work.id,
    source.sourceType,
    source.sourceId,
  )
  if (previous !== undefined) {
    await supersedePendingInboxItems(tx, {
      workId: work.id,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      now,
    })
  }
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
    title: clampWorkTitle(source.title, source.sourceKind),
    body: source.body,
    bodyDigest: sha256Hex(source.body),
    refs: source.refs,
    businessRef: source.businessRef ?? null,
    sourceKind: source.sourceKind,
    supersedesId: previous?.id ?? null,
    subscriptionId: null,
    autoAdmitted: true,
    retractionScope: null,
    status: 'pending',
    statusReason: null,
    returnReason: null,
    returnNote: null,
    statusAt: now,
    createdAt: now,
    updatedAt: now,
  })
  if (inserted !== undefined) return inserted
  return await getWorkInboxItemByIdentity(tx, {
    workId: work.id,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    sourceDigest: source.sourceDigest,
  })
}

async function admitWorkEntry(
  tx: Tx,
  event: WorkEntryEvent,
  deps: WorkEntryDeps,
): Promise<WorkEntryAdmissionRow | undefined> {
  const task = await getTask(tx, event.taskId)
  if (task === undefined) return undefined
  const snapshot =
    event.workId === undefined ? await getCurrentWorkByTask(tx, event.taskId) : undefined
  const workId = event.workId ?? snapshot?.id
  if (workId === undefined) return undefined
  // 只锁 Work：Task 锁序始终是 task → work；入口准入可能在 context 事务里被调用，
  // 不再反向等待 Task，避免与 Task 事务的投影锁交叉。
  const work = await getWorkByIdForUpdate(tx, workId)
  if (work === undefined) return undefined
  if (work.taskId !== event.taskId) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'entry admission work does not match task')
  }
  // 来源入口不能投到已退休工作；退回必须落在条目自身的工作账本上，即使它已退休，
  // 否则 Router 调用会被静默丢失或记到同 Task 的后续工作上。
  if (work.state === 'retired' && event.trigger !== 'return') return undefined

  const source = await loadWorkSource(tx, work, event.sourceType, event.sourceId)
  const key = dedupeKey(event, work, source)
  const existing = await getWorkEntryAdmissionByKey(tx, key)
  if (existing !== undefined) return existing

  const now = deps.now
  if (event.trigger === 'return') {
    const latest = await getLatestWorkMandate(tx, work.id)
    const effective = effectiveMandate(latest, now).active
    const routed = await deps.router.route({
      work,
      task,
      mandate: effective,
      source,
      reason: `returned_${event.returnReason ?? 'unspecified'}`,
      dedupeKey: key,
    })
    return persistAdmission(tx, {
      event,
      work,
      source,
      outcome: 'route_router',
      reason: routed.reason,
      subscriptionId: null,
      inboxItemId: event.inboxItemId ?? null,
      routerInvoked: true,
      routerCallId: routed.callId,
      now,
    })
  }

  if (source.ignored !== undefined) {
    return persistAdmission(tx, {
      event,
      work,
      source,
      outcome: 'drop',
      reason: source.ignored.reason,
      subscriptionId: null,
      inboxItemId: null,
      routerInvoked: false,
      routerCallId: null,
      now,
    })
  }

  // 来源级撤权是 tombstone：自动入口不能绕过显式关联路径的停止重投。
  const retracted = await getRetractedInboxItemForSource(
    tx,
    work.id,
    source.sourceType,
    source.sourceId,
  )
  if (retracted !== undefined) {
    return persistAdmission(tx, {
      event,
      work,
      source,
      outcome: 'drop',
      reason: 'source_retracted',
      subscriptionId: null,
      inboxItemId: null,
      routerInvoked: false,
      routerCallId: null,
      now,
    })
  }

  const latest = await getLatestWorkMandate(tx, work.id)
  const effective = effectiveMandate(latest, now)
  const wait = await waitReason(tx, work, task)
  if (wait !== undefined) {
    if (wait.reason === 'assignee_inactive') {
      // 责任人不具备接收资格时，active 订阅同步失效；否则会留下指向无资格成员的
      // 私有订阅，后续只能等下一次入口事件才惰性收口。
      await expireWorkSubscriptionsAndRetract(tx, {
        workId: work.id,
        statusReason: 'assignee_inactive',
        now,
      })
      await retractAutoAdmittedInboxItemsForWork(tx, {
        workId: work.id,
        statusReason: 'assignee_inactive',
        now,
      })
    }
    // 等待中的 Task 讨论补充保留为 pending，供合法边界消费；系统投影/纠正不因
    // 「无 Mandate」自动入箱，避免每次 Run 终态 Observation 都留下待处理副本。
    let item: WorkInboxItemRow | undefined
    if (event.sourceType === 'task_message' && wait.reason !== 'assignee_inactive') {
      item = await ensurePendingItemForWait(tx, event, work, source, now)
      if (item === undefined) {
        return persistAdmission(tx, {
          event,
          work,
          source,
          outcome: 'drop',
          reason: 'body_too_large',
          subscriptionId: null,
          inboxItemId: null,
          routerInvoked: false,
          routerCallId: null,
          now,
        })
      }
    }
    return persistAdmission(tx, {
      event,
      work,
      source,
      outcome: 'wait',
      reason: wait.reason,
      subscriptionId: null,
      inboxItemId: item?.id ?? null,
      routerInvoked: false,
      routerCallId: null,
      deadlineAt: new Date(now.getTime() + (latest?.waitDeadlineSeconds ?? 900) * 1000),
      now,
    })
  }

  let subscription = await findActiveWorkSubscription(
    tx,
    work.id,
    event.matchTargetType,
    event.matchTargetRef,
  )
  let invalidReason: string | undefined
  if (subscription !== undefined) {
    const validity = validateSubscription(
      subscription,
      effective.active,
      effective.reason === 'mandate_expired' ? 'mandate_expired' : 'mandate_inactive',
      source,
      now,
    )
    if (validity.valid) {
      if (Buffer.byteLength(source.body, 'utf8') > MAX_BODY_BYTES) {
        return persistAdmission(tx, {
          event,
          work,
          source,
          outcome: 'drop',
          reason: 'body_too_large',
          subscriptionId: subscription.id,
          inboxItemId: null,
          routerInvoked: false,
          routerCallId: null,
          now,
        })
      }

      const duplicate = await getWorkInboxItemByIdentity(tx, {
        workId: work.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        sourceDigest: source.sourceDigest,
      })
      if (duplicate !== undefined) {
        return persistAdmission(tx, {
          event,
          work,
          source,
          outcome: 'drop',
          reason: 'duplicate',
          subscriptionId: subscription.id,
          inboxItemId: duplicate.id,
          routerInvoked: false,
          routerCallId: null,
          now,
        })
      }

      // 业务引用订阅的「新版本」由 (businessRef, sourceKind) 定义；不能按订阅 id
      // 一把抓——那会把人工纠正等独立项一起吞掉。同一 sourceId 的新版本（未来消息
      // 编辑/来源修订）同样先 supersede，避免撞 pending 唯一索引后回滚业务事务。
      let supersedesId: string | null = null
      if (event.supersedeExactSource !== undefined) {
        const target = event.supersedeExactSource
        const previous = await getLatestPendingInboxItemForSource(
          tx,
          work.id,
          target.sourceType,
          target.sourceId,
        )
        if (previous !== undefined) {
          await supersedePendingInboxItems(tx, {
            workId: work.id,
            sourceType: target.sourceType,
            sourceId: target.sourceId,
            now,
          })
          supersedesId = previous.id
        }
      } else if (event.matchTargetType === 'business_ref') {
        const supersedeKinds = event.supersedeSourceKinds ?? [source.sourceKind]
        const previous = await getLatestPendingInboxItemForBusinessRef(tx, {
          workId: work.id,
          businessRef: event.matchTargetRef,
          sourceKinds: supersedeKinds,
        })
        if (previous !== undefined) {
          await supersedePendingInboxItemsForBusinessRef(tx, {
            workId: work.id,
            businessRef: event.matchTargetRef,
            sourceKinds: supersedeKinds,
            now,
          })
          supersedesId = previous.id
        }
      } else {
        const previous = await getLatestPendingInboxItemForSource(
          tx,
          work.id,
          source.sourceType,
          source.sourceId,
        )
        if (previous !== undefined) {
          await supersedePendingInboxItems(tx, {
            workId: work.id,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            now,
          })
          supersedesId = previous.id
        }
      }

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
        title: clampWorkTitle(source.title, source.sourceKind),
        body: source.body,
        bodyDigest: sha256Hex(source.body),
        refs: source.refs,
        businessRef: event.matchTargetType === 'business_ref' ? event.matchTargetRef : null,
        sourceKind: source.sourceKind,
        supersedesId,
        subscriptionId: subscription.id,
        autoAdmitted: false,
        retractionScope: null,
        status: 'pending',
        statusReason: null,
        returnReason: null,
        returnNote: null,
        statusAt: now,
        createdAt: now,
        updatedAt: now,
      })
      let item: WorkInboxItemRow | undefined = inserted
      if (item === undefined) {
        item = await getWorkInboxItemByIdentity(tx, {
          workId: work.id,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceVersion: source.sourceVersion,
          sourceDigest: source.sourceDigest,
        })
      }
      if (item === undefined) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'inbox item insert lost without row')
      }
      return persistAdmission(tx, {
        event,
        work,
        source,
        outcome: inserted === undefined ? 'drop' : 'deliver',
        reason: inserted === undefined ? 'duplicate' : 'subscription_match',
        subscriptionId: subscription.id,
        inboxItemId: item.id,
        routerInvoked: false,
        routerCallId: null,
        now,
      })
    }

    invalidReason = validity.reason ?? 'subscription_invalid'
    await invalidateSubscription(tx, subscription, invalidReason, now)
    subscription = undefined
  }

  if (effective.active === undefined) {
    let item: WorkInboxItemRow | undefined
    if (event.sourceType === 'task_message') {
      item = await ensurePendingItemForWait(tx, event, work, source, now)
      if (item === undefined) {
        return persistAdmission(tx, {
          event,
          work,
          source,
          outcome: 'drop',
          reason: 'body_too_large',
          subscriptionId: null,
          inboxItemId: null,
          routerInvoked: false,
          routerCallId: null,
          now,
        })
      }
    }
    return persistAdmission(tx, {
      event,
      work,
      source,
      outcome: 'wait',
      reason: effective.reason === 'mandate_expired' ? 'mandate_expired' : 'mandate_inactive',
      subscriptionId: null,
      inboxItemId: item?.id ?? null,
      routerInvoked: false,
      routerCallId: null,
      deadlineAt: new Date(now.getTime() + (latest?.waitDeadlineSeconds ?? 900) * 1000),
      now,
    })
  }

  // 慢路径也必须尊重 Mandate 的来源类型边界；否则被排除的来源仍会生成
  // Router 调用记录，RD-03 可能把它当作新缺口候选。
  if (!effective.active.allowedSourceTypes.includes(source.sourceType)) {
    return persistAdmission(tx, {
      event,
      work,
      source,
      outcome: 'drop',
      reason: 'source_not_allowed',
      subscriptionId: null,
      inboxItemId: null,
      routerInvoked: false,
      routerCallId: null,
      now,
    })
  }

  const routed = await deps.router.route({
    work,
    task,
    mandate: effective.active,
    source,
    reason: invalidReason ?? 'no_valid_subscription',
    dedupeKey: key,
  })
  return persistAdmission(tx, {
    event,
    work,
    source,
    outcome: 'route_router',
    reason: routed.reason,
    subscriptionId: null,
    inboxItemId: null,
    routerInvoked: true,
    routerCallId: routed.callId,
    now,
  })
}

/**
 * Task 讨论消息的入口准入。指令/追问与自动派工消息不在此路径（它们不是「日常补充」）。
 */
export async function admitTaskMessageEntry(
  tx: Tx,
  message: TaskMessageRow,
  deps: WorkEntryDeps,
): Promise<WorkEntryAdmissionRow | undefined> {
  if (message.kind !== 'discussion' || message.origin !== 'human') return undefined
  return admitWorkEntry(
    tx,
    {
      trigger: 'source',
      taskId: message.taskId,
      sourceType: 'task_message',
      sourceId: message.id,
      matchTargetType: 'task',
      matchTargetRef: message.taskId,
    },
    deps,
  )
}

/** 业务事实投影（Decision/Observation）的入口准入：只匹配 business_ref 订阅。 */
export async function admitProjectedContextEntry(
  tx: Tx,
  entry: ContextEntryRow,
  deps: WorkEntryDeps,
): Promise<WorkEntryAdmissionRow | undefined> {
  if (entry.businessRef === null) return undefined
  const taskId = await taskIdOfBusinessRef(tx, entry.businessRef)
  if (taskId === undefined) return undefined
  return admitWorkEntry(
    tx,
    {
      trigger: 'source',
      taskId,
      sourceType: 'context_entry',
      sourceId: entry.id,
      matchTargetType: 'business_ref',
      matchTargetRef: entry.businessRef,
      supersedeSourceKinds: [entry.kind],
    },
    deps,
  )
}

/** 人工纠正：订阅目标是被纠正条目所属的 businessRef。 */
export async function admitContextCorrection(
  tx: Tx,
  correction: ContextEntryRow,
  target: ContextEntryRow,
  deps: WorkEntryDeps,
): Promise<WorkEntryAdmissionRow | undefined> {
  if (target.businessRef === null) return undefined
  const taskId = await taskIdOfBusinessRef(tx, target.businessRef)
  if (taskId === undefined) return undefined
  return admitWorkEntry(
    tx,
    {
      trigger: 'source',
      taskId,
      sourceType: 'context_entry',
      sourceId: correction.id,
      matchTargetType: 'business_ref',
      matchTargetRef: target.businessRef,
      // 纠正替换被纠正条目的 pending；同 businessRef 的新版本与其它纠正保持独立。
      supersedeExactSource: { sourceType: 'context_entry', sourceId: target.id },
    },
    deps,
  )
}

/** 退回是慢路径：保留收件箱水位，交 Router 重新判断（同一来源只裁决一次）。 */
export async function admitReturnedInboxItem(
  tx: Tx,
  item: WorkInboxItemRow,
  deps: WorkEntryDeps,
): Promise<WorkEntryAdmissionRow | undefined> {
  return admitWorkEntry(
    tx,
    {
      trigger: 'return',
      taskId: item.taskId,
      workId: item.workId,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      matchTargetType: 'task',
      matchTargetRef: item.taskId,
      ...(item.returnReason === null ? {} : { returnReason: item.returnReason }),
      inboxItemId: item.id,
    },
    deps,
  )
}
