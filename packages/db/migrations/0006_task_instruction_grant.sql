-- ========== migration 0006：指令权授权（#198；ADR-0009 决策 4） ==========
-- ADR-0009 决策 4 要求「Task 责任人 + 被授权成员」都能驱动 Agent，但代码里此前把「只有责任人」
-- 硬编码在三处（建 Run / 追问 / 目标解析）。本表是那条决策的落点。
--
-- 边界（写在这里，免得后来人扩大解释）：
--   * 授权**只**作用于执行区（发指令、起 Run、排队追问）；
--   * 讨论区不受本表影响——任何成员的评论都不需要授权（ADR-0010 决策 1/4）；
--   * 审批决定权**不可授予**，永远只属于责任人（`decide_approval` 只看 run.owner_user_id）；
--   * Run 归属永远是责任人：`run.owner_user_id = task.assignee_user_id`，设备/凭据/工作区都是他的。
--     被授权成员只是"能开口"，不是"换个人跑"。

create table task_instruction_grant (
  id uuid primary key,
  task_id uuid not null references task (id) on delete cascade,
  -- 被授权人：能往这个 Task 的执行区发指令的成员。
  user_id uuid not null references user_account (id) on delete cascade,
  -- 谁授的（审计要能回答）：只有责任人能授，故这里必然是责任人。
  granted_by uuid not null references user_account (id),
  created_at timestamptz not null default now(),
  -- 一个人对一个 Task 只有一条授权：重复授予是幂等操作，不该长出第二行。
  constraint task_instruction_grant_unique unique (task_id, user_id)
);

-- 守卫按 (task_id, user_id) 点查，这是热路径。
create index task_instruction_grant_lookup_idx on task_instruction_grant (task_id, user_id);

-- 撤回一条指令（#198 的判据 3「撤销后立刻失效」）：
-- 直接 delete 该行即可——没有缓存，守卫每次都点查本表，所以"立刻"是真的立刻。
-- （不引入 deleted_at：授权不是账，是状态；谁何时授予/撤销的历史由 team_event 承载。）
--
-- 回滚路径：
--   drop table if exists task_instruction_grant;
-- 回滚后果：所有被授权成员立刻失去驱动权（授权名单丢失）。若要保留名单，先导出
--   select task_id, user_id, granted_by from task_instruction_grant;
