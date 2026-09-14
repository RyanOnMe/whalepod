-- ========== migration 0005：指令起 Run 的锚点（#196；ADR-0009 决策 3 + ADR-0010） ==========
-- 0004 的注释已经预告过这条链：「指令起 Run 不用 `dispatch_outbox.message_id`，那条链的锚点是
-- `run.trigger_message_id`」。本片落地它。
--
-- 为什么必须有这个锚点：执行区的一句指令在「无活跃 Run」时会**建 Run**，而 run.start 的 ack
-- 就是这个 Run 的命运（accepted / rejected）。要把 ack 的结果写回**那条指令**的
-- `instruction_state`，Hub 必须能从 Run 反查触发它的消息——wire 帧载荷固定（`{commandId,
-- runId, …}`），不可能夹带消息 id，所以映射只能落在 Hub 自己的 runs 行上。
--
-- 与 followup 的区别（两个锚点各管一条链，别混）：
--   * 指令起 Run  → `runs.trigger_message_id` → 该消息（本片）
--   * 追问既有 Run → `dispatch_outbox.message_id` → 该消息（0004）

alter table run
  add column trigger_message_id uuid references task_message (id);

-- 一条消息最多触发一个 Run（否则 ack 无法唯一回写）；反过来一个 Run 最多有一个触发消息。
-- 部分唯一索引（仅对非空值生效）：显式创建的 Run 没有触发消息，不受约束。
create unique index run_trigger_message_unique
  on run (trigger_message_id)
  where trigger_message_id is not null;

-- 触发消息必须与 Run 属于同一个 Task：跨 Task 的锚点是坏账（审计读不出来，UI 也会指错地方）。
-- 用触发器而不是 check——check 不能跨表查询。
create or replace function run_trigger_message_same_task() returns trigger as $$
begin
  if new.trigger_message_id is not null then
    if not exists (
      select 1
      from task_message m
      where m.id = new.trigger_message_id
        and m.task_id = new.task_id
    ) then
      raise exception 'run.trigger_message_id must reference a message of the same task'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger run_trigger_message_same_task_check
  before insert or update of trigger_message_id, task_id on run
  for each row execute function run_trigger_message_same_task();

-- 回滚路径（与既有 migration 一致：只记 SQL，不写自动化）：
--   drop trigger if exists run_trigger_message_same_task_check on run;
--   drop function if exists run_trigger_message_same_task();
--   drop index if exists run_trigger_message_unique;
--   alter table run drop column if exists trigger_message_id;
-- 注意：回滚会丢掉「哪条指令触发了哪个 Run」的锚点——已由指令起的 Run 会变成"无主的 Run"
--（run 行本身与其事件仍完整）。如需长期保留审计关系，请先导出
-- `select id, trigger_message_id from run where trigger_message_id is not null`。
