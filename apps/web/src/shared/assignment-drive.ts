/**
 * 指派驱动的收窄与如实文案（#239 指派即执行 → #312 收口）。
 *
 * 两件事分开说：**「任务已创建」**（201 到了）与**「这次执行的实际命运」**。服务端把
 * 驱动结果放在成功信封的**兄弟位**（`{ ok, data, drive }`，见 `api/client.ts` 的
 * `EnvelopeSiblings`），四种受理命运之外还有 `failed`（指派事务已提交、驱动没起来，
 * 如设备离线）——它**不是任务失败**，但也不能被说成执行开始了。
 *
 * 这里只做两件窄事：认得出的形状才收窄（认不出返回 null，页面据此不说话——
 * 宁可不说，也不替 Hub 编一个「已开始执行」），以及每种命运各给一句如实的话。
 */
import type { AssignmentDriveView } from './api/types.js'

/**
 * 收窄信封兄弟位里的 `drive`。形状来自 Hub 的 `AssignmentDrive`
 * （`apps/hub/src/modules/task/routes.ts`）：受理四态带 `runId`，失败带 `error.code`。
 */
export function parseAssignmentDrive(value: unknown): AssignmentDriveView | null {
  if (typeof value !== 'object' || value === null) return null
  const { outcome } = value as { outcome?: unknown }
  if (outcome === 'failed') {
    const { error } = value as { error?: { code?: unknown; message?: unknown } }
    if (typeof error?.code !== 'string') return null
    return {
      outcome: 'failed',
      error: { code: error.code, message: typeof error.message === 'string' ? error.message : '' },
    }
  }
  if (
    outcome === 'started_run' ||
    outcome === 'followup' ||
    outcome === 'queued' ||
    outcome === 'rejected'
  ) {
    const { runId } = value as { runId?: unknown }
    if (typeof runId !== 'string') return null
    return { outcome, runId }
  }
  return null
}

/**
 * 每种命运一句如实的话（都先说「任务已创建」——那是 201 的唯一事实）。
 *
 * `started_run` 是唯一能说「已自动开始执行」的一档；`queued`（受理了、排着队）与
 * `rejected`（当场拒绝，同 `InstructionComposer` 的「未受理」）各说各话。新建任务
 * 一般只会遇到 `started_run` 与 `failed`，其余三档来自 Hub 的共享受理结果类型
 * （`sendInstruction`）——如实覆盖，不因为它们稀有就混进「已开始执行」。
 */
export function assignmentDriveToast(drive: AssignmentDriveView): string {
  switch (drive.outcome) {
    case 'started_run':
      return '任务已创建，Agent 已自动开始执行'
    case 'followup':
      return '任务已创建，已并入进行中的运行（追问）'
    case 'queued':
      return '任务已创建，执行已受理排队——当前运行开始后放行'
    case 'rejected':
      return '任务已创建，但执行未受理——可在任务执行区重新发起'
    case 'failed':
      return `任务已创建，但自动执行未开始（${drive.error.code}）——可在任务执行区手动发起`
  }
}
