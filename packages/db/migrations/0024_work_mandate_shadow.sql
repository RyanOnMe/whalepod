-- ADR-0028（RD-01）：持续工作身份、Mandate 与影子准入。
--
-- 本切片只落协调元数据：work/work_mandate/router_decision，以及只允许落到
-- proposed/rejected/expired/cancelled 的 dispatch_intent。不创建 Run、不写
-- Decision/Correction/Artifact/TeamEvent 业务事实，也不调用模型。
--
-- 正文、目标与成果仍以 Task/Run/ADR-0025 账本为准；这些表只存引用与摘要。

create type work_state as enum ('active', 'waiting', 'retired');
create type work_resume_mode as enum ('auto', 'owner_confirmation');

create table work (
  id uuid primary key,
  project_id uuid not null references project (id),
  task_id uuid not null references task (id),
  -- ADR-0028 §2：小写 workKey 由 Hub 生成的 uuid 字符串承载；不派生自 Task/Run。
  work_key varchar(64) not null,
  human_owner_user_id uuid not null references user_account (id),
  goal varchar(1000) not null,
  state work_state not null default 'active',
  resume_mode work_resume_mode,
  resume_condition varchar(500),
  mandate_id uuid,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_goal_length check (length(btrim(goal)) between 1 and 1000),
  constraint work_key_format check (work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint work_state_fields check (
    (state = 'active' and resume_mode is null and resume_condition is null and retired_at is null)
    or (state = 'waiting' and resume_mode is not null and resume_condition is not null and retired_at is null)
    or (state = 'retired' and retired_at is not null)
  )
);

-- ADR-0028 §2：一个 Task 至多一份未退休工作；retired 保留历史。
create unique index work_task_current_unique
  on work (task_id)
  where state <> 'retired';
create unique index work_work_key_unique on work (work_key);
create index work_project_created_idx on work (project_id, created_at desc, id);
create index work_owner_created_idx on work (human_owner_user_id, created_at desc, id);

create type work_mandate_status as enum (
  'draft',
  'active',
  'paused',
  'revoked',
  'expired',
  'superseded'
);
create type work_auto_dispatch as enum ('off', 'existing_task');

create table work_mandate (
  id uuid primary key,
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  project_id uuid not null references project (id),
  task_id uuid not null references task (id),
  version integer not null,
  status work_mandate_status not null,
  -- ADR-0028 §6/§7：本 ADR 内四个身份字段必须是同一名成员，且该成员是 Task assignee。
  principal_user_id uuid not null references user_account (id),
  on_behalf_of_user_id uuid not null references user_account (id),
  human_owner_user_id uuid not null references user_account (id),
  draft_recipient_user_id uuid not null references user_account (id),
  auto_dispatch work_auto_dispatch not null default 'off',
  allowed_action_classes jsonb not null,
  allowed_source_types jsonb not null,
  allowed_agent_ids jsonb not null default '[]'::jsonb,
  allowed_tool_names jsonb not null default '[]'::jsonb,
  max_runs_per_work integer not null,
  max_cost_micros bigint not null,
  max_tokens bigint not null,
  max_attempts integer not null,
  wait_deadline_seconds integer not null,
  expires_at timestamptz not null,
  status_reason varchar(500),
  paused_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_mandate_version check (version >= 1),
  constraint work_mandate_work_key_format check (work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint work_mandate_identity check (
    principal_user_id = on_behalf_of_user_id
    and principal_user_id = human_owner_user_id
    and principal_user_id = draft_recipient_user_id
  ),
  constraint work_mandate_limits check (
    max_runs_per_work >= 0
    and max_cost_micros >= 0
    and max_tokens >= 0
    and max_attempts >= 0
    and wait_deadline_seconds between 1 and 86400
  ),
  constraint work_mandate_action_classes check (
    jsonb_typeof(allowed_action_classes) = 'array'
    and jsonb_array_length(case when jsonb_typeof(allowed_action_classes) = 'array' then allowed_action_classes else '[]'::jsonb end) between 1 and 4
    and allowed_action_classes <@ '["research","analysis","draft","revise"]'::jsonb
  ),
  constraint work_mandate_source_types check (
    jsonb_typeof(allowed_source_types) = 'array'
    and jsonb_array_length(case when jsonb_typeof(allowed_source_types) = 'array' then allowed_source_types else '[]'::jsonb end) between 1 and 2
    and allowed_source_types <@ '["task_message","context_entry"]'::jsonb
  ),
  constraint work_mandate_agent_ids check (
    jsonb_typeof(allowed_agent_ids) = 'array'
    and jsonb_array_length(case when jsonb_typeof(allowed_agent_ids) = 'array' then allowed_agent_ids else '[]'::jsonb end) <= 32
  ),
  -- 固定草稿工具面之外的名称由应用拒绝；这里只约束形状与规模，禁止面不落可变字段。
  constraint work_mandate_tool_names check (
    jsonb_typeof(allowed_tool_names) = 'array'
    and jsonb_array_length(case when jsonb_typeof(allowed_tool_names) = 'array' then allowed_tool_names else '[]'::jsonb end) <= 16
  ),
  constraint work_mandate_status_fields check (
    (status = 'paused' and paused_at is not null and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null and paused_at is null)
    or (status in ('draft', 'active', 'expired', 'superseded') and paused_at is null and revoked_at is null)
  ),
  constraint work_mandate_expires_at check (expires_at > created_at),
  constraint work_mandate_work_version_unique unique (work_id, version)
);

create index work_mandate_work_version_idx on work_mandate (work_id, version desc);
create index work_mandate_work_status_idx on work_mandate (work_id, status, version desc);
create index work_mandate_expiry_idx on work_mandate (status, expires_at);

create type router_decision_kind as enum ('ignore', 'wait', 'ask', 'propose');
create type work_source_type as enum ('task_message', 'context_entry');

create table router_decision (
  id uuid primary key,
  work_id uuid not null references work (id),
  task_id uuid not null references task (id),
  project_id uuid not null references project (id),
  decision router_decision_kind not null,
  reason varchar(64) not null,
  summary varchar(500) not null,
  source_type work_source_type not null,
  source_id uuid not null,
  source_version varchar(200) not null,
  source_digest char(64) not null,
  input_digest char(64) not null,
  mandate_id uuid references work_mandate (id),
  mandate_version integer,
  rules_version varchar(64) not null,
  -- 不透明引用只供读面/后续切片定位来源，不复制正文。
  refs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint router_decision_reason_length check (length(btrim(reason)) between 1 and 64),
  constraint router_decision_summary_length check (length(btrim(summary)) between 1 and 500),
  constraint router_decision_source_version_length check (
    length(btrim(source_version)) between 1 and 200
  ),
  constraint router_decision_digest_format check (
    source_digest ~ '^[0-9a-f]{64}$' and input_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint router_decision_refs_object check (jsonb_typeof(refs) = 'object'),
  constraint router_decision_refs_size check (octet_length(refs::text) <= 4096),
  constraint router_decision_mandate_pair check (
    (mandate_id is null) = (mandate_version is null)
  ),
  constraint router_decision_mandate_version check (
    mandate_version is null or mandate_version >= 1
  )
);

-- 同一工作内同一来源同一版本只裁决一次；重复检查返回已有决定。
create unique index router_decision_source_unique
  on router_decision (work_id, source_type, source_id, source_version);
create index router_decision_work_created_idx
  on router_decision (work_id, created_at desc, id);
create index router_decision_work_decision_idx
  on router_decision (work_id, decision, created_at desc);

create type dispatch_intent_status as enum (
  'proposed',
  'approved',
  'dispatched',
  'rejected',
  'expired',
  'cancelled',
  'superseded'
);
create type dispatch_approval_basis as enum ('human', 'mandate');

create table dispatch_intent (
  id uuid primary key,
  work_id uuid not null references work (id),
  task_id uuid not null references task (id),
  project_id uuid not null references project (id),
  decision_id uuid references router_decision (id),
  mandate_id uuid not null references work_mandate (id),
  mandate_version integer not null,
  status dispatch_intent_status not null,
  approval_basis dispatch_approval_basis,
  authorized_by_user_id uuid not null references user_account (id),
  on_behalf_of_user_id uuid not null references user_account (id),
  input_digest char(64) not null,
  trigger_refs jsonb not null,
  candidates jsonb not null default '[]'::jsonb,
  exclusion_reasons jsonb not null default '[]'::jsonb,
  reason varchar(500) not null,
  run_id uuid references run (id),
  expires_at timestamptz not null,
  approved_at timestamptz,
  dispatched_at timestamptz,
  cancelled_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispatch_intent_mandate_version check (mandate_version >= 1),
  constraint dispatch_intent_input_digest_format check (input_digest ~ '^[0-9a-f]{64}$'),
  constraint dispatch_intent_trigger_refs_array check (
    jsonb_typeof(trigger_refs) = 'array'
    and jsonb_array_length(case when jsonb_typeof(trigger_refs) = 'array' then trigger_refs else '[]'::jsonb end) between 1 and 16
  ),
  constraint dispatch_intent_candidates_array check (jsonb_typeof(candidates) = 'array'),
  constraint dispatch_intent_exclusions_array check (jsonb_typeof(exclusion_reasons) = 'array'),
  constraint dispatch_intent_reason_length check (length(btrim(reason)) between 1 and 500),
  constraint dispatch_intent_status_fields check (
    (status = 'proposed' and approval_basis is null and approved_at is null and dispatched_at is null and run_id is null)
    or (status = 'approved' and approval_basis is not null and approved_at is not null and dispatched_at is null and run_id is null)
    or (status = 'dispatched' and approval_basis is not null and approved_at is not null and dispatched_at is not null and run_id is not null)
    or (status in ('rejected', 'expired', 'cancelled', 'superseded') and dispatched_at is null and run_id is null)
  )
);

create index dispatch_intent_work_created_idx
  on dispatch_intent (work_id, created_at desc, id);
create index dispatch_intent_work_status_idx
  on dispatch_intent (work_id, status, created_at desc);
create index dispatch_intent_status_expiry_idx
  on dispatch_intent (status, expires_at);

-- work.mandate_id 只能在 Mandate 建好后再指回，避免循环外键导致首次插入失败。
alter table work
  add constraint work_mandate_ref
  foreign key (mandate_id) references work_mandate (id);
