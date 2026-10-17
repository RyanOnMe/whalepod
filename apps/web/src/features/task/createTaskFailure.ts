/**
 * 创建任务失败的**人话与引导**（#348）：Hub 的 4xx 分类消息（英文、面向开发者）不是
 * 用户能行动的东西。两类**候选失效**由服务端兜底拒绝（400 `VALIDATION_FAILED`）：
 * 责任人在表单开着时被停用、执行 Agent 在期间被归档——这里把它们翻成中文并指出下一步。
 *
 * 与「提交前显式阻塞」（`selection-unavailable-hint`）的关系：正常时序下失效会经
 * `member.changed` 重拉在**提交前**被拦住（#345 F2/F9）；本文案覆盖**竞态残窗**——
 * 名册还没刷新完用户已点了提交，由服务端拒绝后告诉用户为什么、接着该做什么。
 * 语义与 #344/#345 一致：**绝不自动换人**，只引导重选。
 *
 * 只翻已知的两类；**其余失败返回 null**（不编造原因，走通用 ErrorBanner 原样展示）。
 */
import { isApiError } from '../../shared/api/errors.js'

/** Hub 侧的两条分类消息原文（apps/hub/src/modules/task/commands.ts 的 wire 面）。 */
const ASSIGNEE_UNAVAILABLE = 'assignee is not an active team member'
const AGENT_UNAVAILABLE = 'assignee agent not found or archived'

export function createTaskFailureCopy(error: unknown): string | null {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return null
  if (error.message.includes(ASSIGNEE_UNAVAILABLE)) {
    return '所选责任人已不可用（可能刚被停用）——请重新选择责任人后再创建；不会自动换人。'
  }
  if (error.message.includes(AGENT_UNAVAILABLE)) {
    return '所选执行 Agent 已不可用（可能刚被归档）——请重新选择 Agent 后再创建；不会自动换人。'
  }
  return null
}
