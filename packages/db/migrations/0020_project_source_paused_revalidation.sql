-- #457：暂停来源也需要至少每 24 小时重验权限（ADR-0024 §5；PC-03 正文读面前置）。
-- 部分索引从仅 active 扩到 active + paused；未知超期清扫同样覆盖暂停来源。
drop index if exists project_source_permission_due;
create index project_source_permission_due
  on project_source (permission_expires_at)
  where status in ('active', 'paused') and permission_state = 'verified';

drop index if exists project_source_unknown_since;
create index project_source_unknown_since
  on project_source (permission_unknown_since)
  where status in ('active', 'paused') and permission_state = 'unknown';
