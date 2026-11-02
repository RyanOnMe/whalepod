-- ADR-0027（PC-05a）：新 Run 的项目上下文快照、Runtime 读取回执与条目级消费。
--
-- 本切片只落正向快照与消费事实；来源撤销状态机、run.context_state、终态 session
-- allowlist 重建/blocked 与 24 小时清理留给 PC-05b（未实现前不视为已交付）。
-- 快照正文是创建事务里的冻结副本；后续新版本/纠正/撤权不修改已冻结内容。

create type run_project_context_status as enum ('frozen', 'partially_unavailable', 'invalidated');
create type run_project_context_entry_kind as enum ('observation', 'decision');
create type run_project_context_entry_status as enum ('frozen', 'retracted', 'source_tombstoned');

create table run_project_context (
  id uuid primary key,
  run_id uuid not null unique references run (id),
  project_id uuid not null references project (id),
  selection_rule_version varchar(64) not null,
  snapshot_digest char(64) not null,
  header_text text not null,
  header_digest char(64) not null,
  entry_count integer not null,
  total_bytes integer not null,
  unselected jsonb not null default '[]'::jsonb,
  -- 超出逐条明细上限（128）的未纳入项，按原因聚合计数；与 unselected 合计才是全量。
  unselected_omitted jsonb not null default '{}'::jsonb,
  override_reason varchar(1000),
  status run_project_context_status not null default 'frozen',
  delivered_at timestamptz,
  consumed_at timestamptz,
  consumed_all_at timestamptz,
  created_at timestamptz not null default now(),
  constraint run_project_context_digest check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  constraint run_project_context_header_digest check (header_digest ~ '^[a-f0-9]{64}$'),
  constraint run_project_context_header_length check (
    char_length(header_text) between 1 and 4000
  ),
  constraint run_project_context_entry_count check (entry_count between 0 and 32),
  constraint run_project_context_total_bytes check (total_bytes between 0 and 262144),
  constraint run_project_context_unselected_array check (
    jsonb_typeof(unselected) = 'array' and octet_length(unselected::text) <= 16384
  ),
  constraint run_project_context_unselected_omitted_object check (
    jsonb_typeof(unselected_omitted) = 'object'
  ),
  constraint run_project_context_consumed_order check (
    consumed_all_at is null or consumed_at is not null
  )
);

create index run_project_context_project_created_idx
  on run_project_context (project_id, created_at desc, id);

create table run_project_context_entry (
  snapshot_id uuid not null references run_project_context (id),
  entry_id uuid not null,
  entry_version varchar(200) not null,
  kind run_project_context_entry_kind not null,
  citation context_citation_kind not null,
  source_id uuid,
  revision_id uuid,
  thread_id uuid,
  business_ref varchar(300),
  authorization_generation varchar(128),
  digest char(64) not null,
  byte_size integer not null,
  title varchar(200) not null,
  body text not null default '',
  entry_status run_project_context_entry_status not null default 'frozen',
  status_reason varchar(500),
  permission_state_at_selection varchar(64) not null default 'authorized',
  identity_unverified boolean not null default false,
  selected_by_member_id uuid references user_account (id),
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (snapshot_id, entry_id),
  constraint run_project_context_entry_version check (length(btrim(entry_version)) between 1 and 200),
  constraint run_project_context_entry_digest check (digest ~ '^[a-f0-9]{64}$'),
  constraint run_project_context_entry_size check (
    byte_size between 0 and 65536 and byte_size = octet_length(body) and octet_length(body) <= 65536
  ),
  constraint run_project_context_entry_title check (length(btrim(title)) between 1 and 200),
  constraint run_project_context_entry_read_after_delivery check (
    read_at is null or delivered_at is not null
  ),
  constraint run_project_context_entry_decision_fields check (
    kind <> 'decision'
    or (business_ref is not null and authorization_generation is null and revision_id is null)
  ),
  constraint run_project_context_entry_observation_fields check (
    kind <> 'observation'
    or (
      (business_ref is not null and revision_id is null and authorization_generation is null)
      or (business_ref is null and revision_id is not null and authorization_generation is not null)
    )
  ),
  constraint run_project_context_entry_status_reason check (
    (entry_status = 'frozen' and status_reason is null)
    or (entry_status <> 'frozen' and status_reason is not null)
  )
);

create index run_project_context_entry_entry_idx
  on run_project_context_entry (entry_id);

create table run_context_receipt (
  id uuid primary key,
  run_id uuid not null references run (id),
  snapshot_id uuid not null references run_project_context (id),
  receipt_seq integer not null,
  header_digest char(64) not null,
  nonce_matched boolean not null,
  entries_delivered jsonb not null,
  entries_read jsonb not null,
  read_events jsonb not null,
  missing jsonb not null,
  digest_verified boolean not null,
  at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (run_id, snapshot_id, receipt_seq),
  constraint run_context_receipt_seq check (receipt_seq >= 1),
  constraint run_context_receipt_header_digest check (header_digest ~ '^[a-f0-9]{64}$'),
  constraint run_context_receipt_arrays check (
    jsonb_typeof(entries_delivered) = 'array'
    and jsonb_typeof(entries_read) = 'array'
    and jsonb_typeof(read_events) = 'array'
    and jsonb_typeof(missing) = 'array'
  ),
  constraint run_context_receipt_size check (
    octet_length(entries_delivered::text) <= 8192
    and octet_length(entries_read::text) <= 8192
    and octet_length(read_events::text) <= 16384
    and octet_length(missing::text) <= 8192
  )
);

create table run_context_consumption (
  snapshot_id uuid not null,
  entry_id uuid not null,
  thread_id uuid,
  run_id uuid not null references run (id),
  read_at timestamptz not null,
  primary key (snapshot_id, entry_id),
  constraint run_context_consumption_snapshot_entry_fk
    foreign key (snapshot_id, entry_id)
    references run_project_context_entry (snapshot_id, entry_id)
);

-- ADR-0027 §3：预派发复核只对「从未成功发出」的 run.start 生效。成功写入 Node 后
-- 落 sent_at；ack 丢失后的同 commandId 重投是同一冻结快照的重复投递，不得因期间
-- 来源变化把已在执行的 Run 误判失败。
alter table dispatch_outbox add column sent_at timestamptz;
