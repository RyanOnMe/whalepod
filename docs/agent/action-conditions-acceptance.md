# 操作条件与处理人验收（#319）

## 用户路径与规则

任务房先展示当前责任人、执行现场与审批归属。没有指令权的成员保留讨论，可直接将焦点送到讨论标题；协作者不获得私有设备/Workspace 清单、凭据、审批权或候选访问权。

提交验收条件由 Hub 聚合真实 Task、Run 和 published Artifact 事实；活跃/无产物的前置规则与提交命令共用 reviewPrerequisiteReason。前端解析条件 schema，字段缺失或自相矛盾必须阻止提交；实际命令仍在 Task 锁内重新鉴权/判定。条件变化时关闭已失效确认框，不用旧确认绕过。

## 六原语

- 驱动：Web 真 router/QueryClient，HTTP fixtures 仅边界替身；Hub 真实PG与HTTP；Q5 生产 Hub/Node/Runtime replay 的双成员、首次执行、审批、续跑路径。
- 观测：hub.task 的 reviewEligibility.allowed/reason、web.execution 的责任人及讨论焦点、web.task 的按钮/受阻理由。
- 判定：无权/未接受/阶段不符分别拒绝；执行进行中和未发布产物不能提交；明确满足条件仍开放真人提交；无条件不能冒充就绪。协作者不请求 /devices 或 /workspaces。
- 归因：错条件先查 hub.task 的真实任务与 active/published 事实；错身份查目录请求；浏览器行为查 web.task 条件 schema 和 realtime 失效。
- 取证：artifacts/evidence/action-conditions/ 脱敏 Q0/Q2/Q5 与摘要；不保存秘密或本机路径。
- 发现：此文登记于 agent 索引，相关定位挂入 evidence-map。

## 复跑

```bash
pnpm check
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/task.integration.spec.ts
pnpm --filter @whalepod/hub... build
pnpm --filter @whalepod/runtime... build
pnpm exec playwright test --config playwright.operations.config.ts --project p1-315
bash scripts/secret-scan.sh artifacts/evidence/action-conditions
```

先红提交 53944cd。精确最终提交与门禁结果登记在证据目录；本批不新增验收角色或改变 Task 状态机。实际用户是否理解分工仍待真人试用。
