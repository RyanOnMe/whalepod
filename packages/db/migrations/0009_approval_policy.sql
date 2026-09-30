-- ========== migration 0009：审批档位可配置（#241；ADR-0009 决策 7） ==========
-- approval_policy 两档：approval_required（现状 ask-all，默认）/ full_access
-- （Runtime 对工具调用直接放行，不发 approval.requested——责任人对**自己凭据**
-- 的显式放权，不是成员级权限）。
--
-- 解析链（决策 7 原文）：Revision 默认（非空）→ Task 覆盖（nullable，NULL=继承，
-- 不物化）→ 建 Run 时解析成具体档位写 runs.approval_policy。因此「Revision 更新后
-- Task 跟不跟」有唯一答案：未覆盖的 Task 跟（每次建 Run 重新解析），已覆盖的不跟。
--
-- 口径（ADR-0010 决策 5 已拍板）：**不做**「assignee=Agent 自动触发降级」——
-- ADR-0009 决策 7 原文的降级规则被撤销，触发方式不影响档位。
--
-- 存量回填：既有 revision/task/run 全部落 approval_required——它们运行的年代就是
-- ask-all，回填值与历史行为一致，不是猜测。

create type approval_policy as enum ('approval_required', 'full_access');

alter table agent_profile_revision
  add column approval_policy approval_policy not null default 'approval_required';

alter table task
  add column approval_policy approval_policy;

alter table run
  add column approval_policy approval_policy not null default 'approval_required';
