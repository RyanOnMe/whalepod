/**
 * Run 的任务约定绑定解析（#378；ADR-0017 §2）。
 *
 * 规则（单一收口点，所有创建入口经 orchestrator 到这里）：
 * - 显式传入 `specRevisionId`：必须是**本 Task** 的**已确认**版本；草稿版本一律拒绝
 *   （草稿不构成要求）；辅助 Run 显式传入同样校验并绑定（审计完整）。
 * - 缺省：Task 启用约定且本次是业务 Run → 绑定「创建时刻的最新已确认版本」；
 *   启用但尚无已确认版本 → AGREEMENT_REQUIRED（明确拒绝并引导先确认）。
 * - Task 未启用约定 / 辅助 Run：返回 null（未绑定），历史与普通任务语义不变。
 * - 重跑/续跑与新执行同规则：不自动继承来源绑定（「新版本不修改已有 Run」，新 Run
 *   采用当前已确认版本；要继承来源版本由调用方显式传来源的 specRevisionId）。
 */
import { isHelperRunPurpose } from '@whalepod/domain'
import type { TaskRow, TaskSpecRevisionRow, Tx } from '@whalepod/db'
import { getLatestConfirmedSpec, getSpecRevision } from '@whalepod/db'
import { RunCommandError } from './errors.js'

export interface SpecBindingInput {
  specRevisionId?: string
  purpose?: 'business' | 'agreement_draft' | 'handoff_draft'
}

export async function resolveSpecBinding(
  tx: Tx,
  task: TaskRow,
  input: SpecBindingInput,
): Promise<TaskSpecRevisionRow | null> {
  if (input.specRevisionId !== undefined) {
    // UUID 路由拼写不改变持久身份（与 artifactInputIds 同口径）。
    const revision = await getSpecRevision(tx, input.specRevisionId.toLowerCase())
    if (revision === undefined || revision.taskId !== task.id) {
      throw new RunCommandError('NOT_FOUND', '所选任务约定版本不在本任务中')
    }
    if (revision.status !== 'confirmed') {
      throw new RunCommandError(
        'CONFLICT',
        '约定的草稿版本不能作为执行依据；请先由责任人确认后再执行',
      )
    }
    return revision
  }
  if (!task.agreementEnabled || isHelperRunPurpose(input.purpose)) return null
  const latest = await getLatestConfirmedSpec(tx, task.id)
  if (latest === undefined) {
    throw new RunCommandError(
      'AGREEMENT_REQUIRED',
      '任务已启用约定流程：请先确认任务约定的第一个版本，再开始执行',
    )
  }
  return latest
}
