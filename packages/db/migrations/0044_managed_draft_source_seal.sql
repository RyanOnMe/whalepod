-- ADR-0029: a managed source is sealed from Run birth. Legacy Runs stay ordinary.
alter table run add column managed_draft_source_digest char(64);

alter table run add constraint run_managed_draft_source_fields check (
  managed_draft_source_digest is null or (
    managed_draft_source_digest ~ '^[0-9a-f]{64}$'
    and origin = 'mandate'
    and approval_policy = 'approval_required'
    and resume_context = 'blocked'
    and resume_from_run_id is null
    and rerun_of_run_id is null
    and handoff_input is null
    and review_input is null
    and artifact_input_manifest = '[]'::jsonb
    and artifact_input_manifest is not null
    and work_input_manifest is null
    and trigger_message_id is null
  )
);

create function reject_run_managed_draft_source_change() returns trigger
language plpgsql as $$
begin
  if new.managed_draft_source_digest is distinct from old.managed_draft_source_digest then
    raise exception 'managed draft source digest is immutable'
      using errcode = 'check_violation', constraint = 'run_managed_draft_source_immutable';
  end if;
  return new;
end;
$$;

create trigger run_managed_draft_source_immutable
  before update of managed_draft_source_digest on run
  for each row execute function reject_run_managed_draft_source_change();

-- First source class: a manually authored and confirmed WhalePod agreement.
-- Record only explicit authority and byte identity; the original immutable version owns the body.
create table managed_draft_source_policy (
  id uuid primary key,
  project_id uuid not null references project(id),
  task_id uuid not null references task(id),
  revision_id uuid not null references task_spec_revision(id),
  owner_user_id uuid not null references user_account(id),
  recipient_user_id uuid not null references user_account(id),
  sha256 char(64) not null,
  byte_size integer not null,
  model_binding_digest char(64) not null,
  permits_published_audience boolean not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  revoked_at timestamptz,
  idempotency_key varchar(128) not null,
  request_digest char(64) not null,
  constraint managed_draft_source_policy_idempotency unique (owner_user_id, idempotency_key),
  constraint managed_draft_source_policy_fields check (
    owner_user_id <> recipient_user_id
    and byte_size between 1 and 65536
    and sha256 ~ '^[a-f0-9]{64}$'
    and model_binding_digest ~ '^[a-f0-9]{64}$'
    and request_digest ~ '^[a-f0-9]{64}$'
    and expires_at > created_at
    and (revoked_at is null or revoked_at >= created_at)
  )
);

create index managed_draft_source_policy_active_task_idx on managed_draft_source_policy(task_id)
  where revoked_at is null;
create index managed_draft_source_policy_active_owner_idx on managed_draft_source_policy(owner_user_id)
  where revoked_at is null;
create index managed_draft_source_policy_active_recipient_idx on managed_draft_source_policy(recipient_user_id)
  where revoked_at is null;

create function restrict_managed_draft_source_policy_change() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'revoked_at') is distinct from (to_jsonb(old) - 'revoked_at')
      or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'managed draft source policy is immutable after registration'
      using errcode = 'check_violation', constraint = 'managed_draft_source_policy_immutable';
  end if;
  return new;
end;
$$;

create trigger managed_draft_source_policy_immutable
  before update on managed_draft_source_policy
  for each row execute function restrict_managed_draft_source_policy_change();
