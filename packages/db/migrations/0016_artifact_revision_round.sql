-- 交付物修订批次与批注复核（#430；ADR-0021 §5）。
-- 批次创建时冻结原稿、选定批注/回复、参考材料与责任人方向；启动后不随新批注变化。

create type artifact_revision_round_status as enum ('preparing', 'starting', 'started', 'cancelled');
create type artifact_comment_resolution_status as enum ('resolved', 'needs_work');

create table artifact_revision_round (
  id uuid primary key,
  task_id uuid not null references task(id),
  source_artifact_id uuid not null references artifact(id),
  owner_user_id uuid not null references user_account(id),
  status artifact_revision_round_status not null default 'preparing',
  direction varchar(10000),
  -- ReviewInputManifest 的不可变快照（评论/回复/材料/方向；启动后不回写）。
  input jsonb not null,
  run_id uuid unique references run(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  constraint artifact_revision_round_direction_length check (
    direction is null or length(btrim(direction)) between 1 and 10000
  ),
  constraint artifact_revision_round_input_object check (jsonb_typeof(input) = 'object'),
  constraint artifact_revision_round_fields check (
    (status in ('preparing', 'starting') and run_id is null and started_at is null)
    or (status = 'started' and run_id is not null and started_at is not null)
    or (status = 'cancelled')
  )
);

create index artifact_revision_round_by_task
  on artifact_revision_round (task_id, created_at);
create index artifact_revision_round_by_source
  on artifact_revision_round (source_artifact_id, created_at);

-- 本轮选定的顶层批注（回复在 input 快照里；这张表供复核外键与逐条查询）。
create table artifact_revision_round_comment (
  round_id uuid not null references artifact_revision_round(id) on delete cascade,
  comment_id uuid not null references artifact_comment(id),
  primary key (round_id, comment_id)
);

-- 新版关联：责任人显式把本轮候选指到原稿与批次；一件候选只能属于一个批次。
create table artifact_revision_link (
  candidate_artifact_id uuid primary key references artifact(id),
  source_artifact_id uuid not null references artifact(id),
  round_id uuid not null unique references artifact_revision_round(id),
  linked_by uuid not null references user_account(id),
  created_at timestamptz not null default now(),
  constraint artifact_revision_link_not_same_artifact check (
    candidate_artifact_id <> source_artifact_id
  )
);

-- 批注复核：作者确认或责任人写理由代为收口；Agent 无权写这张表。
create table artifact_comment_resolution (
  id uuid primary key,
  round_id uuid not null references artifact_revision_round(id),
  comment_id uuid not null references artifact_comment(id),
  candidate_artifact_id uuid not null references artifact(id),
  status artifact_comment_resolution_status not null,
  resolved_by uuid not null references user_account(id),
  note varchar(10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifact_comment_resolution_note_length check (
    note is null or length(btrim(note)) between 1 and 10000
  ),
  constraint artifact_comment_resolution_unique unique (round_id, comment_id)
);

create index artifact_comment_resolution_by_comment
  on artifact_comment_resolution (comment_id, updated_at);

-- Run 的本轮修订输入快照（与 artifact_input_manifest / handoff_input 互不合并）。
alter table run add column review_input jsonb;
alter table run add constraint run_review_input_object
  check (review_input is null or jsonb_typeof(review_input) = 'object');
