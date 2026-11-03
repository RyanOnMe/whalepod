-- ADR-0027 §6（PC-05b-1，Issue #498）修订：状态帧覆盖快照内全部条目。
--
-- Decision 不来自来源，不得携带 source_id/授权代次；否则来源撤销可能把它误标成
-- source_tombstoned/permission_*。结构约束放在数据库侧，写路径无法绕过。

alter table run_project_context_entry
  drop constraint run_project_context_entry_decision_fields,
  add constraint run_project_context_entry_decision_fields check (
    kind <> 'decision'
    or (
      business_ref is not null
      and source_id is null
      and authorization_generation is null
      and revision_id is null
    )
  );
