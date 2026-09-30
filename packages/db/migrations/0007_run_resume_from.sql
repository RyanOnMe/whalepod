-- ========== migration 0007：resume 续跑血缘（#237；ADR-0009 切片⑤） ==========
-- ADR-0009 决策 8：runs 加 resume_from_run_id，与 rerun_of_run_id **并存**——
-- rerun 是不带上下文重来（G7-04 显式重跑），resume 是接着上次会话聊（persisted
-- load，同 session id 同日志原地追加）。两个动作、两列血缘，展示与语义都不混用。
--
-- 约束口径（Hub 命令层守卫的 DB 侧对应面）：
--   * 自引用 FK：血缘只指向 runs 自己；
--   * 不加唯一/部分索引：同一来源可以被多次续跑（每次续跑都是新的终态 Run，
--     可以再续），唯一性由「来源必须终态」守卫保证，不需要索引表达；
--   * 与 rerun_of_run_id 的互斥（同一行两列同时非空是畸形）由 Hub 命令层
--     校验（协议 superRefine 已 fail-closed 拒绝同请求双带），不在 DB 层
--     重复表达——表达不了「两列至少一列空」这种跨列约束的友好错误。

alter table run
  add column resume_from_run_id uuid references run (id);
