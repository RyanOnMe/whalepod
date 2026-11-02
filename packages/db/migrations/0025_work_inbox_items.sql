-- ADR-0028（RD-02a-1，Issue #489）：工作收件箱条目与显式关联。
--
-- 本切片只落 Hub/PostgreSQL 的 inbox 条目与 pending/returned/superseded/retracted/expired；
-- delivered/unconfirmed/consumed、Run 清单、Node 下载与消费回执由 RD-02a-2（#490）追加。
-- 正文快照只供 Task 当前 assignee 的私有读面；不进入 Router 输入或团队投影。

create type work_inbox_item_status as enum (
  'pending',
  'returned',
  'superseded',
  'retracted',
  'expired'
);
create type work_inbox_return_reason as enum (
  'irrelevant',
  'new_gap',
  'conflict',
  'permission_invalid',
  'incomplete'
);

create table work_inbox_item (
  id uuid primary key,
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  task_id uuid not null references task (id),
  project_id uuid not null references project (id),
  source_type work_source_type not null,
  source_id uuid not null,
  source_version varchar(200) not null,
  source_digest char(64) not null,
  authorization_generation varchar(128) not null,
  title varchar(200) not null,
  body text not null default '',
  body_digest char(64) not null,
  refs jsonb not null default '{}'::jsonb,
  supersedes_id uuid references work_inbox_item (id),
  status work_inbox_item_status not null default 'pending',
  status_reason varchar(500),
  return_reason work_inbox_return_reason,
  return_note varchar(1000),
  status_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_inbox_item_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint work_inbox_item_source_version_length check (
    length(btrim(source_version)) between 1 and 200
  ),
  constraint work_inbox_item_digests check (
    source_digest ~ '^[0-9a-f]{64}$' and body_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint work_inbox_item_title_length check (length(btrim(title)) between 1 and 200),
  constraint work_inbox_item_body_size check (octet_length(body) <= 65536),
  constraint work_inbox_item_refs_object check (jsonb_typeof(refs) = 'object'),
  constraint work_inbox_item_refs_size check (octet_length(refs::text) <= 4096),
  constraint work_inbox_item_return_fields check (
    (status = 'returned' and return_reason is not null)
    or (status <> 'returned' and return_reason is null and return_note is null)
  ),
  constraint work_inbox_item_self_supersede check (supersedes_id is null or supersedes_id <> id)
);

-- 同一工作、来源、版本与摘要只收一条；新版本/新摘要另建并 supersede 旧 pending。
create unique index work_inbox_item_identity_unique
  on work_inbox_item (work_id, source_type, source_id, source_version, source_digest);
-- 同一来源至多一条 pending：应用层 supersede 漏掉时由 DB 直接拒绝。
create unique index work_inbox_item_source_pending_unique
  on work_inbox_item (work_id, source_type, source_id)
  where status = 'pending';
create index work_inbox_item_work_created_idx
  on work_inbox_item (work_id, created_at desc, id);
create index work_inbox_item_work_status_created_idx
  on work_inbox_item (work_id, status, created_at desc, id);
create index work_inbox_item_work_source_idx
  on work_inbox_item (work_id, source_type, source_id, created_at desc);
