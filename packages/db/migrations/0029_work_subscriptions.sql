-- ADR-0028（RD-02b）：显式工作订阅与入口准入（快/慢路径）账本。
--
-- 订阅只表达「内部来源属于当前持续职责」，不授予执行权；创建时绑定 Mandate 版本
-- 与来源授权代次。快路径 deliver 不调用 Router；route_router 必须留下 Router 决定 id。

create type work_subscription_target_type as enum ('task', 'business_ref');
create type work_subscription_status as enum ('active', 'revoked', 'stale');
create type work_entry_admission_outcome as enum ('deliver', 'route_router', 'drop', 'wait');
create type work_entry_admission_trigger as enum ('source', 'return');

create table work_subscription (
  id uuid primary key,
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  project_id uuid not null references project (id),
  task_id uuid not null references task (id),
  target_type work_subscription_target_type not null,
  target_ref varchar(200) not null,
  status work_subscription_status not null default 'active',
  authorization_generation varchar(128) not null,
  mandate_id uuid not null references work_mandate (id),
  mandate_version integer not null,
  created_by_user_id uuid not null references user_account (id),
  ended_by_user_id uuid references user_account (id),
  status_reason varchar(500),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_subscription_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint work_subscription_target_ref_length check (length(btrim(target_ref)) between 1 and 200),
  constraint work_subscription_mandate_version check (mandate_version >= 1),
  constraint work_subscription_status_fields check (
    (status = 'active' and ended_at is null and ended_by_user_id is null and status_reason is null)
    or (status in ('revoked', 'stale') and ended_at is not null and status_reason is not null)
  )
);
create unique index work_subscription_active_unique
  on work_subscription (work_id, target_type, target_ref)
  where status = 'active';
create index work_subscription_work_status_created_idx
  on work_subscription (work_id, status, created_at desc, id);
create index work_subscription_mandate_idx on work_subscription (mandate_id);
create index work_subscription_task_idx on work_subscription (task_id);

alter table work_inbox_item
  add column subscription_id uuid references work_subscription (id),
  add column business_ref varchar(300),
  add column source_kind varchar(64),
  add column auto_admitted boolean not null default false,
  add column retraction_scope varchar(16);
-- task_id 是 work.task_id 的不可变冗余。入口准入在 Work 锁内插入收件箱/准入行；
-- 若 task_id 再建 FK，INSERT 会对 task 取 KEY SHARE，与既有 Task→Work 锁序形成
-- 反向边并 40P01。去掉该 FK，由 work_id → work.task_id 保证归属。
do $$
declare fk_name text;
begin
  select conname into fk_name
  from pg_constraint
  where conrelid = 'work_inbox_item'::regclass
    and contype = 'f'
    and pg_get_constraintdef(oid) like 'FOREIGN KEY (task_id)%';
  if fk_name is not null then
    execute format('alter table work_inbox_item drop constraint %I', fk_name);
  end if;
end $$;
-- 升级 RD-02a 既有条目：refs 已保存 entryKind/messageKind 与 businessRef；回填合并身份，
-- 否则旧显式条目的新版本无法被 supersede。
update work_inbox_item
set source_kind = nullif(btrim(coalesce(refs->>'entryKind', refs->>'messageKind')), ''),
    business_ref = nullif(btrim(refs->>'businessRef'), '')
where source_kind is null;
-- RD-02a 的既有 retracted 行都是来源级撤权；先回填再上约束。
update work_inbox_item set retraction_scope = 'source' where status = 'retracted';
alter table work_inbox_item
  add constraint work_inbox_item_business_ref_length check (
    business_ref is null or length(btrim(business_ref)) between 1 and 300
  ),
  add constraint work_inbox_item_source_kind_length check (
    source_kind is null or length(btrim(source_kind)) between 1 and 64
  ),
  add constraint work_inbox_item_retraction_scope_fields check (
    (status = 'retracted' and retraction_scope in ('source', 'subscription', 'lifecycle'))
    or (status <> 'retracted' and retraction_scope is null)
  );
create index work_inbox_item_subscription_idx
  on work_inbox_item (subscription_id, status)
  where subscription_id is not null;
create index work_inbox_item_business_ref_idx
  on work_inbox_item (work_id, business_ref, source_kind, status)
  where business_ref is not null;
create index work_inbox_item_auto_admitted_idx
  on work_inbox_item (work_id, status)
  where auto_admitted = true;

create table work_entry_router_call (
  id uuid primary key,
  project_id uuid not null references project (id),
  task_id uuid not null,
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  reason varchar(500) not null,
  rules_version varchar(64) not null,
  input_digest char(64) not null,
  source_type work_source_type not null,
  source_id uuid not null,
  source_version varchar(200) not null,
  source_digest char(64) not null,
  authorization_generation varchar(128) not null,
  dedupe_key varchar(400) not null,
  created_at timestamptz not null default now(),
  constraint work_entry_router_call_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint work_entry_router_call_reason_length check (length(btrim(reason)) between 1 and 500),
  constraint work_entry_router_call_digests check (
    input_digest ~ '^[0-9a-f]{64}$' and source_digest ~ '^[0-9a-f]{64}$'
  )
);
create unique index work_entry_router_call_dedupe_unique
  on work_entry_router_call (dedupe_key);
create index work_entry_router_call_work_created_idx
  on work_entry_router_call (work_id, created_at desc, id);

create table work_entry_admission (
  id uuid primary key,
  project_id uuid not null references project (id),
  task_id uuid not null,
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  trigger work_entry_admission_trigger not null,
  outcome work_entry_admission_outcome not null,
  reason varchar(500) not null,
  source_type work_source_type not null,
  source_id uuid not null,
  source_version varchar(200) not null,
  source_digest char(64) not null,
  authorization_generation varchar(128) not null,
  subscription_id uuid references work_subscription (id),
  inbox_item_id uuid references work_inbox_item (id),
  router_invoked boolean not null,
  router_call_id uuid references work_entry_router_call (id),
  deadline_at timestamptz,
  dedupe_key varchar(400) not null,
  created_at timestamptz not null default now(),
  constraint work_entry_admission_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint work_entry_admission_source_version_length check (
    length(btrim(source_version)) between 1 and 200
  ),
  constraint work_entry_admission_digest_format check (source_digest ~ '^[0-9a-f]{64}$'),
  constraint work_entry_admission_reason_length check (length(btrim(reason)) between 1 and 500),
  constraint work_entry_admission_outcome_fields check (
    (outcome = 'deliver' and subscription_id is not null and inbox_item_id is not null
      and router_invoked = false and router_call_id is null and deadline_at is null)
    or (outcome = 'route_router' and router_invoked = true and router_call_id is not null
      and deadline_at is null)
    or (outcome = 'wait' and router_invoked = false and router_call_id is null
      and deadline_at is not null)
    or (outcome = 'drop' and router_invoked = false and router_call_id is null
      and deadline_at is null)
  )
);
create unique index work_entry_admission_dedupe_unique
  on work_entry_admission (dedupe_key);
create index work_entry_admission_work_created_idx
  on work_entry_admission (work_id, created_at desc, id);
create index work_entry_admission_task_created_idx
  on work_entry_admission (task_id, created_at desc, id);
create index work_entry_admission_source_idx
  on work_entry_admission (source_type, source_id, created_at desc);
