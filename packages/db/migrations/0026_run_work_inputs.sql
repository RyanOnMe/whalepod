-- ADR-0028（RD-02a-2a，Issue #492）：先单独提交枚举值，避免同一迁移事务
-- 使用刚新增的 enum value（PostgreSQL 限制）。表结构在 0027。

alter type work_inbox_item_status add value if not exists 'delivered';
alter type work_inbox_item_status add value if not exists 'unconfirmed';
alter type work_inbox_item_status add value if not exists 'consumed';
