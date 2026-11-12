-- ADR-0030: one immutable, private Run for each replay execution authorization.
alter table run
  add column discovery_execution_id uuid references discovery_execution(id),
  add constraint run_discovery_execution_unique unique (discovery_execution_id),
  add constraint run_discovery_execution_seal check (
    discovery_execution_id is null or (
      origin = 'mandate' and approval_policy = 'approval_required'
      and managed_draft_source_digest is null and work_input_manifest is not null
      and spec_revision_id is not null and resume_context = 'blocked'
    )
  );
