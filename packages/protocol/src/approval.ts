/**
 * 审批档位（ADR-0009 决策 7，切片⑧ #241）：一个 Run 内工具调用的授权姿态。
 *
 * - `approval_required`（默认，现状语义）：每次工具调用回 Node 拿一次性批准
 *   （`PreToolDecision.kind='ask'` → approval.requested → 责任人决定）；
 * - `full_access`（显式放权）：Runtime 直接放行（`kind='allow'`），不发 approval.requested。
 *   这是责任人对自己凭据的放权：由 Task 责任人设置（Revision 默认 → Task 覆盖 →
 *   建 Run 时解析固化进 `runs.approval_policy`），不是成员级权限。
 *
 * 口径（ADR-0010 决策 5，2026-09-11 拍板）：**不做**「自动触发降级」——触发方式
 * （人点 / 指派自动）不影响档位；ADR-0009 决策 7 原文的降级规则已被该决策撤销。
 *
 * wire/http 上该字段**可选**：缺省语义 = `approval_required`（旧节点/旧 Runtime 的
 * 行为不变，fixture 向后兼容）。
 */
import { z } from 'zod'

export const ApprovalPolicySchema = z.enum(['approval_required', 'full_access'])

export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>
