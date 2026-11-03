-- ADR-0028 §7/§10（RD-03b）：人工与自动派工共用次数闸，按 workKey + origin 统计机器 Run。
-- 该查询在每次派工事务内执行；无索引会随历史 Run 增长退化为全表扫描。
create index run_work_key_origin_status_idx
  on run (work_key, status)
  where origin = 'mandate';
