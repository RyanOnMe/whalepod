-- 交接草稿与交接版本（#379；ADR-0017 §3-4）。
-- 草稿：仅源 Run owner 可见/可编辑（draft_version 并发令牌）；每个来源 Run 至多一条
-- 未发布草稿（ready/failed 部分唯一）；失败草稿可被手工草稿替换；published 行留审计。
-- 版本：Task 级单调递增（(task_id, revision_number) 唯一）、发布后不可变。
create type handoff_draft_status as enum ('ready', 'failed', 'published');
create type handoff_draft_origin as enum ('auto', 'manual');

create table handoff_draft (
  id uuid primary key,
  task_id uuid not null references task(id),
  source_run_id uuid not null references run(id),
  spec_revision_id uuid references task_spec_revision(id),
  status handoff_draft_status not null,
  failure_reason varchar(1000),
  -- null 仅当 status='failed'；否则为 {system, narrative}（系统块由 Hub 权威填入）。
  content jsonb,
  draft_version integer not null default 1,
  origin handoff_draft_origin not null,
  created_by uuid not null references user_account(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_revision_id uuid,
  constraint handoff_draft_draft_version_positive check (draft_version >= 1),
  constraint handoff_draft_content_size check (content is null or octet_length(content::text) <= 32768),
  constraint handoff_draft_fields check (
    (status = 'failed' and content is null and failure_reason is not null and published_revision_id is null)
    or (status = 'ready' and content is not null and failure_reason is null and published_revision_id is null)
    or (status = 'published' and content is not null and published_revision_id is not null)
  )
);

-- 每个来源 Run 至多一条未发布草稿；重复上行事件/并发手工创建由它兜底。
create unique index handoff_draft_one_open_per_run on handoff_draft (source_run_id)
  where status in ('ready', 'failed');

create table handoff_revision (
  id uuid primary key,
  task_id uuid not null references task(id),
  revision_number integer not null,
  source_run_id uuid not null references run(id),
  spec_revision_id uuid references task_spec_revision(id),
  content jsonb not null,
  created_from_draft_id uuid references handoff_draft(id),
  published_by uuid not null references user_account(id),
  published_at timestamptz not null default now(),
  constraint handoff_revision_number_positive check (revision_number >= 1),
  constraint handoff_revision_content_size check (octet_length(content::text) <= 32768),
  constraint handoff_revision_number_unique unique (task_id, revision_number)
);

alter table handoff_draft add constraint handoff_draft_published_revision_fk
  foreign key (published_revision_id) references handoff_revision(id);
