-- Deployment-wide model authority. A previous binding must never become active again.
create table managed_draft_model_policy_floor (
  singleton boolean primary key check (singleton),
  generation bigint not null check (generation between 1 and 9007199254740991),
  binding_digest char(64) not null check (binding_digest ~ '^[a-f0-9]{64}$')
);

create function reject_managed_draft_model_policy_rollback() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.generation < old.generation
      or (new.generation = old.generation and new.binding_digest <> old.binding_digest) then
    raise exception 'managed draft model policy generation cannot roll back'
      using errcode = 'check_violation', constraint = 'managed_draft_model_policy_monotonic';
  end if;
  return new;
end;
$$;

create trigger managed_draft_model_policy_monotonic before update or delete
  on managed_draft_model_policy_floor
  for each row execute function reject_managed_draft_model_policy_rollback();
