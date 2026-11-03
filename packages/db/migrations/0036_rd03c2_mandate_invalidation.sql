-- ADR-0028 §9（RD-03c2）：在途机器 Run 的 Mandate 实时失效标记。
-- 只标记、不改 run.status；是否停止由 human owner 走既有取消路径。
alter table run
  add column mandate_invalidated_at timestamptz,
  add column mandate_invalidated_reason varchar(64);

alter table run
  add constraint run_mandate_invalidation_fields
  check (
    (mandate_invalidated_at is null and mandate_invalidated_reason is null)
    or (mandate_invalidated_at is not null and mandate_invalidated_reason is not null)
  );
