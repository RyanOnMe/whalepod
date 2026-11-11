-- ADR-0030 RD-04b（Issue #534）补丁：目录水位变化后重排准入时记录重排时间。
--
-- 单独成文件而不是改 0050：已应用 0050 的开发/预发库不会重跑该文件。
-- `if not exists` 兼容曾在 8ebb04d 版本 0050 里见过该列的库；新库与 c527435 级库
-- 都会正常补列。

-- 重评不改变原始准入时间；队列 TTL 从 requeued_at 重新起算。
alter table discovery_admission add column if not exists requeued_at timestamptz;
