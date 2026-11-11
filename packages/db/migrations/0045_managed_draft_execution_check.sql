-- ADR-0029: private control receipts. No source, provider response or candidate bytes.
create table managed_draft_execution (
  run_id uuid primary key references run(id),
  command_id uuid not null unique references dispatch_outbox(id),
  connection_id uuid,
  offered_at timestamptz,
  source_request_id uuid,
  source_read_at timestamptz,
  model_attempt_id uuid unique,
  model_request_digest char(64),
  model_request_byte_size integer,
  model_decided_at timestamptz,
  model_responded_at timestamptz,
  constraint managed_draft_execution_offer_fields check (
    (connection_id is null) = (offered_at is null)
    and (source_request_id is null) = (source_read_at is null)
    and (source_read_at is null or (offered_at is not null and source_read_at >= offered_at))
  ),
  constraint managed_draft_execution_model_fields check (
    (model_attempt_id is null and model_request_digest is null and model_request_byte_size is null
      and model_decided_at is null and model_responded_at is null)
    or (model_attempt_id is not null and model_request_digest is not null and model_request_byte_size is not null
      and model_request_digest ~ '^[a-f0-9]{64}$' and model_request_byte_size between 1 and 131072
      and source_read_at is not null and model_decided_at is not null and model_decided_at >= source_read_at
      and (model_responded_at is null or model_responded_at >= model_decided_at))
  )
);

-- A later worker or connection may not reset a consumed receipt or replace its identity.
create function reject_managed_draft_execution_reuse() returns trigger
language plpgsql as $$
begin
  if (new.run_id, new.command_id) is distinct from (old.run_id, old.command_id)
      or (old.offered_at is not null and (new.connection_id, new.offered_at)
          is distinct from (old.connection_id, old.offered_at))
      or (old.source_read_at is not null and (new.source_request_id, new.source_read_at)
          is distinct from (old.source_request_id, old.source_read_at))
      or (old.model_decided_at is not null and (new.model_attempt_id, new.model_request_digest,
          new.model_request_byte_size, new.model_decided_at) is distinct from (old.model_attempt_id,
          old.model_request_digest, old.model_request_byte_size, old.model_decided_at))
      or (old.model_responded_at is not null and new.model_responded_at is distinct from old.model_responded_at) then
    raise exception 'managed draft execution receipt is immutable'
      using errcode = 'check_violation', constraint = 'managed_draft_execution_receipt_immutable';
  end if;
  return new;
end;
$$;

create trigger managed_draft_execution_receipt_immutable before update on managed_draft_execution
  for each row execute function reject_managed_draft_execution_reuse();
