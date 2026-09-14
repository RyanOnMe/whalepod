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
  -- 谁授的。on delete cascade：授与人被删除时这条授权随之消失（不该留下无主的授权）。
  -- 不写行为会落到默认 NO ACTION，删用户时被 23503 卡住（评审应改 4）。
  granted_by uuid not null references user_account (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- 一个人对一个 Task 只有一条授权：重复授予是幂等操作，不该长出第二行。
  constraint task_instruction_grant_unique unique (task_id, user_id)
);

-- 守卫的点查（task_id, user_id）**不需要额外索引**：上面的 unique 约束已经建了列序完全相同的
-- 唯一 btree 索引，再建一个只是写放大（评审应改 3 实测两条 indexdef 逐字一致）。

-- 「只有责任人能授」不能只写在注释里（评审应改 5）：granted_by 可以是任意用户。
-- 与 0005 守跨表不变量同一风格——用触发器把这条不变量钉在库上，而不是指望命令层自觉。
create or replace function task_instruction_grant_by_assignee() returns trigger as $$
begin
  if not exists (
    select 1 from task t
    where t.id = new.task_id and t.assignee_user_id = new.granted_by
  ) then
    raise exception 'task_instruction_grant.granted_by must be the task assignee'
      using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- 覆盖 INSERT **和 UPDATE**：只挂 insert 的话，`update task_instruction_grant set granted_by = <非责任人>`
-- 能成功落地（评审复核实测），于是"granted_by 必须是责任人"这条不变量只守住了一半。
create trigger task_instruction_grant_by_assignee_check
  before insert or update of granted_by, task_id on task_instruction_grant
  for each row execute function task_instruction_grant_by_assignee();

-- 改派语义（评审复核发现的第二个缺口，这里**明确写死**当前行为，别留给读者猜）：
--   Task 改派给新责任人时，**保留**既有授权名单（新责任人接手的是同一批协作者，撤销名单会把
--   正在推进的工作打断）；但 `granted_by` 的含义随之是"**当时的**责任人"，不再等于现任责任人。
--   要收走名单就显式撤销（`revokeInstruction`），或由新责任人自己重授。
--   若将来产品决定"改派即清空授权"，改成 after update 触发器删行即可——这是**产品决定**，
--   不是实现细节，改之前先写 ADR/决策记录。

-- 撤回一条指令（#198 的判据 3「撤销后立刻失效」）：
-- 直接 delete 该行即可——没有缓存，守卫每次都点查本表，所以"立刻"是真的立刻。
-- （不引入 deleted_at：授权不是账，是状态；谁何时授予/撤销的历史由 team_event 承载。）
--
-- 回滚路径：
--   drop trigger if exists task_instruction_grant_by_assignee_check on task_instruction_grant;
--   drop function if exists task_instruction_grant_by_assignee();
--   drop table if exists task_instruction_grant;
-- 回滚后果：所有被授权成员立刻失去驱动权（授权名单丢失）。若要保留名单，先导出
--   select task_id, user_id, granted_by from task_instruction_grant;
