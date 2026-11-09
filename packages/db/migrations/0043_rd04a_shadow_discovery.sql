alter table coordination_evaluation add column discovery_downloaded_ids jsonb not null default '[]'::jsonb;
alter table coordination_evaluation add column discovery_source_id uuid references task_message(id);
alter table coordination_evaluation drop constraint coordination_evaluation_purpose;
alter table coordination_evaluation add constraint coordination_evaluation_purpose
  check (purpose in ('inference', 'router', 'discovery'));
alter table coordination_evaluation drop constraint coordination_evaluation_completed_fields;
alter table coordination_evaluation add constraint coordination_evaluation_completed_fields
  check (status <> 'completed' or (result_digest is not null and
    ((purpose = 'inference' and inference_entry_id is not null and router_proposal is null)
    or (purpose = 'router' and inference_entry_id is null and router_proposal is not null)
    or (purpose = 'discovery' and inference_entry_id is null and router_proposal is null))));
alter table coordination_evaluation add constraint coordination_evaluation_discovery_binding
  check ((purpose <> 'discovery' and discovery_source_id is null) or (purpose = 'discovery'
    and discovery_source_id is not null and work_id is null and work_key is null and task_id is null
    and mandate_id is null and mandate_version is null and principal_user_id is not null
    and device_id is not null and evaluation_digest is not null and config_version is not null and config_version > 0
    and config_snapshot is not null and router_context is null
    and router_proposal is null and inference_entry_id is null));
alter table coordination_usage_ledger alter column work_key drop not null;
alter table coordination_budget drop constraint coordination_budget_scope;
alter table coordination_budget add constraint coordination_budget_scope
  check (scope in ('team', 'project', 'work', 'discovery'));

create table discovery_configuration (
  project_id uuid primary key references project(id),
  version integer not null check (version > 0),
  model_config_version integer not null check (model_config_version > 0),
  settings jsonb not null,
  configured_by uuid not null references user_account(id),
  updated_at timestamptz not null
);
create table discovery_consent (
  project_id uuid not null references project(id),
  user_id uuid not null references user_account(id),
  kind varchar(16) not null,
  config_version integer not null,
  version integer not null,
  active boolean not null,
  updated_at timestamptz not null,
  primary key (project_id, user_id, kind),
  constraint discovery_consent_binding check (kind in ('permit','participation') and config_version > 0 and version > 0)
);
create table discovery_admission (
  source_id uuid primary key references task_message(id),
  project_id uuid not null references project(id),
  entry_task_id uuid not null references task(id),
  source_version varchar(64) not null,
  source_digest varchar(64) not null,
  route varchar(16) not null,
  reason varchar(64) not null,
  entry_generation varchar(64),
  config_version integer,
  permit_version integer,
  author_version integer,
  evaluation_id uuid references coordination_evaluation(id),
  processed_at timestamptz,
  processing_reason varchar(64),
  withdrawn_at timestamptz,
  created_at timestamptz not null,
  constraint discovery_admission_route check (route in ('existing_work','closed','rejected','discovery')),
  constraint discovery_admission_binding check (route <> 'discovery' or
    (entry_generation is not null and config_version is not null and config_version > 0
      and permit_version is not null and permit_version > 0 and author_version is not null and author_version > 0))
);
create index discovery_admission_pending on discovery_admission(project_id, created_at, source_id) where route = 'discovery' and processed_at is null;
create table discovery_candidate (
  id uuid primary key,
  evaluation_id uuid not null unique references coordination_evaluation(id),
  project_id uuid not null references project(id),
  source_id uuid not null references discovery_admission(source_id),
  source_version varchar(64) not null,
  principal_user_id uuid not null references user_account(id),
  proposal jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  checked_at timestamptz not null
);
create index discovery_candidate_principal on discovery_candidate(project_id, principal_user_id, created_at);
create index discovery_candidate_cleanup on discovery_candidate(checked_at);
