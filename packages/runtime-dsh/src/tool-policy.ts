/**
 * ADR-0028 §7（RD-03c1）：机器 Run 的固定草稿工具面裁决。
 *
 * 纯函数，便于单测逐名覆盖；SessionOwner 在 `tools/pre-execute` 里调用。
 * 返回 undefined = 无机器策略，交回既有 approval_required/full_access 语义。
 */
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import {
  IMPLICIT_MACHINE_DRAFT_TOOLS,
  MACHINE_DRAFT_TOOL_SURFACE,
  type RunToolPolicy,
} from '@whalepod/protocol'

const SURFACE = new Set<string>(MACHINE_DRAFT_TOOL_SURFACE)
const IMPLICIT = new Set<string>(IMPLICIT_MACHINE_DRAFT_TOOLS)

export function machineDraftToolDecision(
  policy: RunToolPolicy | undefined,
  toolName: string,
): PreToolDecision | undefined {
  if (policy === undefined) return undefined
  if (!SURFACE.has(toolName)) {
    return {
      kind: 'deny',
      reason: `tool "${toolName}" is outside the draft tool surface`,
    }
  }
  if (IMPLICIT.has(toolName)) return { kind: 'allow' }
  if (policy.allowedToolNames.some((allowed) => allowed === toolName)) {
    return { kind: 'allow' }
  }
  return {
    kind: 'ask',
    reason: `Run tool call is outside the Mandate allowlist: ${toolName}`,
  }
}
