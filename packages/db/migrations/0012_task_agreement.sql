-- 任务约定（#378；ADR-0017 §1/§2）：Task 级版本化要求（目标/约束/验收条件/待确认问题）
-- 与 Run 的绑定/用途。草稿可编辑（draft_version 并发令牌）；确认后不可变，版本号每 Task 单调递增。
-- NULL 绑定/历史不回填：agreement_enabled 默认 false 保普通任务现有路径。
alter table task add column agreement_enabled boolean not null default false;

create type task_spec_revision_status as enum ('draft', 'confirmed');
create type task_spec_revision_origin as enum ('manual', 'agent');

create table task_spec_revision (
  id uuid primary key,
  task_id uuid not null references task(id),
  -- 确认时分配（每 Task 单调递增）；草稿恒 null。
  revision_number integer,
  status task_spec_revision_status not null,
  -- { goal, constraints, acceptance, openQuestions }，四段各自长度在协议层收敛。
  content jsonb not null,
  -- 草稿编辑的并发令牌：每次落盘 +1；不匹配的编辑被拒（不覆盖他人版本）。
  draft_version integer not null default 1,
  origin task_spec_revision_origin not null default 'manual',
  created_by uuid not null references user_account(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_by uuid references user_account(id),
  confirmed_at timestamptz,
  constraint task_spec_revision_content_object check (jsonb_typeof(content) = 'object'),
  constraint task_spec_revision_content_size check (octet_length(content::text) <= 131072),
  constraint task_spec_revision_draft_version_positive check (draft_version >= 1),
  constraint task_spec_revision_number_positive check (revision_number is null or revision_number >= 1),
  constraint task_spec_revision_confirmed_fields check (
    (status = 'confirmed' and revision_number is not null and confirmed_by is not null and confirmed_at is not null)
    or (status = 'draft' and revision_number is null and confirmed_by is null and confirmed_at is null)
  )
);

-- 已确认版本每 Task 编号唯一（并发确认的兜底，编号分配在同一事务内做 max+1）。
create unique index task_spec_revision_number_unique on task_spec_revision (task_id, revision_number)
  where revision_number is not null;
-- 每 Task 至多一个开放草稿（编辑既有草稿或先确认/丢弃）。
create unique index task_spec_revision_one_draft on task_spec_revision (task_id)
  where status = 'draft';

-- Run 绑定（可空 = 未绑定，历史不回填）与用途（辅助 Run 显式标记，免绑定要求）。
create type run_purpose as enum ('business', 'agreement_draft', 'handoff_draft');
alter table run add column spec_revision_id uuid references task_spec_revision(id);
alter table run add column purpose run_purpose not null default 'business';
