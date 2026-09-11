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

-- 既有约束名随表名过时，一并改名（本仓约束名要能直接读出归属）。
alter table task_message rename constraint task_comment_body_length to task_message_body_length;

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
  add constraint task_message_followup_attached check (kind <> 'followup' or run_id is not null);

-- 线程读取按 (task_id, created_at) 走；原表没有这个索引。
create index task_message_task_created_idx on task_message (task_id, created_at);
