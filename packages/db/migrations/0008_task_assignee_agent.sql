-- ========== migration 0008：Agent 可被指派（#239；ADR-0009 决策 6） ==========
-- task.assignee_agent_id：指派给 Agent（可空）。关键决定：**assignee_user_id 保持
-- NOT NULL 恒真人**——member 指派时 = 受派人（语义不变）；Agent 指派时 = 做出指派的人
-- （= 责任人：设备归属解析、runs.owner_user_id 固化、指令权第一分支、0006 grant
-- 触发器读的都是它，语义连续、零口径漂移）。「责任在人」红线由列直接表达：Task
-- 永远有一名真人责任人，Agent 只是执行者。
--
-- 约束口径：
--   * 不加「两列互斥/恰好其一」check——assignee_user_id 恒非空，assignee_agent_id
--     非空即 Agent 指派（member 指派恒空），“两列同时非空”由命令层不产生、由
--     协议 superRefine 在入口拒绝（http.ts 二选一 fail-closed），DB 层无需重复表达；
--   * 无唯一性需求：一个 Task 至多一个 Agent assignee（单列即结构保证）；
--   * Agent 归档（archived_at）不在此拦截——归档发生在指派之后的时序无法用 FK/
--     check 表达，由指令/建 Run 路径的既有守卫（orchestrator 拒绝 archived agent）
--     兜底，UI 引导 reassign。

alter table task
  add column assignee_agent_id uuid references agent (id);
