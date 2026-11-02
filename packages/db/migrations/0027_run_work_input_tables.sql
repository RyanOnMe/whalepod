-- ADR-0028（RD-02a-2a，Issue #492）：Run 工作输入清单、交付尝试与消费对账表结构。
-- 枚举值已在 0026 单独提交，本迁移可以安全使用 delivered/unconfirmed/consumed。

alter table run
  add column work_key varchar(64),
  add column work_input_manifest jsonb,
  add column work_input_manifest_digest char(64),
  add constraint run_work_input_manifest_fields check (
    (work_key is null and work_input_manifest is null and work_input_manifest_digest is null)
    or (
      work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and work_input_manifest is not null
      and jsonb_typeof(work_input_manifest) = 'object'
      and work_input_manifest_digest ~ '^[0-9a-f]{64}$'
    )
  );

alter table work_inbox_item
  add column delivery_run_id uuid references run (id),
  add column delivered_at timestamptz,
  add column unconfirmed_at timestamptz,
  add column consumed_at timestamptz,
  add constraint work_inbox_item_delivery_fields check (
    (
      status in ('delivered', 'unconfirmed', 'consumed')
      and delivery_run_id is not null
      and delivered_at is not null
    )
    or (
      status in ('pending', 'returned', 'superseded', 'retracted', 'expired')
      and delivery_run_id is null
      and delivered_at is null
      and unconfirmed_at is null
      and consumed_at is null
    )
  ),
  add constraint work_inbox_item_unconfirmed_fields check (
    (status = 'unconfirmed' and unconfirmed_at is not null)
    or (status <> 'unconfirmed' and unconfirmed_at is null)
  ),
  add constraint work_inbox_item_consumed_fields check (
    (status = 'consumed' and consumed_at is not null)
    or (status <> 'consumed' and consumed_at is null)
  );

create index work_inbox_item_delivery_run_idx
  on work_inbox_item (delivery_run_id, status)
  where delivery_run_id is not null;

create type work_inbox_delivery_status as enum (
  'sent',
  'unconfirmed',
  'returned',
  'consumed',
  'duplicate',
  'duplicate_consumption',
  'withdrawn'
);

create table work_inbox_delivery (
  id uuid primary key,
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  task_id uuid not null references task (id),
  project_id uuid not null references project (id),
  inbox_item_id uuid not null references work_inbox_item (id),
  run_id uuid not null references run (id),
  manifest_digest char(64) not null,
  attempt integer not null,
  status work_inbox_delivery_status not null default 'sent',
  sent_at timestamptz not null,
  acked_at timestamptz,
  failed_at timestamptz,
  settled_at timestamptz,
  failure_reason varchar(200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_inbox_delivery_attempt_positive check (attempt > 0),
  constraint work_inbox_delivery_manifest_digest check (manifest_digest ~ '^[a-f0-9]{64}$'),
  constraint work_inbox_delivery_attempt_unique unique (inbox_item_id, run_id, attempt)
);
create index work_inbox_delivery_run_status_idx
  on work_inbox_delivery (run_id, status);

create type work_input_consumption_kind as enum (
  'consumed',
  'duplicate',
  'duplicate_consumption'
);

create table work_input_consumption (
  id uuid primary key,
  inbox_item_id uuid not null references work_inbox_item (id),
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  run_id uuid not null references run (id),
  manifest_digest char(64) not null,
  kind work_input_consumption_kind not null,
  receipt_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint work_input_consumption_manifest_digest check (manifest_digest ~ '^[a-f0-9]{64}$')
);
create index work_input_consumption_run_idx on work_input_consumption (run_id, kind);
