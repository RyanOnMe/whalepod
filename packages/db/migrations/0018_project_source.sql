-- 项目来源绑定（ADR-0024；PC-02a #455）。
-- 一条绑定 = 一个明确的外部资源身份（群/线程/文档/表格范围）；共享范围固定整个 Team。
-- 凭据只在采集 Node；本表只存凭据槽位名与不透明 appKey。正文与 SourceRevision 由
-- PC-03 按 ADR-0025 增加，本 migration 不建正文表。

create type source_platform as enum ('feishu');
create type source_kind as enum ('group', 'thread', 'doc', 'sheet_range');
create type source_status as enum ('active', 'paused', 'unavailable', 'revoked');
create type source_permission_state as enum ('verified', 'unknown', 'denied');

create table project_source (
  id uuid primary key,
  project_id uuid not null references project(id),
  platform source_platform not null,
  kind source_kind not null,
  -- 平台侧不透明资源身份；不写日志、不进视图。
  resource_key text not null,
  -- 成员填写的团队可见标签；不存平台原名。
  display_label varchar(120) not null,
  collector_node_id uuid not null references device(id),
  credential_slot varchar(80) not null,
  -- Node 只读检查返回的不透明应用身份哈希；用于采集租约分桶。
  app_key varchar(200) not null,
  share_scope varchar(16) not null default 'team',
  auto_extraction boolean not null default false,
  status source_status not null default 'active',
  permission_state source_permission_state not null default 'verified',
  permission_checked_at timestamptz not null,
  permission_expires_at timestamptz,
  -- verified 过期转 unknown 的时刻；连续 7 天 unknown 由 reconciler 转 unavailable。
  permission_unknown_since timestamptz,
  -- 授权代次：恢复、重新验证、更换采集者各 +1；旧代次提交一律拒绝。
  authorization_generation integer not null default 1,
  last_success_at timestamptz,
  -- PC-03 的 source_revision 表建立后再补 FK；当前只存不透明 id。
  latest_revision_id uuid,
  bound_by uuid not null references user_account(id),
  bound_at timestamptz not null default now(),
  paused_at timestamptz,
  unavailable_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references user_account(id),
  revoke_reason varchar(500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_source_share_scope check (share_scope = 'team'),
  constraint project_source_label_length check (length(btrim(display_label)) between 1 and 120),
  constraint project_source_resource_length check (length(btrim(resource_key)) between 1 and 500),
  constraint project_source_credential_slot_length check (
    length(btrim(credential_slot)) between 1 and 80
  ),
  constraint project_source_app_key_length check (length(btrim(app_key)) between 1 and 200),
  constraint project_source_generation check (authorization_generation >= 1),
  constraint project_source_revoked_fields check (
    (
      status = 'revoked'
      and revoked_at is not null
      and revoked_by is not null
      and revoke_reason is not null
    )
    or (
      status <> 'revoked'
      and revoked_at is null
      and revoked_by is null
      and revoke_reason is null
    )
  ),
  constraint project_source_permission_fields check (
    (
      permission_state = 'verified'
      and permission_checked_at is not null
      and permission_expires_at is not null
      and permission_unknown_since is null
    )
    or (
      permission_state = 'unknown'
      and permission_checked_at is not null
      and permission_unknown_since is not null
    )
    or (permission_state = 'denied' and permission_checked_at is not null)
  ),
  constraint project_source_status_fields check (
    (status = 'paused' and paused_at is not null)
    or (status <> 'paused' and paused_at is null)
  ),
  constraint project_source_unavailable_fields check (
    (status = 'unavailable' and unavailable_at is not null)
    or (status <> 'unavailable' and unavailable_at is null)
  )
);

-- 同一外部资源同一时刻最多一个活动绑定；撤销后重新绑定是新行、新代次。
create unique index project_source_active_resource
  on project_source (platform, resource_key)
  where status <> 'revoked';

create index project_source_by_project on project_source (project_id, created_at);
create index project_source_app_key on project_source (platform, app_key);
create index project_source_permission_due
  on project_source (permission_expires_at)
  where status = 'active' and permission_state = 'verified';
create index project_source_unknown_since
  on project_source (permission_unknown_since)
  where status = 'active' and permission_state = 'unknown';

-- 同一应用事件流同时只有一个有效采集者（ADR-0024 §4）；换 Node 走显式重新绑定。
create table source_collection_lease (
  platform source_platform not null,
  app_key varchar(200) not null,
  device_id uuid not null references device(id),
  generation integer not null,
  lease_token uuid not null,
  expires_at timestamptz not null,
  acquired_at timestamptz not null default now(),
  renewed_at timestamptz not null default now(),
  primary key (platform, app_key),
  constraint source_lease_generation check (generation >= 1),
  constraint source_lease_app_key_length check (length(btrim(app_key)) between 1 and 200)
);

-- 审计只追加；payload 只允许非敏感字段（不含正文、平台名称、成员姓名）。
create table source_audit_event (
  id bigserial primary key,
  source_id uuid not null references project_source(id),
  action varchar(40) not null,
  actor_member_id uuid references user_account(id),
  authorization_generation integer not null,
  reason varchar(500),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint source_audit_action check (
    action in ('bound', 'paused', 'resumed', 'revoked', 'unavailable', 'permission_changed', 'lease_changed')
  ),
  constraint source_audit_generation check (authorization_generation >= 1),
  constraint source_audit_reason_length check (reason is null or length(btrim(reason)) between 1 and 500),
  constraint source_audit_payload_size check (octet_length(payload::text) <= 4096)
);

create index source_audit_by_source on source_audit_event (source_id, id);
