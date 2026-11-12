ALTER TABLE discovery_permit ADD COLUMN executor_limits jsonb;
ALTER TABLE discovery_permit ADD CONSTRAINT discovery_permit_executor_limits
  CHECK (executor_limits IS NULL OR (tier = 'execute' AND jsonb_typeof(executor_limits) = 'object'));

CREATE TABLE discovery_executor_source_grant (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES discovery_application(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,
  source_id uuid NOT NULL,
  source_version varchar(128) NOT NULL,
  source_digest char(64) NOT NULL,
  authorization_generation varchar(200) NOT NULL,
  granter_user_id uuid NOT NULL REFERENCES user_account(id),
  executor_digest char(64) NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT discovery_executor_source_grant_identity UNIQUE (application_id, executor_digest, kind, source_id),
  CONSTRAINT discovery_executor_source_grant_kind CHECK (kind IN ('task_message', 'artifact', 'receipt')),
  CONSTRAINT discovery_executor_source_grant_digests CHECK (source_digest ~ '^[a-f0-9]{64}$' AND executor_digest ~ '^[a-f0-9]{64}$')
);
