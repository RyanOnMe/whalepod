-- Run input identity/content snapshot. NULL deliberately preserves unknown history.
-- Never backfill current Task artifacts or an empty list as historical evidence.
alter table run add column artifact_input_manifest jsonb;
alter table run add constraint run_artifact_input_manifest_object
  check (artifact_input_manifest is null or jsonb_typeof(artifact_input_manifest) = 'object');
