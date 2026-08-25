-- P1-04 第一阶段 schema（03-领域模型与运行协议.md §2 为准）。
-- 手写迁移；演进时以 drizzle-kit generate 产 diff 后人工核对约束。

-- ========== 枚举 ==========
create type member_role as enum ('owner', 'admin', 'member');
create type invite_role as enum ('admin', 'member');
create type task_status as enum ('open', 'in_progress', 'in_review', 'done', 'cancelled');
create type assignment_status as enum ('pending', 'accepted', 'rejected');
create type device_platform as enum ('darwin', 'linux', 'win32');
create type workspace_kind as enum ('directory', 'git_repository');
create type plugin_trust as enum ('builtin', 'curated', 'unreviewed');
create type plugin_capability_class as enum ('declared', 'legacy_unrestricted');
create type plugin_status as enum ('installed', 'disabled', 'failed');
create type run_status as enum (
  'queued', 'dispatching', 'running', 'waiting_approval', 'cancel_requested',
  'completed', 'failed', 'cancelled', 'lost'
);
create type run_event_audience as enum ('owner', 'project', 'admin');
create type approval_status as enum ('pending', 'allowed_once', 'rejected', 'expired', 'cancelled');
create type artifact_status as enum ('candidate', 'published', 'rejected');

-- ========== §2.1 Team 与身份 ==========
create table team (
  id uuid primary key,
  name varchar(80) not null,
  -- 单 Team 部署：singleton_key 恒为 1，唯一约束挡住第二个 Team。
  singleton_key smallint not null default 1,
  created_at timestamptz not null default now(),
  constraint team_singleton unique (singleton_key),
  constraint team_singleton_key_value check (singleton_key = 1),
  constraint team_name_length check (length(btrim(name)) between 1 and 80)
);

create table user_account (
  id uuid primary key,
  username varchar(32) not null unique,
  display_name varchar(80) not null,
  password_hash text not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_account_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  constraint user_account_display_name_length check (length(btrim(display_name)) between 1 and 80)
);

create table team_member (
  team_id uuid not null references team (id),
  user_id uuid not null references user_account (id),
  role member_role not null,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id),
  -- 每个用户一条成员记录。
  constraint team_member_user_unique unique (user_id)
);
-- 不变量「始终至少一个未停用 Owner」由事务策略保护（repositories/team.ts），
-- 非行级约束可表达。

create table auth_session (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table invite (
  id uuid primary key,
  token_hash bytea not null unique,
  role invite_role not null, -- 不能邀请 Owner
  created_by uuid not null references user_account (id),
  expires_at timestamptz not null,
  consumed_by uuid references user_account (id),
  consumed_at timestamptz
);

-- ========== §2.2 Project 与 Task ==========
create table project (
  id uuid primary key,
  name varchar(120) not null unique, -- Team 内唯一；单 Team 部署即全局唯一
  description text not null default '',
  created_by uuid not null references user_account (id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_name_length check (length(btrim(name)) between 1 and 120),
  constraint project_description_length check (length(description) <= 4000)
);

create table task (
  id uuid primary key,
  project_id uuid not null references project (id),
  title varchar(200) not null,
  description text not null default '',
  status task_status not null default 'open',
  assignee_user_id uuid not null references user_account (id), -- 始终有真人 assignee
  assignment_status assignment_status not null default 'pending',
  created_by uuid not null references user_account (id),
  accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_title_length check (length(btrim(title)) between 1 and 200),
  constraint task_description_length check (length(description) <= 20000)
);

create table task_comment (
  id uuid primary key,
  task_id uuid not null references task (id),
  author_user_id uuid not null references user_account (id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  constraint task_comment_body_length check (length(btrim(body)) between 1 and 10000)
);

-- ========== §2.5 Plugin ==========
create table plugin_installation (
  id uuid primary key,
  package_name varchar(214) not null,
  package_version varchar(64) not null, -- 精确版本，不允许 range/tag
  integrity text not null,
  dependency_lock_digest char(64) not null,
  trust plugin_trust not null,
  capability_class plugin_capability_class not null,
  capabilities jsonb not null,
  status plugin_status not null default 'installed',
  installed_by uuid not null references user_account (id),
  created_at timestamptz not null default now()
);

create table plugin_pack (
  id uuid primary key,
  name varchar(80) not null unique,
  installations jsonb not null, -- 按 package name 排序的 installation id 数组
  pack_digest char(64) not null,
  created_by uuid not null references user_account (id),
  created_at timestamptz not null default now()
);

-- ========== §2.3 Agent 与 Profile ==========
create table agent (
  id uuid primary key,
  name varchar(80) not null unique,
  description varchar(500) not null default '',
  current_revision_id uuid, -- FK 在 agent_profile_revision 建表后补上
  created_by uuid not null references user_account (id),
  archived_at timestamptz
);

create table agent_profile_revision (
  id uuid primary key,
  agent_id uuid not null references agent (id),
  revision integer not null,
  persona text not null,
  provider varchar(100) not null,
  model varchar(200) not null,
  credential_slot varchar(80) not null, -- Node 上的 secret 别名，不是凭据
  max_tokens integer,
  plugin_pack_id uuid not null references plugin_pack (id),
  profile_digest char(64) not null,
  created_by uuid not null references user_account (id),
  created_at timestamptz not null default now(),
  constraint agent_profile_revision_unique unique (agent_id, revision),
  constraint agent_profile_revision_positive check (revision >= 1),
  constraint agent_profile_revision_persona_length check (length(persona) between 1 and 20000),
  constraint agent_profile_revision_max_tokens_positive check (max_tokens is null or max_tokens > 0)
);

alter table agent
  add constraint agent_current_revision_fk
  foreign key (current_revision_id) references agent_profile_revision (id);

-- ========== §2.4 Device 与 Workspace ==========
create table device (
  id uuid primary key,
  owner_user_id uuid not null references user_account (id), -- 永不转移
  name varchar(80) not null,
  platform device_platform not null,
  architecture varchar(32) not null,
  node_version varchar(32) not null,
  node_app_version varchar(32) not null,
  token_hash bytea not null unique, -- Device WS 凭 token hash 定位唯一 Device（§6）
  capabilities jsonb not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint device_owner_name_unique unique (owner_user_id, name)
);

create table device_pairing_code (
  id uuid primary key,
  owner_user_id uuid not null references user_account (id),
  code_hash bytea not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

-- 注意：Node 本地 workspace_registry（canonical_path 等）不落 Hub 库（§2.4）。
create table workspace (
  id uuid primary key, -- 由 Node 生成
  device_id uuid not null references device (id),
  owner_user_id uuid not null references user_account (id),
  name varchar(80) not null,
  kind workspace_kind not null,
  capabilities jsonb not null,
  available boolean not null default false,
  last_checked_at timestamptz not null default now(),
  constraint workspace_owner_name_unique unique (owner_user_id, name)
);

-- ========== §2.6 Run、Approval 与 Artifact ==========
create table run (
  id uuid primary key,
  task_id uuid not null references task (id),
  owner_user_id uuid not null references user_account (id), -- 创建时等于 Task assignee，固化
  agent_id uuid not null references agent (id),
  profile_revision_id uuid not null references agent_profile_revision (id),
  device_id uuid not null references device (id),
  workspace_id uuid not null references workspace (id),
  dsh_session_id varchar(128),
  status run_status not null default 'queued',
  failure_code varchar(64),
  failure_summary varchar(1000),
  rerun_of_run_id uuid references run (id),
  profile_digest char(64) not null,
  plugin_pack_digest char(64) not null,
  dsh_distribution_version varchar(64) not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- 每 Task 单活跃 Run；终态不占位，允许显式重跑。
create unique index run_one_active_per_task on run (task_id)
  where status in ('queued', 'dispatching', 'running', 'waiting_approval', 'cancel_requested');

create table run_event (
  id uuid primary key,
  run_id uuid not null references run (id),
  seq bigint not null,
  type varchar(80) not null,
  audience run_event_audience not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint run_event_run_seq_unique unique (run_id, seq),
  -- 持久事件单条 payload 上限 32 KiB（02 Global Constraints）
  constraint run_event_payload_size check (octet_length(payload::text) <= 32768)
);

create table approval (
  id uuid primary key,
  run_id uuid not null references run (id),
  call_id varchar(128) not null,
  tool_name varchar(200) not null,
  reason varchar(1000) not null,
  preview jsonb not null,
  status approval_status not null default 'pending',
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_by uuid references user_account (id),
  decided_at timestamptz,
  constraint approval_run_call_unique unique (run_id, call_id)
);

create table artifact (
  id uuid primary key,
  task_id uuid not null references task (id),
  run_id uuid not null references run (id),
  owner_user_id uuid not null references user_account (id),
  title varchar(200) not null,
  media_type varchar(200) not null,
  byte_size bigint not null,
  sha256 char(64) not null,
  storage_key text not null, -- sha256/ab/cd/<digest>；不暴露本地源路径
  source_relative_path text,
  status artifact_status not null default 'candidate',
  created_at timestamptz not null default now(),
  published_at timestamptz,
  constraint artifact_title_length check (length(btrim(title)) between 1 and 200),
  -- 单文件上限 50 MiB = 52,428,800 字节（02 Global Constraints）
  constraint artifact_byte_size_range check (byte_size between 0 and 52428800)
);

-- ========== 事件与 Outbox ==========
-- 持久 Team Event（§5：Browser WS cursor 补发，id 即 cursor）。
create table team_event (
  id bigserial primary key,
  type varchar(80) not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  constraint team_event_payload_size check (octet_length(payload::text) <= 32768)
);

-- Hub → Node 命令的至少一次投递队列；claim/ack/fail 语义见 src/outbox.ts。
create table dispatch_outbox (
  id uuid primary key, -- 即协议 commandId
  device_id uuid not null references device (id),
  type varchar(80) not null,
  payload jsonb not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  acked_at timestamptz,
  failed_at timestamptz
);

create index dispatch_outbox_pending_idx on dispatch_outbox (next_attempt_at)
  where acked_at is null and failed_at is null;

-- transactCommand 幂等回执：同 key 重放返回首次结果，副作用不重复执行。
create table command_receipt (
  key text primary key,
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- ========== updated_at 由数据库写入（§2.2） ==========
create or replace function set_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger project_set_updated_at
  before update on project
  for each row execute function set_updated_at();

create trigger task_set_updated_at
  before update on task
  for each row execute function set_updated_at();
