-- ADR-0027 §6（PC-05b-3）：来源 Run 的续跑能力。
-- 默认 full；非空 run_project_context 的 Run 在终态收敛时由 Hub 写 blocked
-- （session 在 resume probe 未固定时会被 Node 删除）。redacted 为 probe 固定后的
-- 保留值，本切片不产生。

create type run_resume_context as enum ('full', 'redacted', 'blocked');

alter table run
  add column resume_context run_resume_context not null default 'full';
