/**
 * ADR-0028 §17.1/§17.3（RD-03d3）：Run 终态与 wait 到期的自动复核调度。
 *
 * 调度器只做**确定性事实复核**与**可去重触发**：
 * - 机器 Run 终态事务落 `work_run_boundary(pending)`，本模块在受控后续事务中复核
 *   work/Task/Mandate/活跃 Run，再把 `run-terminal:<runId>` 代次交给既有评估端口；
 * - 已开 wait 到期后关闭 wait、恢复可恢复的 work，再把
 *   `wait-expiry:<waitId>:<generation>` 代次交给同一端口。
 *
 * 「未被成果覆盖且仍需执行」的判断仍在受限模型提案与 Hub 两次裁决里；本模块
 * 不因「有收件箱条目」「有通知」或「扫描到期」直接创建意图、问题或 Run，也不
 * 修改旧 Run 的输入快照。所有代次进入 evaluationDigest，同一轮重复扫描只会
 * 复用同一评估。
 */
import {
  closeWorkWait,
  getCoordinatorState,
  getDispatchIntent,
  getEnabledMember,
  getLatestWorkMandate,
  getRouterConfig,
  getRun,
  getTaskForUpdate,
  getTeam,
  getWorkByKey,
  getWorkRunBoundaryForUpdate,
  getWorkWait,
  getWorkWaitForUpdate,
  listActiveRunsByTask,
  listExpiredOpenWorkWaits,
  listPendingWorkRunBoundaries,
  markWorkRunBoundaryEnqueued,
  markWorkRunBoundarySkipped,
  updateWork,
  type Database,
  type DispatchIntentRow,
  type RunRow,
  type TaskRow,
  type Tx,
  type WorkRow,
  type WorkRunBoundaryRow,
  type WorkWaitRow,
} from '@whalepod/db'
import type { WorkSourceType } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { loadWorkSource } from '../work/admission.js'
import { lockRouterContext, type RouterTrigger } from './input.js'

export interface RouterScheduleDeps {
  readonly database: Database
  readonly now?: () => Date
  readonly log?: (event: Record<string, unknown>) => void
}

/**
 * 组合根注入的评估入队端口。调度器不直接 import service.ts，避免 router 模块内
 * 的循环依赖；端口语义与显式重评入口一致（同一代次可去重）。
 */
export interface RouterSchedulePorts {
  readonly enqueue: (
    tx: Tx,
    workKey: string,
    trigger: RouterTrigger,
  ) => Promise<{ readonly id: string }>
}

const nowOf = (deps: RouterScheduleDeps): Date => deps.now?.() ?? new Date()

function log(deps: RouterScheduleDeps, event: Record<string, unknown>): void {
  deps.log?.(event)
}

function reasonOf(error: unknown): string {
  return error instanceof ApiError ? error.code : error instanceof Error ? error.name : 'unknown'
}

interface TriggerRef {
  readonly sourceType: WorkSourceType
  readonly sourceId: string
}

/** 只取触发来源身份；版本/摘要由评估端口按当前事实重建，不信任意图里的旧值。 */
function parseTriggerRefs(value: readonly unknown[]): TriggerRef[] {
  const refs: TriggerRef[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const ref = raw as Record<string, unknown>
    if (
      (ref.sourceType === 'task_message' || ref.sourceType === 'context_entry') &&
      typeof ref.sourceId === 'string'
    ) {
      refs.push({ sourceType: ref.sourceType, sourceId: ref.sourceId })
    }
  }
  return refs
}

/**
 * Run 终态的触发来源取自已派工意图的 triggerRefs：那是本 Run 创建时依据的输入。
 * 来源已被撤权/不可读时不伪造替代来源，跳过并留下稳定原因；成员后续补充或显式
 * 重评仍可产生新的评估。
 */
async function resolveRunTrigger(
  tx: Tx,
  work: WorkRow,
  run: RunRow,
  mandate: { readonly allowedSourceTypes: readonly string[] },
): Promise<RouterTrigger | undefined> {
  const intent: DispatchIntentRow | undefined =
    run.dispatchIntentId === null ? undefined : await getDispatchIntent(tx, run.dispatchIntentId)
  for (const ref of parseTriggerRefs(intent?.triggerRefs ?? [])) {
    if (!mandate.allowedSourceTypes.includes(ref.sourceType)) continue
    try {
      const source = await loadWorkSource(tx, work, ref.sourceType, ref.sourceId)
      if (source.ignored !== undefined) continue
    } catch (error) {
      // 来源已撤权/不可读（4xx）才是稳定的跳过理由；5xx/未知错误必须上抛，
      // 让边界保持 pending 等下一轮重试，不能被误记成「没有触发来源」。
      if (error instanceof ApiError && error.statusCode < 500) continue
      throw error
    }
    return {
      sourceType: ref.sourceType,
      sourceId: ref.sourceId,
      triggerKey: `run-terminal:${run.id}`,
    }
  }
  return undefined
}

interface BoundaryPlan {
  readonly trigger?: RouterTrigger
  readonly skip?: string
}

/**
 * Run 终态复核的确定性事实闸：任一不满足都只记录跳过原因，不进入模型评估。
 * 这些判断与派工端口/应用端口同源；这里提前做是为了让「不得建下一 Run」在
 * 模型调用前就 fail-closed，并留下可解释的稳定原因。
 */
async function planRunBoundary(
  tx: Tx,
  boundary: WorkRunBoundaryRow,
  now: Date,
): Promise<BoundaryPlan> {
  const work = await getWorkByKey(tx, boundary.workKey)
  if (work === undefined) return { skip: 'work_missing' }
  if (work.id !== boundary.workId) return { skip: 'work_binding_changed' }
  if (work.retiredAt !== null) return { skip: 'work_retired' }
  const run = await getRun(tx, boundary.runId)
  if (run === undefined || run.workKey !== work.workKey || run.taskId !== work.taskId) {
    return { skip: 'run_binding_changed' }
  }
  const task: TaskRow | undefined = await getTaskForUpdate(tx, work.taskId)
  if (task === undefined) return { skip: 'task_missing' }
  if (task.status === 'done' || task.status === 'cancelled') return { skip: 'task_terminal' }
  if (task.assignmentStatus !== 'accepted') return { skip: 'assignment_not_accepted' }
  if (work.humanOwnerUserId !== task.assigneeUserId) return { skip: 'owner_changed' }
  if (work.state !== 'active') return { skip: 'work_not_active' }
  if (task.approvalPolicy === 'full_access') return { skip: 'full_access_task' }
  if ((await listActiveRunsByTask(tx, task.id)).length > 0) return { skip: 'active_run' }

  const mandate = await getLatestWorkMandate(tx, work.id)
  if (
    mandate === undefined ||
    work.mandateId !== mandate.id ||
    mandate.status !== 'active' ||
    mandate.expiresAt.getTime() <= now.getTime()
  ) {
    return { skip: 'mandate_inactive' }
  }
  if (
    mandate.principalUserId !== task.assigneeUserId ||
    mandate.onBehalfOfUserId !== task.assigneeUserId ||
    mandate.humanOwnerUserId !== task.assigneeUserId
  ) {
    return { skip: 'mandate_principal_changed' }
  }
  const team = await getTeam(tx)
  if (
    team === undefined ||
    (await getEnabledMember(tx, team.id, task.assigneeUserId)) === undefined
  ) {
    return { skip: 'assignee_inactive' }
  }
  const cfg = await getRouterConfig(tx, work.projectId)
  if (cfg === undefined || !cfg.enabled) return { skip: 'router_unavailable' }
  if (cfg.operatorUserId !== task.assigneeUserId || cfg.billingUserId !== task.assigneeUserId) {
    return { skip: 'router_principal_changed' }
  }
  const coordinator = await getCoordinatorState(tx, work.projectId)
  if (coordinator === undefined || !coordinator.enabled || coordinator.pausedAt !== null) {
    return { skip: 'coordinator_paused' }
  }
  const trigger = await resolveRunTrigger(tx, work, run, mandate)
  if (trigger === undefined) return { skip: 'no_trigger_source' }
  return { trigger }
}

/**
 * 处理待复核的 Run 边界。每条边界在自己的事务里加行锁并重新检查状态；并发 tick
 * 只有一个能把 pending 推进到 enqueued/skipped。入队失败按 fail-closed 记 skipped，
 * 不建意图、问题或 Run；成员后续补充/显式重评仍是独立入口。
 */
export async function processRunBoundaries(
  deps: RouterScheduleDeps,
  ports: RouterSchedulePorts,
  limit = 20,
): Promise<void> {
  for (const candidate of await listPendingWorkRunBoundaries(deps.database.db, limit)) {
    try {
      await deps.database.transaction(async (tx) => {
        const boundary = await getWorkRunBoundaryForUpdate(tx, candidate.id)
        if (boundary === undefined || boundary.status !== 'pending') return
        const now = nowOf(deps)
        const plan = await planRunBoundary(tx, boundary, now)
        if (plan.skip !== undefined || plan.trigger === undefined) {
          const skipped = await markWorkRunBoundarySkipped(
            tx,
            boundary.id,
            plan.skip ?? 'no_trigger_source',
            now,
          )
          if (skipped !== undefined) {
            log(deps, {
              component: 'hub.dispatch',
              action: 'work.run_boundary.skipped',
              runId: boundary.runId,
              workKey: boundary.workKey,
              reason: plan.skip ?? 'no_trigger_source',
            })
          }
          return
        }
        try {
          const evaluation = await ports.enqueue(tx, boundary.workKey, plan.trigger)
          const enqueued = await markWorkRunBoundaryEnqueued(tx, boundary.id, evaluation.id, now)
          if (enqueued !== undefined) {
            log(deps, {
              component: 'hub.dispatch',
              action: 'work.run_boundary.enqueued',
              runId: boundary.runId,
              workKey: boundary.workKey,
              evaluationId: evaluation.id,
              triggerKey: boundary.triggerKey,
            })
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error
          const skipped = await markWorkRunBoundarySkipped(tx, boundary.id, 'router_rejected', now)
          if (skipped !== undefined) {
            log(deps, {
              component: 'hub.dispatch',
              action: 'work.run_boundary.skipped',
              runId: boundary.runId,
              workKey: boundary.workKey,
              reason: 'router_rejected',
              code: reasonOf(error),
            })
          }
        }
      })
    } catch (error) {
      // 单条毒行不能阻塞其余边界；下一轮 tick 仍会重试仍为 pending 的行。
      log(deps, {
        component: 'hub.dispatch',
        action: 'work.run_boundary.failed',
        runId: candidate.runId,
        workKey: candidate.workKey,
        reason: reasonOf(error),
      })
    }
  }
}

/** wait 到期只恢复它自己挂起的 work；别的 wait/owner 条件不能被顺手清掉。 */
async function restoreWorkAfterWait(tx: Tx, work: WorkRow, wait: WorkWaitRow, now: Date) {
  if (
    work.state === 'waiting' &&
    work.resumeMode === 'auto' &&
    work.resumeCondition === `router:${wait.evaluationId}`
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
 * 到期 wait 的扫描与重评。关闭 wait 与恢复 work 在同一事务里完成；随后用
 * `wait-expiry:<waitId>:<generation>` 触发一次新评估。重复扫描因 wait 已不是
 * open 而自然收敛，不产生重复评估/问题/Run。
 */
export async function processExpiredWaits(
  deps: RouterScheduleDeps,
  ports: RouterSchedulePorts,
  limit = 20,
): Promise<void> {
  for (const candidate of await listExpiredOpenWorkWaits(deps.database.db, nowOf(deps), limit)) {
    try {
      await deps.database.transaction(async (tx) => {
        const snapshot = await getWorkWait(tx, candidate.id)
        if (snapshot === undefined) return
        // 锁序与显式重评/应用一致：Task → Coordinator → Work → wait。
        const { work } = await lockRouterContext(tx, snapshot.workKey)
        const wait = await getWorkWaitForUpdate(tx, snapshot.id)
        const now = nowOf(deps)
        if (
          wait === undefined ||
          wait.status !== 'open' ||
          wait.deadlineAt.getTime() > now.getTime()
        )
          return
        // 活跃 Run 期间不做语义重评：wait 保持 open/到期，Run 终态后的下一轮
        // tick 再关闭并重评；否则可能在同一执行边界前生产 ask/问题。
        if ((await listActiveRunsByTask(tx, work.taskId)).length > 0) return
        const closed = await closeWorkWait(tx, wait.id, 'expired', now)
        if (closed === undefined) return
        await restoreWorkAfterWait(tx, work, wait, now)
        try {
          const evaluation = await ports.enqueue(tx, wait.workKey, {
            sourceType: wait.sourceType,
            sourceId: wait.sourceId,
            triggerKey: `wait-expiry:${wait.id}:${wait.generation}`,
          })
          log(deps, {
            component: 'hub.dispatch',
            action: 'work.wait.expired',
            waitId: wait.id,
            workKey: wait.workKey,
            evaluationId: evaluation.id,
            reason: wait.reason,
          })
        } catch (error) {
          if (!(error instanceof ApiError)) throw error
          // wait 已关闭、work 已恢复；无有效授权/配置时不建评估，也不伪造问题。
          log(deps, {
            component: 'hub.dispatch',
            action: 'work.wait.expired',
            waitId: wait.id,
            workKey: wait.workKey,
            evaluationId: null,
            reason: wait.reason,
            skip: 'router_rejected',
            code: reasonOf(error),
          })
        }
      })
    } catch (error) {
      log(deps, {
        component: 'hub.dispatch',
        action: 'work.wait.expire_failed',
        waitId: candidate.id,
        workKey: candidate.workKey,
        reason: reasonOf(error),
      })
    }
  }
}

export async function runRouterSchedule(
  deps: RouterScheduleDeps,
  ports: RouterSchedulePorts,
): Promise<void> {
  await processRunBoundaries(deps, ports)
  await processExpiredWaits(deps, ports)
}
