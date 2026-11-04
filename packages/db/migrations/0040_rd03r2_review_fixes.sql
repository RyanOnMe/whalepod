-- #520 评审修复：预留 scope 必须可回放，结算不得扣减从未预留的 team/project 行。
alter table executor_usage_ledger
  add column team_reserved boolean not null default false,
  add column project_reserved boolean not null default false;

-- 来源清单上限 31；dispatch_intent 的 16 条上限会把合法提案永久挡在应用之外。
alter table dispatch_intent drop constraint dispatch_intent_trigger_refs_array;
alter table dispatch_intent add constraint dispatch_intent_trigger_refs_array check (
  jsonb_typeof(trigger_refs) = 'array'
  and jsonb_array_length(
    case when jsonb_typeof(trigger_refs) = 'array' then trigger_refs else '[]'::jsonb end
  ) between 1 and 32
);

-- 读面 usage 形状与 wire 协议一致；坏形状在写入时即拒绝，而不是留给结算。
alter table run drop constraint run_executor_usage_object;
alter table run add constraint run_executor_usage_object check (
  executor_usage is null
  or (
    jsonb_typeof(executor_usage) = 'object'
    and jsonb_typeof(executor_usage -> 'inputTokens') = 'number'
    and jsonb_typeof(executor_usage -> 'outputTokens') = 'number'
  )
);

-- work_wait 在 0039 中后建，FK 只能在这里补。
alter table router_application
  add constraint router_application_wait_fk foreign key (wait_id) references work_wait(id);
