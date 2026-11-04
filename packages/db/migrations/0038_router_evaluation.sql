-- ADR-0026 §13 / ADR-0028 §17: Router evaluations are not business Runs.
alter table coordination_evaluation
  add column purpose varchar(16) not null default 'inference',
  add column work_id uuid references work(id),
  add column work_key varchar(64),
  add column task_id uuid references task(id),
  add column principal_user_id uuid references user_account(id),
  add column mandate_id uuid references work_mandate(id),
  add column mandate_version integer,
  add column evaluation_digest char(64),
  add column device_id uuid references device(id),
  add column config_version integer,
  add column router_context jsonb,
  add column config_snapshot jsonb,
  add column read_entry_ids jsonb not null default '[]'::jsonb,
  add column model_started_at timestamptz,
  add column pre_model_failure_confirmed boolean not null default false,
  add column lease_token varchar(256),
  add column lease_expires_at timestamptz,
  add column deadline_at timestamptz,
  add column input_tokens_estimate integer,
  add column reserved_tokens bigint,
  add column reserved_cost_micros bigint,
  add column router_proposal jsonb,
  add column usage jsonb;
alter table coordination_evaluation drop constraint coordination_evaluation_completed_fields;
alter table coordination_evaluation
  add constraint coordination_evaluation_purpose check (purpose in ('inference','router')),
  add constraint coordination_evaluation_router_binding check (purpose <> 'router' or (work_id is not null and work_key is not null and task_id is not null and principal_user_id is not null and mandate_id is not null and mandate_version is not null and mandate_version > 0 and evaluation_digest is not null and evaluation_digest ~ '^[a-f0-9]{64}$' and router_context is not null and config_snapshot is not null)),
  add constraint coordination_evaluation_completed_fields check (status <> 'completed' or (result_digest is not null and ((purpose='inference' and inference_entry_id is not null and router_proposal is null) or (purpose='router' and inference_entry_id is null and router_proposal is not null))));
drop index coordination_evaluation_input_attempt_unique;
drop index coordination_evaluation_one_queued;
drop index coordination_evaluation_one_completed_per_input;
create unique index coordination_evaluation_input_attempt_unique on coordination_evaluation(project_id,purpose,coalesce(evaluation_digest,input_digest),attempt);
create unique index coordination_evaluation_one_queued on coordination_evaluation(project_id,purpose,coalesce(work_key,'')) where status='queued';
create unique index coordination_evaluation_one_completed_per_input on coordination_evaluation(project_id,purpose,coalesce(evaluation_digest,input_digest)) where status='completed';
create unique index coordination_evaluation_one_running on coordination_evaluation(project_id) where status in ('dispatched','running');

create table router_configuration (
 project_id uuid primary key references project(id), enabled boolean not null, config_version integer not null,
 device_id uuid not null references device(id), operator_user_id uuid not null references user_account(id),
 billing_user_id uuid not null references user_account(id), configured_by_user_id uuid not null references user_account(id),
 credential_slot varchar(80) not null, credential_config_revision varchar(128) not null,
 provider varchar(100) not null, model varchar(200) not null,
 team_daily_call_limit bigint not null, team_daily_token_limit bigint not null, team_daily_cost_micros_limit bigint not null,
 project_daily_call_limit bigint not null, project_daily_token_limit bigint not null, project_daily_cost_micros_limit bigint not null,
 max_input_tokens integer not null, max_output_tokens integer not null, max_cost_micros bigint not null,
 input_price_micros_per_million_tokens bigint not null, output_price_micros_per_million_tokens bigint not null,
 timeout_seconds integer not null, max_retries integer not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint router_configuration_limits check (config_version>0 and max_input_tokens>0 and max_output_tokens>0 and max_cost_micros>0 and timeout_seconds between 1 and 120 and max_retries between 0 and 10)
);
create table coordination_budget (
 scope varchar(16) not null, scope_id uuid not null, utc_date varchar(10) not null,
 calls bigint not null default 0, retry_attempts integer not null default 0,
 input_tokens bigint not null default 0, output_tokens bigint not null default 0, cost_micros bigint not null default 0,
 reserved_tokens bigint not null default 0, reserved_cost_micros bigint not null default 0,
 primary key(scope,scope_id,utc_date),
 constraint coordination_budget_scope check (scope in ('team','project','work')),
 constraint coordination_budget_nonnegative check(calls>=0 and retry_attempts>=0 and input_tokens>=0 and output_tokens>=0 and cost_micros>=0 and reserved_tokens>=0 and reserved_cost_micros>=0)
);
create table coordination_usage_ledger (
 id uuid primary key, evaluation_id uuid not null references coordination_evaluation(id), attempt integer not null,
 phase varchar(16) not null, project_id uuid not null references project(id), team_id uuid not null, work_key uuid not null,
 utc_date varchar(10) not null, reserved_tokens bigint not null, reserved_cost_micros bigint not null, charge_mode varchar(16), usage jsonb,
 retry boolean not null default false, created_at timestamptz not null default now(),
 constraint coordination_usage_ledger_phase check(phase in ('reserved','settled')),
 constraint coordination_usage_ledger_values check(attempt>0 and reserved_tokens>=0 and reserved_cost_micros>=0 and (phase<>'reserved' or usage is null))
);
create unique index coordination_usage_ledger_once on coordination_usage_ledger(evaluation_id,attempt,phase);

alter table work_entry_router_call
  add column evaluation_id uuid references coordination_evaluation(id),
  add column resolved_at timestamptz,
  add column resolution_reason varchar(64);
create index work_entry_router_call_unresolved_idx on work_entry_router_call(created_at,id) where resolved_at is null;

create table coordination_team_policy (
 team_id uuid primary key references team(id), daily_call_limit bigint not null,
 daily_token_limit bigint not null, daily_cost_micros_limit bigint not null, version integer not null default 1,
 updated_by_user_id uuid not null references user_account(id), updated_at timestamptz not null default now(),
 constraint coordination_team_policy_limits check(daily_call_limit>0 and daily_token_limit>0 and daily_cost_micros_limit>0 and version>0)
);
