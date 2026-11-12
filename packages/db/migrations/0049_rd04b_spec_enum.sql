-- ADR-0030 RD-04b（Issue #534）：先单独提交枚举值，避免同一迁移事务
-- 使用刚新增的 enum value（PostgreSQL 限制）。表结构在 0050。

alter type task_spec_revision_status add value if not exists 'derived';
alter type task_spec_revision_origin add value if not exists 'preauthorized_template';
