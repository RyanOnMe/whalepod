-- ADR-0028（RD-02a-2b）：工作输入回执通道与消费唯一性。
-- 回执独立于 run.context_receipt：Run 终态后仍接受（窗口内 consumed，窗口后只做
-- 迟到对账）。receiptSeq 由 Node 持久状态单调递增，Hub 按 (run, manifest) 去重。

create table run_work_input_receipt (
  id uuid primary key,
  run_id uuid not null references run (id),
  work_id uuid not null references work (id),
  work_key varchar(64) not null,
  manifest_digest char(64) not null,
  receipt_seq integer not null,
  entries_delivered jsonb not null default '[]'::jsonb,
  entries_read jsonb not null default '[]'::jsonb,
  read_events jsonb not null default '[]'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  digest_verified boolean not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint run_work_input_receipt_seq_positive check (receipt_seq > 0),
  constraint run_work_input_receipt_digest_format check (manifest_digest ~ '^[a-f0-9]{64}$'),
  constraint run_work_input_receipt_arrays check (
    jsonb_typeof(entries_delivered) = 'array'
    and jsonb_typeof(entries_read) = 'array'
    and jsonb_typeof(read_events) = 'array'
    and jsonb_typeof(missing) = 'array'
  ),
  constraint run_work_input_receipt_seq_unique unique (run_id, manifest_digest, receipt_seq)
);
create index run_work_input_receipt_run_seq_idx
  on run_work_input_receipt (run_id, receipt_seq desc);

alter table work_input_consumption
  add constraint work_input_consumption_receipt_fk
  foreign key (receipt_id) references run_work_input_receipt (id);

create unique index work_input_consumption_run_item_unique
  on work_input_consumption (run_id, inbox_item_id);
