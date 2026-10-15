# 个人行动投影验收

- 工作包：P1-06/P1-07/P1-15；Issue #331；Q0/Q2（HTTP、Device WS、Fake Adapter、真实PostgreSQL）。
- 验证：2026-10-15；提交前完整门结果见artifacts/evidence/operation-flow-batch4/input-projection。

## 路径与驱动

成员登录GET /tasks/attention，随后走既有接受/拒绝/改派、Run创建与生产设备事件、产出上传/发布、审批决定、提交验收/完成。用例personal-attention.integration.spec.ts不直写运行投影；设备由配对与inventory上报，状态由Outbox/FakeGateway与生产ingest产生。

## 判定与边界

只回本人可处理身份，候选按实际owner且不含候选标题/数量，指令授权不给审批权。管理员不继承别人的候选或审批。终态、已处理、已过期排除；交接不转移候选。禁用会话401。一次SQL同时过滤与排序，再截前12项；hasMore只针对本人。序为审批、接受、改派、候选、真人完成，同类按时间/身份稳定排序。无全团队总数、工具参数、秘密、路径或原始会话；响应private,no-store。严格协议拒绝未知/多余字段、重复、上限和动作身份错配。

聚合不授予权限，不改变命令状态机。候选允许在运行中检查；终态Task不进个人列表。环境故障仍走任务准备检查，不从失败运行猜测。还未进行真实小团队试用。

## 观测、归因与取证

hub.task层：HTTP状态/data.items(kind,taskId,objectId,runId)/hasMore与原命令回执。node/runtime层：既有Outbox、run_event与Device事实。过滤错看SQL与Session身份；输入错误看protocol；导航与实时消费由后续#332验收。失败必须有响应/断言，不以截图判定。

脱敏日志入artifacts/evidence/operation-flow-batch4/input-projection，扫描后保留。复跑：pnpm build；pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/personal-attention.integration.spec.ts；pnpm check。
