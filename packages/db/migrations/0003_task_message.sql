-- ========== migration 0003：task_comment → task_message（#185；ADR-0009 决策 2） ==========
-- 对话式执行把「线程消息」变成审计锚点：讨论 / 指令 / 追问同住一张表，靠 kind 区分；
-- 指令额外记录被驱动的 Agent（target_agent_id）、触发的 Run（run_id）与受理状态
-- （instruction_state）。
--
-- 触发者就是 author_user_id：**不另设 triggered_by 列**（同一事实两列必然漂移）。
-- assignee = Agent 的自动指令记 origin='auto_assignment'，author_user_id 填做出该次指派
-- 的人——审计问「谁让它跑的」永远有答案。
--
-- 这是同一张表的升级（不是并列两张）：改名 + 补列，既有行按默认值成为讨论消息。

alter table task_comment rename to task_message;

-- 既有约束名随表名过时，**一并**改名（本仓约束名要能直接读出归属；rename table 不会
-- 自动改这些名字，评审实测残留 8 个对象 + 1 个索引）。PG 里 not-null 约束也是 pg_constraint
-- 条目，可以 rename；改主键**约束**名会连带把它的索引一起改名，所以不要再 alter index。
alter table task_message rename constraint task_comment_body_length to task_message_body_length;
alter table task_message rename constraint task_comment_pkey to task_message_pkey;
alter table task_message rename constraint task_comment_task_id_fkey to task_message_task_id_fkey;
alter table task_message
  rename constraint task_comment_author_user_id_fkey to task_message_author_user_id_fkey;
alter table task_message rename constraint task_comment_id_not_null to task_message_id_not_null;
alter table task_message rename constraint task_comment_task_id_not_null to task_message_task_id_not_null;
alter table task_message
  rename constraint task_comment_author_user_id_not_null to task_message_author_user_id_not_null;
alter table task_message rename constraint task_comment_body_not_null to task_message_body_not_null;
alter table task_message
  rename constraint task_comment_created_at_not_null to task_message_created_at_not_null;

alter table task_message
  add column kind text not null default 'discussion',
  add column origin text not null default 'human',
  add column target_agent_id uuid references agent (id),
  add column run_id uuid references run (id),
  add column instruction_state text;

alter table task_message
  add constraint task_message_kind_valid check (kind in ('discussion', 'instruction', 'followup')),
  add constraint task_message_origin_valid check (origin in ('human', 'auto_assignment')),
  add constraint task_message_state_valid check (
    instruction_state is null or instruction_state in ('pending', 'accepted', 'rejected')
  ),
  -- 「默认不驱动」是产品红线（ADR-0009 决策 3）：讨论消息不得携带目标 Agent / Run /
  -- 受理状态——否则一句闲聊可能悄悄进了某个 Agent 的上下文。
  add constraint task_message_discussion_inert check (
    kind <> 'discussion'
    or (target_agent_id is null and run_id is null and instruction_state is null)
  ),
  -- 指令与追问必须指向一个 Agent 且带受理状态（受理即落账，不留「已受理、零痕迹」）。
  add constraint task_message_instruction_addressed check (
    kind = 'discussion'
    or (target_agent_id is not null and instruction_state is not null)
  ),
  -- 追问挂在**既有** Run 上（它就是那次执行里的继续说话）；指令建 Run 前 run_id 可空。
  add constraint task_message_followup_attached check (kind <> 'followup' or run_id is not null),
  -- 但「受理成功」必然落到了某个 Run 上：accepted 而没有 run_id 就是 ADR-0009 决策 3 明令
  -- 禁止的「已受理、零痕迹」（评审实测原先可以入库）。pending / rejected 都允许没有 run_id
  -- ——`rejected(run_terminal)` 本来就挂在既有 Run 上，`pending` 则还没建 Run。
  add constraint task_message_accepted_has_run check (
    instruction_state <> 'accepted' or run_id is not null
  );

-- 线程读取按 (task_id, created_at) 走；原表没有这个索引。
create index task_message_task_created_idx on task_message (task_id, created_at);

-- ========== 回滚路径（ADR-0009 要求这次表结构升级保留） ==========
-- 本仓迁移是 forward-only（`_schema_migrations` 台账只前进；裸重跑 0003 会以 42P01 失败——
-- 与 0001/0002 同形）。要回退这张表，**先备份**，再执行反向 SQL：
--
--   alter table task_message drop constraint task_message_accepted_has_run;
--   ...（其余新约束同名 drop）...
--   alter table task_message drop column kind, drop column origin,
--     drop column target_agent_id, drop column run_id, drop column instruction_state;
--   drop index task_message_task_created_idx;
--   ...（约束名改回 task_comment_*；主键约束改名会连带改回索引名）...
--   alter table task_message rename to task_comment;
--
-- 反向 SQL 不随仓库发（避免被当成 down-migration 自动执行）；需要时按上面骨架现场写，
-- 并用 pg_constraint / pg_indexes 与迁移前快照逐名核对。
