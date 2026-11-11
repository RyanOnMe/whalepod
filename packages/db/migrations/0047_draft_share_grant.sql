-- Human-only grants for one immutable, trusted managed Artifact. No content in grant records.
create table draft_share_grant (
  id uuid primary key,
  project_id uuid not null references project(id),
  task_id uuid not null references task(id),
  work_key varchar(64) not null,
  run_id uuid not null references run(id),
  artifact_id uuid not null references artifact(id),
  source_policy_id uuid not null references managed_draft_source_policy(id),
  mandate_id uuid not null references work_mandate(id),
  mandate_version integer not null check (mandate_version > 0),
  source_manifest_digest char(64) not null check (source_manifest_digest ~ '^[a-f0-9]{64}$'),
  source_policy_digest char(64) not null check (source_policy_digest ~ '^[a-f0-9]{64}$'),
  model_binding_digest char(64) not null check (model_binding_digest ~ '^[a-f0-9]{64}$'),
  verified_upload_receipt_id uuid not null references managed_draft_candidate(verified_upload_receipt_id),
  grantor_user_id uuid not null references user_account(id),
  recipient_user_id uuid not null references user_account(id),
  sha256 char(64) not null check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer not null check (byte_size between 1 and 65536),
  purpose varchar(16) not null default 'human_read' check (purpose = 'human_read'),
  state varchar(16) not null default 'offered',
  expires_at timestamptz not null,
  offered_at timestamptz not null,
  accepted_at timestamptz,
  closed_at timestamptz,
  idempotency_key varchar(128) not null,
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  constraint draft_share_grant_idempotency unique (grantor_user_id, artifact_id, idempotency_key),
  constraint draft_share_grant_fields check (
    grantor_user_id <> recipient_user_id and expires_at > offered_at
    and (accepted_at is null or (accepted_at >= offered_at and accepted_at < expires_at))
    and (closed_at is null or closed_at >= coalesce(accepted_at, offered_at))
    and ((state = 'offered' and accepted_at is null and closed_at is null)
      or (state = 'active' and accepted_at is not null and closed_at is null)
      or (state = 'declined' and accepted_at is null and closed_at is not null)
      or (state in ('revoked', 'expired', 'superseded') and closed_at is not null))
  )
);

create unique index draft_share_grant_open_recipient_idx
  on draft_share_grant(artifact_id, recipient_user_id) where state in ('offered', 'active');
create index draft_share_grant_recipient_idx on draft_share_grant(recipient_user_id, offered_at desc)
  where state in ('offered', 'active');
create index draft_share_grant_source_idx on draft_share_grant(source_policy_id)
  where state in ('offered', 'active');

create function restrict_draft_share_grant_change() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'state' - 'accepted_at' - 'closed_at')
       is distinct from (to_jsonb(old) - 'state' - 'accepted_at' - 'closed_at')
     or not (
       (old.state = 'offered' and new.state = 'active')
       or (old.state = 'offered' and new.state in ('declined', 'revoked', 'expired', 'superseded')
           and new.accepted_at is null)
       or (old.state = 'active' and new.state in ('revoked', 'expired', 'superseded')
           and new.accepted_at = old.accepted_at)
     ) then
    raise exception 'draft grant identity is immutable and terminal grants never revive'
      using errcode = 'check_violation', constraint = 'draft_share_grant_transition';
  end if;
  return new;
end;
$$;

create trigger draft_share_grant_transition before update on draft_share_grant
  for each row execute function restrict_draft_share_grant_change();

-- One Hub admission for one HTTP body, ordered by the same locks as withdrawal.
-- A null grant is an owner inspection before a grant exists.
create table draft_share_read_admission (
  id uuid primary key,
  grant_id uuid references draft_share_grant(id),
  artifact_id uuid not null references artifact(id),
  actor_user_id uuid not null references user_account(id),
  verified_upload_receipt_id uuid not null references managed_draft_candidate(verified_upload_receipt_id),
  sha256 char(64) not null check (sha256 ~ '^[a-f0-9]{64}$'),
  admitted_at timestamptz not null
);
