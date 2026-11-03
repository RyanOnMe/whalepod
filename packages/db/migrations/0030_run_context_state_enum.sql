-- ADR-0027 §6（PC-05b，Issue #498）：先单独提交枚举值，避免同一迁移事务
-- 使用刚新增的 enum value（PostgreSQL 限制）。表结构在 0031。

alter type run_project_context_entry_status add value if not exists 'permission_unknown';
alter type run_project_context_entry_status add value if not exists 'permission_denied';
alter type run_project_context_entry_status add value if not exists 'unavailable';
