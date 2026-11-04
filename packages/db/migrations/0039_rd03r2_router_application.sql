-- ADR-0028 §17（RD-03r2）：已接受 Router 提案的幂等应用、wait 记录与 Executor 用量账本。
alter table agent_profile_revision
  add column input_price_micros_per_million_tokens bigint,
  add column output_price_micros_per_million_tokens bigint;
alter table agent_profile_revision
  add constraint agent_profile_revision_prices_pair check (
    (input_price_micros_per_million_tokens is null) = (output_price_micros_per_million_tokens is null)
  ),
  add constraint agent_profile_revision_prices_positive check (
    (input_price_micros_per_million_tokens is null or input_price_micros_per_million_tokens > 0)
    and (output_price_micros_per_million_tokens is null or output_price_micros_per_million_tokens > 0)
  );

alter table run
  add column executor_usage jsonb,
  add column executor_cost_micros bigint;
alter table run
  add constraint run_executor_usage_object check (
    executor_usage is null or jsonb_typeof(executor_usage) = 'object'
  ),
  add constraint run_executor_cost_nonnegative check (
    executor_cost_micros is null or executor_cost_micros >= 0
  );

create table executor_usage_ledger (
  id uuid primary key,
  run_id uuid not null references run(id),
  phase varchar(16) not null,
  project_id uuid not null references project(id),
  team_id uuid not null,
  work_key uuid not null,
  mandate_id uuid not null references work_mandate(id),
  utc_date varchar(10) not null,
  reserved_tokens bigint not null,
  reserved_cost_micros bigint not null,
  charge_mode varchar(16),
  usage jsonb,
  created_at timestamptz not null default now(),
  constraint executor_usage_ledger_phase check (phase in ('reserved','settled')),
  constraint executor_usage_ledger_values check (
    reserved_tokens >= 0
    and reserved_cost_micros >= 0
    and (phase <> 'reserved' or (usage is null and charge_mode is null))
    and (phase <> 'settled' or charge_mode in ('zero','reserved','actual'))
  )
);
create unique index executor_usage_ledger_once on executor_usage_ledger(run_id, phase);
create index executor_usage_ledger_unsettled_idx on executor_usage_ledger(created_at, id) where phase = 'reserved';

create table router_application (
  evaluation_id uuid primary key references coordination_evaluation(id),
  project_id uuid not null references project(id),
  work_id uuid not null references work(id),
  task_id uuid not null references task(id),
  work_key varchar(64) not null,
  decision varchar(16) not null,
  status varchar(16) not null,
  reason varchar(500),
  evaluation_digest char(64) not null,
  mandate_id uuid not null references work_mandate(id),
  mandate_version integer not null,
  decision_row_id uuid references router_decision(id),
  intent_id uuid references dispatch_intent(id),
  question_id uuid references work_question(id),
  wait_id uuid,
  run_id uuid references run(id),
  refs jsonb not null default '{}'::jsonb,
  applied_at timestamptz not null,
  constraint router_application_decision check (decision in ('dispatch','wait','ask','ignore')),
  constraint router_application_status check (status in ('applied','rejected','stale')),
  constraint router_application_digest check (evaluation_digest ~ '^[a-f0-9]{64}$'),
  constraint router_application_reason_length check (reason is null or length(btrim(reason)) between 1 and 500),
  constraint router_application_work_key_format check (work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint router_application_mandate_version check (mandate_version >= 1),
  constraint router_application_refs_object check (jsonb_typeof(refs) = 'object' and octet_length(refs::text) <= 8192)
);
create unique index router_application_intent_unique on router_application(intent_id) where intent_id is not null;
create unique index router_application_question_unique on router_application(question_id) where question_id is not null;
create unique index router_application_wait_unique on router_application(wait_id) where wait_id is not null;
create index router_application_work_created_idx on router_application(work_id, applied_at desc);

create table work_wait (
  id uuid primary key,
  evaluation_id uuid not null unique references coordination_evaluation(id),
  project_id uuid not null references project(id),
  work_id uuid not null references work(id),
  task_id uuid not null references task(id),
  work_key varchar(64) not null,
  status varchar(16) not null,
  reason varchar(64) not null,
  summary varchar(500) not null,
  resume_condition varchar(500) not null,
  source_type varchar(16) not null,
  source_id uuid not null,
  trigger_key varchar(200) not null,
  generation integer not null default 1,
  deadline_at timestamptz not null,
  mandate_id uuid not null references work_mandate(id),
  mandate_version integer not null,
  principal_user_id uuid not null references user_account(id),
  refs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_wait_status check (status in ('open','resumed','expired','superseded','cancelled')),
  constraint work_wait_reason check (reason ~ '^[a-z][a-z0-9_]*$' and length(reason) <= 64),
  constraint work_wait_summary_length check (length(btrim(summary)) between 1 and 500),
  constraint work_wait_resume_length check (length(btrim(resume_condition)) between 1 and 500),
  constraint work_wait_source_type check (source_type in ('task_message','context_entry')),
  constraint work_wait_trigger_key_length check (length(btrim(trigger_key)) between 1 and 200),
  constraint work_wait_generation check (generation >= 1),
  constraint work_wait_mandate_version check (mandate_version >= 1),
  constraint work_wait_work_key_format check (work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint work_wait_refs_object check (jsonb_typeof(refs) = 'object' and octet_length(refs::text) <= 4096)
);
create unique index work_wait_one_open on work_wait(work_id) where status = 'open';
create index work_wait_deadline_idx on work_wait(status, deadline_at);
