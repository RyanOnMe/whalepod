-- ADR-0027 §6（PC-05b，Issue #498）：撤权状态机水位与 Node 应用回执。
--
-- state_version = 0 表示升级前的旧快照尚未派生；首次派生从 1 开始，之后只在
-- stateDigest 变化时递增。state_digest 与 state_version 必须同时为空/非空。

alter table run_project_context
  add column state_version integer not null default 0,
  add column state_digest char(64),
  add column state_updated_at timestamptz;

alter table run_project_context
  add constraint run_project_context_state_version check (
    state_version >= 0
    and (
      (state_version = 0 and state_digest is null)
      or (state_version > 0 and state_digest is not null)
    )
  ),
  add constraint run_project_context_state_digest check (
    state_digest is null or state_digest ~ '^[a-f0-9]{64}$'
  );

create table run_context_state_ack (
  id uuid primary key,
  run_id uuid not null references run (id),
  snapshot_id uuid not null references run_project_context (id),
  device_id uuid not null references device (id),
  state_version integer not null,
  state_digest char(64) not null,
  applied_at timestamptz not null,
  failed_entry_ids jsonb not null default '[]',
  received_at timestamptz not null default now(),
  constraint run_context_state_ack_version check (state_version >= 1),
  constraint run_context_state_ack_digest check (state_digest ~ '^[a-f0-9]{64}$'),
  constraint run_context_state_ack_failed_array check (
    jsonb_typeof(failed_entry_ids) = 'array'
    and octet_length(failed_entry_ids::text) <= 8192
  )
);

create unique index run_context_state_ack_version_unique
  on run_context_state_ack (run_id, snapshot_id, device_id, state_version);
create index run_context_state_ack_run_idx
  on run_context_state_ack (run_id, state_version desc);
