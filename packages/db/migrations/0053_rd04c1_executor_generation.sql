-- ADR-0030 RD-04c1（Issue #540）补丁：执行授权固定 Executor 策略代次。
--
-- 0052 已在实施分支提交过一版；已应用该版本的库不会重跑 0052，因此新列必须
-- 以独立迁移补上。`if not exists` 让新库与已含该列的库都能升级。

alter table discovery_execution
  add column if not exists executor_policy_generation integer;

update discovery_execution
set executor_policy_generation = 1
where executor_policy_generation is null;

alter table discovery_execution
  alter column executor_policy_generation set not null;

alter table discovery_execution
  drop constraint if exists discovery_execution_executor_generation;
alter table discovery_execution
  add constraint discovery_execution_executor_generation
  check (executor_policy_generation > 0);
