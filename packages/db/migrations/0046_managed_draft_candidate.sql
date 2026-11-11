-- ADR-0029: private model-response binding and independently verified upload receipts.
-- Earlier diagnostic Runs keep a null binding and cannot acquire a candidate.
alter table managed_draft_execution
  add column model_response_sha256 char(64),
  add column model_response_byte_size integer,
  add constraint managed_draft_execution_run_model_attempt unique (run_id, model_attempt_id),
  add constraint managed_draft_execution_response_binding check (
    (model_response_sha256 is null and model_response_byte_size is null)
    or (model_responded_at is not null and model_response_sha256 is not null
      and model_response_byte_size is not null and model_response_sha256 ~ '^[a-f0-9]{64}$'
      and model_response_byte_size between 1 and 65536)
  );

create function reject_managed_draft_response_rebinding() returns trigger
language plpgsql as $$
begin
  if old.model_responded_at is not null and
      (new.model_response_sha256, new.model_response_byte_size)
        is distinct from (old.model_response_sha256, old.model_response_byte_size) then
    raise exception 'managed draft model response binding is immutable'
      using errcode = 'check_violation', constraint = 'managed_draft_execution_response_immutable';
  end if;
  return new;
end;
$$;

create trigger managed_draft_execution_response_immutable before update on managed_draft_execution
  for each row execute function reject_managed_draft_response_rebinding();

create table managed_draft_candidate (
  run_id uuid primary key references run(id),
  artifact_id uuid not null unique references artifact(id),
  source_policy_id uuid not null references managed_draft_source_policy(id),
  manifest_digest char(64) not null,
  model_attempt_id uuid not null,
  file_write_receipt_id uuid not null unique,
  verified_upload_receipt_id uuid not null unique,
  sha256 char(64) not null,
  byte_size integer not null,
  verified_at timestamptz not null,
  constraint managed_draft_candidate_run_model_attempt_fkey
    foreign key (run_id, model_attempt_id) references managed_draft_execution(run_id, model_attempt_id),
  constraint managed_draft_candidate_fields check (
    file_write_receipt_id <> verified_upload_receipt_id
    and manifest_digest ~ '^[a-f0-9]{64}$'
    and sha256 ~ '^[a-f0-9]{64}$'
    and byte_size between 1 and 65536
  )
);

create function reject_managed_draft_candidate_change() returns trigger
language plpgsql as $$
begin
  raise exception 'managed draft upload receipt is immutable'
    using errcode = 'check_violation', constraint = 'managed_draft_candidate_receipt_immutable';
end;
$$;

create trigger managed_draft_candidate_receipt_immutable
  before update or delete on managed_draft_candidate
  for each row execute function reject_managed_draft_candidate_change();
