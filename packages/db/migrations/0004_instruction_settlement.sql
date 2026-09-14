-- ========== migration 0004：指令受理结算落账（#186；ADR-0009 决策 3/5） ==========
-- 两件事，都是「Hub 侧把受理结果记成可审计事实」所必需的：
--
-- 1) `task_message` 记拒绝理由。`instruction_state='rejected'` 必须能回答「为什么」——
--    team_event 只有 24 小时保留窗口（03 §5），靠事件承载理由会在一天后丢失，
--    而「我的指令被拒了，理由是什么」是长期问题。故理由与状态同列存放。
-- 2) `dispatch_outbox` 记 `message_id`。followup 的 ack 只能凭 commandId 回来，而 wire 帧
--    载荷**固定**是 `{runId, text}`（`node-wire` 契约，不能塞 Hub 内部字段）——commandId →
--    消息的映射只能落在 Hub 自己的 outbox 行上。指令起 Run 的情形不需要这列：那条链的锚点
--    是 `run.trigger_message_id`（切片③c）。

alter table task_message
  add column instruction_error_code text,
  add column instruction_error_message text;

-- 理由只在被拒时有意义：受理成功却带着拒绝理由，是自相矛盾的账（审计读不出来）。
alter table task_message
  add constraint task_message_error_only_when_rejected check (
    instruction_state = 'rejected'
    or (instruction_error_code is null and instruction_error_message is null)
  );

alter table dispatch_outbox
  add column message_id uuid references task_message (id);

-- 目前只有 followup 命令带 message_id（指令起 Run 走 run.trigger_message_id）。
-- 收紧成硬约束，避免将来有人往里塞无关命令的关联而无人察觉。
alter table dispatch_outbox
  add constraint dispatch_outbox_message_only_for_followup check (
    message_id is null or type = 'run.followup'
  );
