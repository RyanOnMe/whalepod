-- ADR-0030 RD-04c1（Issue #540）：发现执行授权与精确来源包。
--
-- 边界：
--   * 只记录责任人本人的第二次明确确认：父许可必须已到 execute 档；逐件来源固定
--     版本/摘要/授权代次，并绑定 Executor 路由身份（服务商/模型/端点/账户）。
--   * 本迁移不创建 Mandate、派工意图或 Run；执行切片（RD-04c2）只认这一行。
--   * 来源清单只存身份与摘要，不存正文；正文仍留在原 TaskMessage/Artifact/回执。

create table discovery_execution (
  id uuid primary key,
  project_id uuid not null references project (id),
  application_id uuid not null unique references discovery_application (id),
  task_id uuid not null references task (id),
  work_id uuid not null references work (id),
  principal_user_id uuid not null references user_account (id),
  parent_permit_id uuid not null references discovery_permit (id),
  parent_permit_version integer not null,
  purpose varchar(32) not null,
  executor_provider varchar(128) not null,
  executor_model varchar(128) not null,
  executor_endpoint varchar(128) not null,
  executor_account varchar(128) not null,
  executor_policy_generation integer not null,
  executor_digest char(64) not null,
  source_manifest_digest char(64) not null,
  expires_at timestamptz not null,
  authorized_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason varchar(64),
  created_at timestamptz not null,
  constraint discovery_execution_purpose check (purpose = 'private_draft'),
  constraint discovery_execution_digests check (
    executor_digest ~ '^[a-f0-9]{64}$' and source_manifest_digest ~ '^[a-f0-9]{64}$'
  ),
  constraint discovery_execution_executor check (
    length(executor_provider) between 1 and 128
    and length(executor_model) between 1 and 128
    and length(executor_endpoint) between 1 and 128
    and length(executor_account) between 1 and 128
  ),
  constraint discovery_execution_permit_version check (parent_permit_version > 0),
  constraint discovery_execution_executor_generation check (executor_policy_generation > 0),
  constraint discovery_execution_expiry check (expires_at > authorized_at),
  constraint discovery_execution_revocation check (
    (revoked_at is null and revoked_reason is null)
    or (revoked_at is not null and revoked_reason is not null)
  )
);
create index discovery_execution_active_project
  on discovery_execution (project_id)
  where revoked_at is null;
create index discovery_execution_active_principal
  on discovery_execution (principal_user_id)
  where revoked_at is null;

-- 每件来源单独允许：同一执行授权里同类来源只能出现一次。
create table discovery_execution_source (
  id uuid primary key,
  execution_id uuid not null references discovery_execution (id) on delete cascade,
  kind varchar(16) not null,
  source_id uuid not null,
  source_version varchar(128) not null,
  source_digest char(64) not null,
  authorization_generation varchar(200) not null,
  created_at timestamptz not null,
  constraint discovery_execution_source_kind check (kind in ('task_message', 'artifact', 'receipt')),
  constraint discovery_execution_source_digest check (source_digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_execution_source_generation check (length(authorization_generation) between 1 and 200),
  constraint discovery_execution_source_identity unique (execution_id, kind, source_id)
);
