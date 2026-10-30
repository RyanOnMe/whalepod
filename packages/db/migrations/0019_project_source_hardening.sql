-- PC-02a 复核修正（#455）：0018 在开发环境已被应用过，不再改历史 migration。
-- 这里把「权限检查时刻必填 / 应用身份索引 / unavailable 审计动作」前向补齐；
-- 语句幂等，兼容已应用过硬编码版 0018 的数据库。
alter table project_source alter column permission_checked_at set not null;
create index if not exists project_source_app_key on project_source (platform, app_key);
alter table source_audit_event drop constraint if exists source_audit_action;
alter table source_audit_event add constraint source_audit_action check (
  action in (
    'bound',
    'paused',
    'resumed',
    'revoked',
    'unavailable',
    'permission_changed',
    'lease_changed'
  )
);
