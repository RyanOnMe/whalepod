-- ADR-0028 §6（RD-03a）：受控派工意图与机器 Run 溯源。
-- 意图在 proposed 阶段只记录工作/来源；派工端口在 dispatch 时固定候选与现场，
-- 因此目标字段可空，只有 dispatched 行必须完整。Run 的机器来源与意图一一对应。

alter table dispatch_intent
  add column work_key varchar(64),
  add column agent_id uuid references agent (id),
  add column profile_revision_id uuid references agent_profile_revision (id),
  add column device_id uuid references device (id),
  add column workspace_id uuid references workspace (id),
  add column action_class varchar(32),
  add column resolution_reason varchar(500);

update dispatch_intent d
set work_key = w.work_key
from work w
where w.id = d.work_id;

alter table dispatch_intent
  alter column work_key set not null,
  add constraint dispatch_intent_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  add constraint dispatch_intent_resolution_reason_length check (
    resolution_reason is null or length(btrim(resolution_reason)) between 1 and 500
  ),
  add constraint dispatch_intent_target_fields check (
    status <> 'dispatched'
    or (
      agent_id is not null
      and profile_revision_id is not null
      and device_id is not null
      and workspace_id is not null
      and action_class in ('research', 'analysis', 'draft', 'revise')
    )
  );

create unique index dispatch_intent_run_unique
  on dispatch_intent (run_id)
  where run_id is not null;

create type run_origin as enum ('human', 'mandate');

alter table run
  add column origin run_origin not null default 'human',
  add column mandate_id uuid references work_mandate (id),
  add column dispatch_intent_id uuid references dispatch_intent (id),
  add column on_behalf_of_user_id uuid references user_account (id);

alter table run
  add constraint run_origin_fields check (
    (origin = 'human' and mandate_id is null and dispatch_intent_id is null and on_behalf_of_user_id is null)
    or (
      origin = 'mandate'
      and mandate_id is not null
      and dispatch_intent_id is not null
      and on_behalf_of_user_id is not null
      and work_key is not null
    )
  );

create unique index run_dispatch_intent_unique
  on run (dispatch_intent_id)
  where dispatch_intent_id is not null;
