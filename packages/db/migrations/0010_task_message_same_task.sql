-- ========== migration 0010：同 Task 锚点的消息侧镜像（#199） ==========
-- 0005 只在 `run` 表上挂了 `run_trigger_message_same_task_check`
--（`before insert or update of trigger_message_id, task_id`），直接
-- `update task_message set task_id = <别的 Task>` 仍能造出
-- `run.task_id ≠ task_message.task_id` 的坏账（评审 #197 实测）。
-- 本片在消息侧挂镜像触发器：已被 Run 锚定的消息不得搬 Task。
--
-- 设计取舍：
--   * 只拦「被锚定 + 真换 Task」：未被锚定的消息（讨论、未建 Run 的指令）
--     搬 Task 不受影响；同 Task 内 touch（改 body/状态）不触发误伤——
--     触发器条件 `old.task_id is distinct from new.task_id` 保证。
--   * 只读 `run` 表做存在性检查，不写别的表：触发器内无副作用，
--     与 0005 的 fail-closed 口径一致（errcode 23514）。
--   * Run 侧删除/改 Task 走既有 FK 与 0005 触发器，本片不动。
--
-- 回滚路径（与既有 migration 一致：只记 SQL，不写自动化）：
--   drop trigger if exists task_message_same_task_check on task_message;
--   drop function if exists task_message_same_task_check();
-- 注意：回滚后回到 0005 的"尽力而为"口径——消息侧搬 Task 不再被拦。

create or replace function task_message_same_task_check() returns trigger as $$
begin
  if old.task_id is distinct from new.task_id then
    if exists (
      select 1
      from run r
      where r.trigger_message_id = new.id
        and r.task_id <> new.task_id
    ) then
      raise exception 'task_message.task_id must stay on the task of its triggering run'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger task_message_same_task_check
  before update of task_id on task_message
  for each row execute function task_message_same_task_check();
