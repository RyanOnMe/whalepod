-- ADR-0028 §17.1/§17.3（RD-03d3）：机器 Run 终态后的边界复核队列。
--
-- Run 终态事务只落一条 pending 标记（不改 Run 快照、不在 Run 事务里调用模型）；
-- Router tick 在受控后续事务里复核 work/Task/Mandate/活跃 Run，再把该 Run 的
-- 可去重触发代次（run-terminal:<runId>）交给既有评估端口。同一 Run 至多一条，
-- 重复终态收敛/重启恢复都靠 run_id 唯一性去重。

create table work_run_boundary (
  id uuid primary key,
  project_id uuid not null references project (id),
  work_id uuid not null references work (id),
  task_id uuid not null references task (id),
  work_key varchar(64) not null,
  run_id uuid not null references run (id),
  principal_user_id uuid not null references user_account (id),
  status varchar(16) not null default 'pending',
  trigger_key varchar(200) not null,
  evaluation_id uuid references coordination_evaluation (id),
  reason varchar(64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_run_boundary_status check (status in ('pending', 'enqueued', 'skipped')),
  constraint work_run_boundary_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint work_run_boundary_trigger_length check (
    length(btrim(trigger_key)) between 1 and 200
  ),
  constraint work_run_boundary_reason check (
    reason is null or (reason ~ '^[a-z][a-z0-9_]*$' and length(reason) <= 64)
  ),
  constraint work_run_boundary_status_fields check (
    (status = 'pending' and evaluation_id is null and reason is null)
    or (status = 'enqueued' and evaluation_id is not null and reason is null)
    or (status = 'skipped' and evaluation_id is null and reason is not null)
  )
);

-- 每个机器 Run 只复评一次；后续 Run 由下一次终态产生新的边界标记。
create unique index work_run_boundary_run_unique on work_run_boundary (run_id);
create index work_run_boundary_status_created_idx
  on work_run_boundary (status, created_at, id);
