-- 交接接收与下游 Run 的固定交接输入（#380；ADR-0017 §5）。
-- receipt：已发布交接版本 × 同项目下游 Task 的接收关系。确认 = 接收方填写
-- 「本次准备做什么」（understanding 必填）；确认不等于接受 Task、不启动 Run。
-- 上游出新版本后接收方 adopt 产生**新 receipt**；旧 receipt 永远保留原版本
-- （(downstream_task_id, revision_id) 唯一：重复确认/采用不重复创建）。
create type handoff_receipt_status as enum ('pending', 'confirmed');

create table handoff_receipt (
  id uuid primary key,
  revision_id uuid not null references handoff_revision(id),
  upstream_task_id uuid not null references task(id),
  downstream_task_id uuid not null references task(id),
  receiver_user_id uuid not null references user_account(id),
  delivered_by uuid not null references user_account(id),
  status handoff_receipt_status not null default 'pending',
  understanding varchar(10000),
  differences varchar(10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint handoff_receipt_distinct_tasks check (upstream_task_id <> downstream_task_id),
  -- confirmed 必须带确认时刻与理解；pending 不得带（字段组合即状态语义）。
  constraint handoff_receipt_fields check (
    (status = 'pending' and understanding is null and confirmed_at is null)
    or (status = 'confirmed' and understanding is not null and confirmed_at is not null)
  ),
  constraint handoff_receipt_unique_per_version unique (downstream_task_id, revision_id)
);

create index handoff_receipt_upstream on handoff_receipt (upstream_task_id);
create index handoff_receipt_downstream on handoff_receipt (downstream_task_id);

-- 下游 Run 创建时点固化的跨 Task 交接输入（与 artifact_input_manifest 互不合并）。
-- NULL = 本条 Run 不带交接输入（新列：旧 Run 一律 NULL 且语义就是「无」，不回填）。
alter table run add column handoff_input jsonb;
alter table run add constraint run_handoff_input_object
  check (handoff_input is null or jsonb_typeof(handoff_input) = 'object');
