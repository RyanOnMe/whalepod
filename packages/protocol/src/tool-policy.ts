/**
 * ADR-0028 §7（RD-03c1）：机器 Run 的固定草稿工具面与 Mandate 步级预批准契约。
 *
 * 只传工具名与 Mandate 版本，不传正文、路径或凭据；Node/Runtime 原样透传。
 * 面外工具不是“走审批”，而是 Runtime pre-execute 直接 deny。
 */
import { z } from 'zod'

/** Mandate 可选的草稿工具名（与 `WORK_DRAFT_TOOL_NAMES` 同集）。 */
export const DRAFT_TOOL_ALLOWLIST_NAMES = ['read', 'write', 'edit', 'glob', 'grep'] as const
export const DraftToolAllowlistNameSchema = z.enum(DRAFT_TOOL_ALLOWLIST_NAMES)
export type DraftToolAllowlistName = z.infer<typeof DraftToolAllowlistNameSchema>

/**
 * 机器 Run 的固定面：五个文件工具 + 结果/授权读取通道。后三者隐式允许，
 * 不进入 Mandate allowlist（它们只读取已授权材料或登记私有草稿候选）。
 */
export const MACHINE_DRAFT_TOOL_SURFACE = [
  ...DRAFT_TOOL_ALLOWLIST_NAMES,
  'publish_artifact',
  'read_work_input',
  'read_project_context',
] as const
export type MachineDraftToolName = (typeof MACHINE_DRAFT_TOOL_SURFACE)[number]

/** 隐式允许的读取/结果通道；不在 Mandate allowlist 里重复声明。 */
export const IMPLICIT_MACHINE_DRAFT_TOOLS = [
  'publish_artifact',
  'read_work_input',
  'read_project_context',
] as const
export type ImplicitMachineDraftToolName = (typeof IMPLICIT_MACHINE_DRAFT_TOOLS)[number]

export const RunToolPolicySchema = z.strictObject({
  mode: z.literal('draft'),
  allowedToolNames: z.array(DraftToolAllowlistNameSchema).max(16),
  mandateVersion: z.number().int().positive(),
  workKey: z.uuid(),
})
export type RunToolPolicy = z.infer<typeof RunToolPolicySchema>
