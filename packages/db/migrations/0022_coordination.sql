-- ADR-0026（PC-04a）：确定性内部协调。
--
-- 本切片只落 queued→completed/skipped 与 failed 的持久面；dispatched/running/cancelled/stale
-- 的枚举先于模型/Node 路径存在，避免后续迁移改类型。协调计算不是 Run，输入与结果都不含
-- 正文副本（正文仍在 context_entry，inference 通过 citation 引用业务事实）。

create type coordination_evaluation_status as enum (
  'queued',
  'dispatched',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'stale'
);

create table coordination_evaluation (
  id uuid primary key,
  project_id uuid not null references project (id),
  status coordination_evaluation_status not null default 'queued',
  attempt integer not null default 1,
  input_digest char(64) not null,
  input_manifest jsonb not null default '{}'::jsonb,
  manifest_version integer not null default 1,
  rules_version varchar(64) not null,
  processor_version varchar(64) not null,
  queued_at timestamptz not null default now(),
  queue_expires_at timestamptz not null,
  coalesced_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  failure_code varchar(64),
  failure_summary varchar(1000),
  result_digest char(64),
  inference_entry_id uuid references context_entry (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coordination_evaluation_attempt check (attempt >= 1),
  constraint coordination_evaluation_manifest_object check (
    jsonb_typeof(input_manifest) = 'object'
  ),
  constraint coordination_evaluation_manifest_size check (
    octet_length(input_manifest::text) <= 65536
  ),
  constraint coordination_evaluation_queued_fields check (
    status <> 'queued' or (queued_at is not null and queue_expires_at is not null)
  ),
  constraint coordination_evaluation_terminal_fields check (
    status not in ('completed', 'failed', 'cancelled', 'skipped', 'stale')
    or finished_at is not null
  ),
  constraint coordination_evaluation_completed_fields check (
    status <> 'completed'
    or (result_digest is not null and inference_entry_id is not null)
  )
);

-- 同项目同输入同 attempt 唯一（ADR-0026 §3）。
create unique index coordination_evaluation_input_attempt_unique
  on coordination_evaluation (project_id, input_digest, attempt);
-- 同项目至多一条 queued：所有相关变化先合并到这一条。
create unique index coordination_evaluation_one_queued
  on coordination_evaluation (project_id)
  where status = 'queued';
-- 同输入只允许一条 completed：结果复用，不重复提醒。
create unique index coordination_evaluation_one_completed_per_input
  on coordination_evaluation (project_id, input_digest)
  where status = 'completed';
-- sweeper/读面按项目与时间取最近评估。
create index coordination_evaluation_project_created_idx
  on coordination_evaluation (project_id, created_at desc, id);

create table project_coordinator_state (
  project_id uuid primary key references project (id),
  -- PC-04a：只表示确定性协调可用；模型协调仍需 ADR-0026 §1 的显式配置。
  enabled boolean not null default true,
  rules_version varchar(64) not null,
  processor_version varchar(64) not null,
  last_successful_evaluation_id uuid references coordination_evaluation (id),
  paused_at timestamptz,
  pause_reason varchar(500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_coordinator_state_paused check (
    (paused_at is null) = (pause_reason is null)
  )
);

-- 一条评估只产生一条 Inference；评估 id 是协调输出的幂等键。
create unique index context_entry_inference_evaluation_unique
  on context_entry (evaluation_id)
  where kind = 'inference';
